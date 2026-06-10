import { runGpuEffectTest, Frame } from './gpu-test-helpers';

// Per-effect tests for gen.chroma_wave — a charge-and-burst prismatic blob
// that grows from the top-center while gated, then bursts outward on release.
// The grade scrolls across the burst (renderEachTick advances grade_phase and
// the phase machine), so envelope-dependent tests use renderEachTick. With a
// black input the blob's generated colour is just bright pixels, so "where the
// bloom lands vertically" reads the grow → burst-expand envelope.

describe('Chroma Wave Effect E2E', () => {
  jest.setTimeout(60000);

  const W = 128, H = 128;
  const luma = (p: { r: number; g: number; b: number }) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;

  // Fraction of bright pixels in the vertical band [y0, y1).
  const brightBand = (f: Frame, y0: number, y1: number): number => {
    let bright = 0, n = 0;
    for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) {
      for (let x = 0; x < W; x++) { if (luma(f.pixelAt(x, y)) > 30) bright++; n++; }
    }
    return n > 0 ? bright / n : 0;
  };

  // Circular variance of hue over coloured pixels — a proxy for "prismatic"
  // (many distinct hues banded across the blob) rather than a single flat hue.
  // 0 = all one hue; → 1 = hues spread around the wheel. A high grade_freq
  // (burst) spreads many hue cycles across the density ramp; a low one (hold)
  // is nearly monochromatic.
  const hueVariance = (f: Frame): number => {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = f.pixelAt(x, y);
      const mx = Math.max(p.r, p.g, p.b), mn = Math.min(p.r, p.g, p.b);
      const d = mx - mn;
      if (mx <= 30 || d < 12) continue;   // skip dark / near-grey pixels
      let h = 0;
      if (mx === p.r) h = ((p.g - p.b) / d) % 6;
      else if (mx === p.g) h = (p.b - p.r) / d + 2;
      else h = (p.r - p.g) / d + 4;
      h = (h / 6 + 1) % 1;                 // [0,1)
      const a = h * 2 * Math.PI;
      sx += Math.cos(a); sy += Math.sin(a); n++;
    }
    if (n === 0) return 0;
    const r = Math.sqrt(sx * sx + sy * sy) / n;
    return 1 - r;                          // circular variance
  };

  // Circular mean hue [0,1) over coloured pixels.
  const meanHue = (f: Frame): number => {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = f.pixelAt(x, y);
      const mx = Math.max(p.r, p.g, p.b), mn = Math.min(p.r, p.g, p.b);
      const d = mx - mn;
      if (mx <= 30 || d < 12) continue;
      let h = 0;
      if (mx === p.r) h = ((p.g - p.b) / d) % 6;
      else if (mx === p.g) h = (p.b - p.r) / d + 2;
      else h = (p.r - p.g) / d + 4;
      h = (h / 6 + 1) % 1;
      const a = h * 2 * Math.PI;
      sx += Math.cos(a); sy += Math.sin(a); n++;
    }
    if (n === 0) return 0;
    return ((Math.atan2(sy, sx) / (2 * Math.PI)) + 1) % 1;
  };
  // Shortest distance between two hues on the [0,1) wheel.
  const hueDist = (a: number, b: number): number => {
    const d = Math.abs(a - b) % 1;
    return Math.min(d, 1 - d);
  };

  const params = (extra: [string, number][]): [string, number][] => [
    ['auto_rate', 0], ['intensity', 1.5], ['saturation', 0.9],
    ['base_radius', 0.12], ['charge_expand', 2.2], ['position_y', -0.7],
    ['gaussian_sharpness', 4], ['overlay_alpha_hold', 0.5], ['seed', 7],
    // Keep one-shot voices centered/clean so single-voice tests are
    // deterministic; the polyphony test overrides these.
    ['voice_pos_jitter', 0], ['voice_hue_jitter', 0],
    ...extra,
  ];

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      inputColor: [0, 0, 0, 1], dumpName: 'chroma_wave_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('gen.chroma_wave');
  });

  it('idle (no gate / trigger / auto) renders pure passthrough', async () => {
    const frame = await runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 8, params: params([]),
      dumpName: 'chroma_wave_idle',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 4);
  });

  it('charge: held gate blooms near the top, bottom stays dark', async () => {
    // default_gate_state locks the charge; the blob sits at the top band.
    const frame = await runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 30, params: params([['default_gate_state', 1], ['charge_s', 0.3]]),
      dumpName: 'chroma_wave_charge',
    });
    expect(frame.success).toBe(true);
    expect(brightBand(frame, 0.0, 0.35)).toBeGreaterThan(0.02);  // bloom up top
    expect(brightBand(frame, 0.75, 1.0)).toBeLessThan(0.01);     // bottom dark
  });

  it('burst: a trigger sustains at top, then the bloom expands downward', async () => {
    // Trigger holds for min_sustain_s (bloom at top), then bursts — the radius
    // expands rapidly so coverage spreads down the canvas.
    const at = (ticks: number) => runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks,
      params: [...params([['min_sustain_s', 0.1], ['release_s', 0.7],
                          ['release_expand', 4.0], ['charge_s', 0.1]]),
               ['trigger', 1]],
      dumpName: `chroma_wave_burst_${ticks}`,
    });
    const charging = await at(4);    // still held → bundled near the top
    const bursting = await at(26);   // expanded → reaches lower band
    expect(charging.success && bursting.success).toBe(true);
    const chargeLow = brightBand(charging, 0.55, 0.95);
    const burstLow = brightBand(bursting, 0.55, 0.95);
    expect(burstLow).toBeGreaterThan(chargeLow + 0.02);
  });

  it('burst goes prismatic: the bloom is more colourful during the burst', async () => {
    // Hold has few bands (gentle); burst ramps grade_freq high → rainbow.
    const charge = await runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 16, params: params([['default_gate_state', 1], ['charge_s', 0.2],
                                  ['hue_span', 0.25], ['grade_freq_hold', 0.5],
                                  ['band_contrast', 0.2]]),
      dumpName: 'chroma_wave_prismatic_hold',
    });
    const burst = await runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 18,
      params: [...params([['min_sustain_s', 0.05], ['release_s', 1.0],
                          ['hue_span', 0.25], ['grade_freq_burst', 10],
                          ['band_contrast', 0.2], ['charge_s', 0.05]]),
               ['trigger', 1]],
      dumpName: 'chroma_wave_prismatic_burst',
    });
    expect(charge.success && burst.success).toBe(true);
    expect(hueVariance(burst)).toBeGreaterThan(hueVariance(charge) + 0.05);
  });

  it('extended ranges: off-canvas origin + large base_radius floods the canvas', async () => {
    // position_y = -1.6 puts the center above the top edge; a large base_radius
    // (charge onset, slow charge_s so it stays big) reaches well into frame.
    const frame = await runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 3, params: params([['default_gate_state', 1], ['charge_s', 2.0],
                                 ['position_y', -1.6], ['base_radius', 2.0],
                                 ['gaussian_sharpness', 1.5]]),
      dumpName: 'chroma_wave_extended',
    });
    expect(frame.success).toBe(true);
    // Mid-canvas lit despite the center sitting off the top edge.
    expect(brightBand(frame, 0.3, 0.6)).toBeGreaterThan(0.02);
  });

  it('band_tilt skews the grade along the wavefront (shifts the mean hue)', async () => {
    // band_tilt adds band_tilt*qy to the transfer, so equal-and-opposite tilts
    // shift the blob's mean hue in opposite directions — a deterministic,
    // measurable asymmetry along the (vertical) wavefront axis.
    const run = (tilt: number) => runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 14, params: params([['default_gate_state', 1], ['charge_s', 0.15],
                                  ['hue_span', 0.3], ['grade_freq_hold', 3],
                                  ['band_tilt', tilt]]),
      dumpName: `chroma_wave_tilt_${tilt}`,
    });
    const pos = await run(1.5);
    const neg = await run(-1.5);
    expect(pos.success && neg.success).toBe(true);
    expect(hueDist(meanHue(pos), meanHue(neg))).toBeGreaterThan(0.03);
  });

  it('intensity crank brightens the bloom (soft rolloff)', async () => {
    const run = (gain: number) => runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 14, params: params([['default_gate_state', 1], ['charge_s', 0.15],
                                  ['intensity', gain]]),
      dumpName: `chroma_wave_crank_${gain}`,
    });
    const lo = await run(1.0);
    const hi = await run(6.0);
    expect(lo.success && hi.success).toBe(true);
    expect(brightBand(hi, 0.0, 0.5)).toBeGreaterThan(brightBand(lo, 0.0, 0.5) + 0.01);
  });

  it('auto_rate fires one-shots on its own (silent at 0)', async () => {
    // auto_rate > 0 self-animates with no gate wired; each Poisson event is a
    // one-shot that fully charges then bursts. At 0 it stays dark.
    const on = await runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 40, params: params([['auto_rate', 0.6], ['charge_s', 0.15],
                                  ['min_sustain_s', 0.1], ['release_s', 0.5]]),
      dumpName: 'chroma_wave_auto_on',
    });
    expect(on.success).toBe(true);
    expect(brightBand(on, 0.0, 1.0)).toBeGreaterThan(0.005);
  });

  it('a trigger value of 0 never fires (rising-edge, replay-safe)', async () => {
    // The executor replays every stored field — including `trigger` — as a
    // PatchReplace each frame. The handler must fire only on a 0->1 rising
    // edge, not on any patch arrival, or the cycle re-arms forever at idle.
    // Here trigger sits at 0 with auto_rate 0: nothing should ever light up.
    const frame = await runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 12, params: [...params([]), ['trigger', 0]],
      dumpName: 'chroma_wave_trigger0',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 4);
  });

  it('polyphony: a higher voice_limit yields more simultaneous bloom coverage', async () => {
    // With auto_rate cranked, voices spawn faster than they die. voice_limit 8
    // lets up to 8 overlap; limit 1 keeps only one alive at a time → markedly
    // less total bright coverage. Spread them so they don't all stack.
    const run = (limit: number) => runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 45, params: params([['auto_rate', 0.9], ['charge_s', 0.1],
                                  ['min_sustain_s', 0.05], ['release_s', 0.6],
                                  ['voice_limit', limit], ['voice_pos_jitter', 0.7],
                                  ['base_radius', 0.1]]),
      dumpName: `chroma_wave_poly_${limit}`,
    });
    const one = await run(1);
    const eight = await run(8);
    expect(one.success && eight.success).toBe(true);
    expect(brightBand(eight, 0.0, 1.0)).toBeGreaterThan(brightBand(one, 0.0, 1.0) + 0.02);
  });

  it('hue_interact rotates overlapping voices further (more hue spread)', async () => {
    // Two co-located voices (a held one + a one-shot, no position jitter) fully
    // overlap. At hue_interact 0 their band phases average → one blended hue;
    // cranked up they SUM → the combined phase rotates further round the wheel
    // → more distinct hues. (A lone voice is unaffected: avg == sum.)
    const run = (hi: number) => runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 16,
      params: [...params([['default_gate_state', 1], ['charge_s', 0.1],
                          ['grade_freq_hold', 3], ['hue_span', 0.3],
                          ['band_contrast', 0.3], ['hue_interact', hi]]),
               ['trigger', 1]],
      dumpName: `chroma_wave_interact_${hi}`,
    });
    const lo = await run(0.0);
    const high = await run(1.8);
    expect(lo.success && high.success).toBe(true);
    expect(hueVariance(high)).toBeGreaterThan(hueVariance(lo) + 0.03);
  });

  it('intensity 0 renders passthrough even while charging', async () => {
    const frame = await runGpuEffectTest({
      module: 'chroma_wave.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 10, params: params([['default_gate_state', 1], ['intensity', 0]]),
      dumpName: 'chroma_wave_intensity0',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 4);
  });
});
