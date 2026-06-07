import { runGpuEffectTest, Frame } from './gpu-test-helpers';

// Per-effect tests for gen.bounce_resonator — a 4-bar scalar diffusion
// network with NO spatial structure. An internal 240 Hz loop multiplies
// the 4-vector by a seeded mixing matrix (v ← M·v):
//   spread 0 → seeded random derangement (each bar dumps its full energy
//              onto one other bar each step);
//   spread 1 → fully random per-column distribution (energy fans out).
//   feedback → per-second energy gain (1.0 conserves, <1 decays).
// Rendering: each bar draws a centered band whose brightness is its value.
//
// Physics runs in tick() (CPU); the default "tick N then render once" path
// snapshots frame N. A single rising-edge gate kick + auto_rate 0 makes
// the trajectory deterministic. Tests are seed-agnostic — they assert on
// conservation and concentration, not on which specific bar lights.

describe('Bounce Resonator (diffusion) E2E', () => {
  jest.setTimeout(60000);

  const W = 160, H = 108;

  // Mean luminance of bar `k`'s centered band.
  const barBrightness = (f: Frame, k: number): number => {
    const x0 = Math.floor((k + 0.3) * W / 4), x1 = Math.floor((k + 0.7) * W / 4);
    const y0 = Math.floor(H * 0.45), y1 = Math.floor(H * 0.55);
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = f.pixelAt(x, y); s += p.r + p.g + p.b; n++;
      }
    }
    return n > 0 ? s / n : 0;
  };
  const bars = (f: Frame) => [0, 1, 2, 3].map(k => barBrightness(f, k));
  const total = (f: Frame) => bars(f).reduce((a, b) => a + b, 0);
  const concentration = (f: Frame) => {
    const b = bars(f), t = b.reduce((a, c) => a + c, 0);
    return t > 1e-3 ? Math.max(...b) / t : 0;
  };

  // One rising-edge kick into bar 0 (gate 0→1), no auto-fire. Low strength
  // + intensity so brightness stays out of the 255 clamp. cycle_rate fixed
  // at 10 Hz so a given tick count maps to a known number of hops.
  const kickBar0 = (extra: [string, number][]): [string, number][] => [
    ['gate', 1], ['auto_rate', 0.0], ['bar_target', 0], ['bar_target_all', 0],
    ['impulse_strength', 0.6], ['intensity', 1.0],
    ['seed', 0], ['pattern_count', 4], ['cycle_rate', 10.0],
    ...extra,
  ];

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'bounce_resonator.wasm', bundle: 'lights',
      inputColor: [0, 0, 0, 1], dumpName: 'bounce_resonator_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('gen.bounce_resonator');
  });

  it('a kick lights the network', async () => {
    const frame = await runGpuEffectTest({
      module: 'bounce_resonator.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1],
      ticks: 5, params: kickBar0([['feedback', 1.0], ['spread', 0.3]]),
      dumpName: 'bounce_resonator_kick',
    });
    expect(frame.success).toBe(true);
    expect(total(frame)).toBeGreaterThan(30);
  });

  it('fills the whole 1/4 column (not a centered band)', async () => {
    // spread 0, feedback 1.0 → energy parks on one bar; that bar's entire
    // vertical strip should be lit top-to-bottom, equally.
    const frame = await runGpuEffectTest({
      module: 'bounce_resonator.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1],
      ticks: 8, params: kickBar0([['feedback', 1.0], ['spread', 0.0]]),
      dumpName: 'bounce_resonator_fill',
    });
    expect(frame.success).toBe(true);
    // Find the lit bar, then check top, middle, bottom of its column match.
    const lum = (k: number, fy: number) => {
      const x = Math.floor((k + 0.5) * W / 4), y = Math.floor(fy * H);
      const p = frame.pixelAt(x, y); return p.r + p.g + p.b;
    };
    const lit = [0, 1, 2, 3].reduce((m, k) => lum(k, 0.5) > lum(m, 0.5) ? k : m, 0);
    const top = lum(lit, 0.08), mid = lum(lit, 0.5), bot = lum(lit, 0.92);
    expect(mid).toBeGreaterThan(20);
    expect(top).toBeGreaterThan(mid * 0.9);
    expect(bot).toBeGreaterThan(mid * 0.9);
  });

  it('feedback conserves vs decays total energy', async () => {
    const after = (feedback: number) => runGpuEffectTest({
      module: 'bounce_resonator.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1],
      ticks: 40, params: kickBar0([['feedback', feedback], ['spread', 0.5]]),
      dumpName: `bounce_resonator_fb_${Math.round(feedback * 100)}`,
    });
    const hi = await after(1.0);   // reverberates forever → energy retained
    const lo = await after(0.3);   // ~0.3×/sec → much dimmer total by now
    expect(hi.success && lo.success).toBe(true);
    expect(total(hi)).toBeGreaterThan(total(lo) + 40);
  });

  it('spread fans energy out across bars (concentration drops)', async () => {
    const at = (spread: number) => runGpuEffectTest({
      module: 'bounce_resonator.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1],
      ticks: 30, params: kickBar0([['feedback', 1.0], ['spread', spread]]),
      dumpName: `bounce_resonator_spread_${Math.round(spread * 100)}`,
    });
    const narrow = await at(0.0);  // permutation → energy on a single bar
    const wide = await at(1.0);    // random fan-out → spread across bars
    expect(narrow.success && wide.success).toBe(true);
    // Single-bar concentration is ~1.0; fanned-out is ~0.3-0.4.
    expect(concentration(narrow)).toBeGreaterThan(concentration(wide) + 0.3);
  });
});
