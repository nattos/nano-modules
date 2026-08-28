import { runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for `source.mesh.three_planes`' glints.
 *
 * These live on the ENGINE harness rather than the per-effect GPU one for a
 * structural reason: a glint is thrown by a GESTURE — the sweep knob crossing
 * the middle of its throw — and the per-effect harness sets its params once
 * and then ticks, so a knob there is parked forever and nothing is ever
 * launched. (That the parked case renders nothing at all is pinned over in
 * three_planes.test.ts.) Only a real engine can move a param between frames.
 *
 * Engine dt is wall clock, so nothing here asserts a TIME. The invariant —
 * sweep the knob across its range at a constant speed and one glint crosses
 * the picture at exactly that rate — is stated as an equality in
 * native/tests/test_three_planes_glints.cpp, which owns the clock. What only a
 * real engine shows is that a moving param reaches the particle system at all,
 * and that a live glint draws as one slash and travels the right way.
 *
 * Ratio is turned right down throughout so a launched glint crosses over
 * seconds: that makes "is it still up there" independent of how long a
 * waitFrames window actually took.
 */
describe('Three Planes glints E2E', () => {
  jest.setTimeout(120000);

  const W = 240, H = 160;
  const MODULES = ['com.nano.core', 'com.nano.lights'];

  // Cover-square coords -> pixel. Mirrors fx::coverSquare / nano_coords.hlsl.
  const ax = Math.max(W, H) / (2 * W);
  const ay = Math.max(W, H) / (2 * H);
  const toPx = (sx: number, sy: number): [number, number] => [
    Math.round((sx * ax + 0.5) * W),
    Math.round((sy * ay + 0.5) * H),
  ];
  const luma = (p: { r: number; g: number; b: number }) => (p.r + p.g + p.b) / 3;

  // Travel direction at the default 45 deg. Cover-square y grows DOWNWARD, so
  // "up-right" is (+, −).
  const R2 = Math.SQRT1_2;

  /**
   * The frame projected onto the travel axis: the brightest pixel at each
   * distance along it.
   *
   * Projecting the WHOLE frame rather than walking its centre diagonal is not
   * fussiness — a glint is a band square across the travel, and a fresh one
   * sits out past where that diagonal runs out of picture, so a line scan
   * reports a flat field for the first part of every glint's life.
   */
  const AXIS_LO = -1.25, AXIS_HI = 1.25, AXIS_STEP = 0.01;
  const AXIS: number[] = [];
  for (let t = AXIS_LO; t <= AXIS_HI + 1e-6; t += AXIS_STEP) AXIS.push(t);

  const scan = (f: any) => {
    const out = new Array<number>(AXIS.length).fill(-1);
    f.forEachPixel((p: { r: number; g: number; b: number }, x: number, y: number) => {
      // Pixel centre -> cover-square -> distance along the travel axis.
      const sx = ((x + 0.5) / W - 0.5) / ax;
      const sy = ((y + 0.5) / H - 0.5) / ay;
      const t = sx * R2 - sy * R2;
      const i = Math.round((t - AXIS_LO) / AXIS_STEP);
      if (i < 0 || i >= out.length) return;
      const l = luma(p);
      if (l > out[i]) out[i] = l;
    });
    // Trim the ends no pixel reached: the travel axis runs past the corners of
    // the frame, and an empty bucket beside a real one is a cliff every peak
    // test would fall off.
    let lo = 0, hi = out.length - 1;
    while (lo < out.length && out[lo] < 0) lo++;
    while (hi >= 0 && out[hi] < 0) hi--;
    return { v: out.slice(lo, hi + 1), lo };
  };

  /**
   * Local maxima standing clear of the field around them — i.e. glints.
   *
   * Two things have to be true, and the second is not obvious. The standoff
   * has to clear a glint's own core, which is flat-topped (a super-Gaussian)
   * and a good fraction of the axis wide. And a candidate has to beat the
   * field's own BASELINE, not just its neighbours: every glint drags a dark
   * wake, so an untouched stretch of picture sitting between two wakes is a
   * local maximum too, and counting those would find a glint between every
   * pair of real ones.
   */
  const PEAK_SPAN = 16;
  const peaks = (s: { v: number[]; lo: number }, prominence: number) => {
    const v = s.v;
    const sorted = [...v].sort((a, b) => a - b);
    const base = sorted[Math.floor(sorted.length / 2)];
    const out: number[] = [];
    for (let i = PEAK_SPAN; i < v.length - PEAK_SPAN; i++) {
      const isTop = v[i] >= v[i - 1] && v[i] >= v[i + 1] &&
                    v[i] > base + prominence &&
                    v[i] > v[i - PEAK_SPAN] + prominence &&
                    v[i] > v[i + PEAK_SPAN] + prominence;
      if (isTop && (out.length === 0 ||
                    i - out[out.length - 1] > PEAK_SPAN)) out.push(i);
    }
    return out;
  };

  /** Axis coordinate of a peak index from `peaks`. */
  const axisOf = (s: { v: number[]; lo: number }, i: number) =>
    AXIS_LO + (s.lo + i) * AXIS_STEP;

  // A flat lit target: the three planes collapsed onto one another, filled and
  // grown past the frame edges, graded neutrally. Everything visible is then
  // ONE uniform emission, so the glint field reads straight off a pixel with
  // no geometry underneath it to confound the scan.
  const FLAT = {
    grain: 0, scanline: 0, chroma_bleed: 0,
    drive: 0, toe: 0, shoulder: 0, warmth: 0, asymmetry: 0, highlight_desat: 0,
    plane_spacing: 0, zoom: 1.5, plane_size: 1.5,
    plane1_emission: 0.30, plane1_fill: 1, fill_gain: 1,
    plane2_emission: 0, plane3_emission: 0,
    line_width: 0, halo_gain: 0,
    glimmer_gain: 1.6, glimmer_shadow: 0.5,
    // Slow enough that a launched glint is up there for several seconds.
    glimmer_ratio: 0.15, glimmer_chaos: 0,
  };

  const sketch = (params: Record<string, unknown>): Sketch => ({
    anchor: null,
    wires: [],
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'bg@0',
        params: { color: [0, 0, 0] } },
      { type: 'module', module_type: 'source.mesh.three_planes',
        instance_key: 'tp@0', params: { ...FLAT, ...params } },
    ],
  } as Sketch);

  /** Park the knob, then sweep it across the middle, sampling as it goes. */
  const gesture = (id: string, params: Record<string, unknown>,
                   from: number, to: number, waits: number[]) =>
    runEngineMultiPhaseTest({
      width: W, height: H, modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: id,
              sketch: sketch({ ...params, glimmer_sweep: from }) },
            { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        // The gesture: one param write across the middle of the throw.
        { commands: [{ type: 'setParam', sketchId: id, colIdx: 0, chainIdx: 1,
                       paramKey: 'glimmer_sweep', value: to }],
          waitFrames: waits[0], captureTraceIds: ['out'] },
        { commands: [], waitFrames: waits[1], captureTraceIds: ['out'] },
      ],
      dumpName: id,
    });

  it('crossing the middle of the throw launches one glint', async () => {
    const r = await gesture('glint_launch', {}, 0.95, 0.05, [6, 30]);
    expect(r.success).toBe(true);

    // Parked: nothing at all. The field is one flat colour.
    const before = scan(r.phases[0].trace('out'));
    expect(peaks(before, 8).length).toBe(0);

    // After the gesture: exactly one slash, and only one — Chaos is off, so a
    // single traverse is a single glint.
    const after = scan(r.phases[1].trace('out'));
    expect(peaks(after, 8).length).toBe(1);
  });

  it('the glint travels up-right and keeps its own brightness', async () => {
    const r = await gesture('glint_travel', {}, 0.95, 0.05, [6, 40]);
    expect(r.success).toBe(true);
    const a = scan(r.phases[1].trace('out'));
    const b = scan(r.phases[2].trace('out'));
    const pa = peaks(a, 8), pb = peaks(b, 8);
    expect(pa.length).toBe(1);
    expect(pb.length).toBe(1);
    // Moved along the travel axis, in the +dir sense...
    expect(axisOf(b, pb[0])).toBeGreaterThan(axisOf(a, pa[0]) + 0.03);
    // ...and it is just as bright as it was, even though the knob has been
    // sitting still since. Nothing about the drive reaches a live glint.
    expect(Math.abs(b.v[pb[0]] - a.v[pa[0]])).toBeLessThan(14);
  });

  it('the direction is fixed: reversing the knob does not turn it round',
     async () => {
    // Sign is thrown away. The knob goes down through the middle, then back up
    // through it — and the first glint carries on exactly as it was while the
    // second one is thrown behind it.
    const r = await runEngineMultiPhaseTest({
      width: W, height: H, modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'glint_rev',
              sketch: sketch({ glimmer_sweep: 0.95 }) },
            { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: 'glint_rev' } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        { commands: [{ type: 'setParam', sketchId: 'glint_rev', colIdx: 0,
                       chainIdx: 1, paramKey: 'glimmer_sweep', value: 0.05 }],
          waitFrames: 8, captureTraceIds: ['out'] },
        { commands: [{ type: 'setParam', sketchId: 'glint_rev', colIdx: 0,
                       chainIdx: 1, paramKey: 'glimmer_sweep', value: 0.95 }],
          waitFrames: 30, captureTraceIds: ['out'] },
      ],
      dumpName: 'glint_rev',
    });
    expect(r.success).toBe(true);
    const sa = scan(r.phases[1].trace('out'));
    const sb = scan(r.phases[2].trace('out'));
    const a = peaks(sa, 8), b = peaks(sb, 8);
    expect(a.length).toBe(1);
    // Two of them now — the return trip is its own gesture — and the leader is
    // further along than it was, not back where it came from.
    expect(b.length).toBe(2);
    expect(axisOf(sb, b[b.length - 1])).toBeGreaterThan(axisOf(sa, a[0]));
  });

  it('Chaos scuffs a fast sweep up with extra, smaller glints', async () => {
    // The small ones only start arriving once the sweep is BRISK — measured in
    // crossings per second, so the ratio has to be up for a one-frame param
    // jump to count as fast. At 0.15 the same jump is a gentle sweep and the
    // result is one clean glint, which is the point of the threshold.
    const fast = { glimmer_ratio: 0.45 };
    const clean = await gesture('glint_clean', { ...fast, glimmer_chaos: 0 },
                                0.95, 0.05, [10, 10]);
    const messy = await gesture('glint_chaos', { ...fast, glimmer_chaos: 14 },
                                0.95, 0.05, [10, 10]);
    expect(clean.success && messy.success).toBe(true);
    const nClean = peaks(scan(clean.phases[1].trace('out')), 6).length;
    const nMessy = peaks(scan(messy.phases[1].trace('out')), 6).length;
    expect(nClean).toBe(1);
    expect(nMessy).toBeGreaterThan(nClean);
  });

  it('a glint lifts the halo, not just the line core', async () => {
    // HALF THE CLAIM THIS EFFECT MAKES. The glint multiplies emission, and
    // emission scales the core, the halo and the fill together — so one
    // crossing a tube brightens the glow around it as well, which is what
    // stops it reading as a highlight pasted on top of the picture.
    const only2 = {
      grain: 0, scanline: 0, chroma_bleed: 0,
      plane1_emission: 0, plane3_emission: 0,
      // Dim enough that the probe has headroom BOTH ways: at the effect's
      // default levels a wide halo clips flat at the top, and a glint crossing
      // a clipped pixel is invisible.
      plane2_emission: 0.30, halo_radius: 1.0, halo_gain: 0.7,
      glimmer_gain: 1.6, glimmer_shadow: 0.6,
      glimmer_ratio: 0.45, glimmer_chaos: 0,
    };

    // Probe a RING just outside plane 2's outline rather than one pixel of it.
    // The plane is a diamond with vertices at (±0.482, 0) and (0, ∓0.279);
    // 1.15x that is outside the line but well inside the halo, all the way
    // round. A glint is a band across the whole picture, so wherever it has
    // got to it crosses this ring somewhere — which is what makes the reading
    // a fact about the halo rather than a bet on the glint's position.
    const ring: [number, number][] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const k = 1.15 / (Math.abs(c) / 0.482 + Math.abs(sn) / 0.279);
      ring.push([c * k, sn * k]);
    }
    const ringMax = (f: any) =>
      Math.max(...ring.map(([x, y]) => luma(f.pixelAt(...toPx(x, y)))));

    // Flip the knob back and forth so there is always something in flight.
    const flips = [0.05, 0.95, 0.05];
    const r = await runEngineMultiPhaseTest({
      width: W, height: H, modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'glint_halo',
              sketch: sketch({ ...only2, glimmer_sweep: 0.95 }) },
            { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: 'glint_halo' } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        ...flips.map((v) => ({
          commands: [{ type: 'setParam' as const, sketchId: 'glint_halo', colIdx: 0,
                       chainIdx: 1, paramKey: 'glimmer_sweep', value: v }],
          waitFrames: 8, captureTraceIds: ['out'],
        })),
      ],
      dumpName: 'glint_halo',
    });
    expect(r.success).toBe(true);

    const rest = ringMax(r.phases[0].trace('out'));
    expect(rest).toBeGreaterThan(0);   // the ring really is in the halo
    const lit = Math.max(...[1, 2, 3].map((i) => ringMax(r.phases[i].trace('out'))));
    expect(lit).toBeGreaterThan(rest + 6);
  });

  it('a glint cannot touch a pixel that is not emitting', async () => {
    // THE OTHER HALF. It is a multiplier ON EMISSION, not a layer over the
    // finished frame: with every plane dark the incoming image survives
    // untouched however hard the glints are driven. An overlay would tint it.
    const dark = {
      grain: 0, scanline: 0, chroma_bleed: 0,
      plane1_emission: 0, plane2_emission: 0, plane3_emission: 0,
      glimmer_gain: 3, glimmer_shadow: 1, glimmer_chaos: 14, glimmer_ratio: 0.15,
    };
    const r = await runEngineMultiPhaseTest({
      width: W, height: H, modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'glint_dark', sketch: {
                anchor: null, wires: [],
                chain: [
                  { type: 'module', module_type: 'source.solid_color',
                    instance_key: 'bg@0', params: { color: [0.45, 0.20, 0.30] } },
                  { type: 'module', module_type: 'source.mesh.three_planes',
                    instance_key: 'tp@0',
                    params: { ...dark, glimmer_sweep: 0.95 } },
                ],
              } as Sketch },
            { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: 'glint_dark' } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        { commands: [{ type: 'setParam', sketchId: 'glint_dark', colIdx: 0,
                       chainIdx: 1, paramKey: 'glimmer_sweep', value: 0.05 }],
          waitFrames: 24, captureTraceIds: ['out'] },
      ],
      dumpName: 'glint_dark',
    });
    expect(r.success).toBe(true);
    const a = r.phases[0].trace('out');
    const b = r.phases[1].trace('out');
    let worst = 0;
    a.forEachPixel((p: any, x: number, y: number) => {
      worst = Math.max(worst, Math.abs(luma(p) - luma(b.pixelAt(x, y))));
    });
    expect(worst).toBe(0);
  });
});
