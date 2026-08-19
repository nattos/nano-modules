import { runGpuEffectTest, Frame, forEachBackend } from './gpu-test-helpers';

// Per-effect tests for source.mesh.three_planes — three isometric quads
// stacked vertically, shaded from an exact SDF in one fullscreen pass.
//
// The effect is stateless (every envelope lives outside it), so a single
// render is enough for every case; no renderEachTick, no tick counting.
//
// Geometry the assertions lean on, with the defaults below:
//   plane_y[i] = -(i - 1) * spacing * cos(elevation) * zoom
//   half_h     =  sin(elevation) * zoom * size * (|sin(az)| + |cos(az)|)
// Both are closed forms in the effect (main.cpp `projectPlanes`), so the
// tests recompute them here rather than hard-coding pixel rows.

forEachBackend((backend) => {
describe(`Three Planes E2E (${backend})`, () => {
  jest.setTimeout(60000);

  const W = 160, H = 108;
  const MODULE = 'source.mesh.three_planes';
  const BUNDLE = 'lights' as const;

  // Defaults mirrored from main.cpp's State.
  const SPACING = 0.42, ZOOM = 0.55, SIZE = 0.62;
  const ELEV_DEG = 35.264389682754654;

  const planeY = (i: number) =>
    -((i - 1) * SPACING) * Math.cos((ELEV_DEG * Math.PI) / 180) * ZOOM;
  const halfH = (azimuth: number) => {
    const th = azimuth * 2 * Math.PI;
    return Math.sin((ELEV_DEG * Math.PI) / 180) * ZOOM * SIZE *
           (Math.abs(Math.sin(th)) + Math.abs(Math.cos(th)));
  };

  // Cover-square coords -> pixel. Mirrors fx::coverSquare / nano_coords.hlsl.
  const ax = Math.max(W, H) / (2 * W);
  const ay = Math.max(W, H) / (2 * H);
  const toPx = (sx: number, sy: number): [number, number] => [
    Math.round((sx * ax + 0.5) * W),
    Math.round((sy * ay + 0.5) * H),
  ];

  const luma = (p: { r: number; g: number; b: number }) => (p.r + p.g + p.b) / 3;
  const meanRows = (f: Frame, y0: number, y1: number) => {
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = 0; x < W; x++) { s += luma(f.pixelAt(x, y)); n++; }
    return n > 0 ? s / n : 0;
  };

  // A quiet grade: no grain / scanlines, so assertions are about the geometry
  // and the resolve rather than about the analogue tail.
  const QUIET: [string, number][] = [
    ['grain', 0], ['scanline', 0], ['chroma_bleed', 0],
  ];

  it('declares metadata and its published rails', async () => {
    const frame = await runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, inputColor: [0, 0, 0, 1],
      dumpName: 'three_planes_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe(MODULE);
  });

  it('renders three planes stacked in the middle of the frame', async () => {
    const frame = await runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0, 0, 0, 1], params: QUIET,
      dumpName: 'three_planes_default',
    });
    expect(frame.success).toBe(true);

    // The stack occupies the vertical middle; the extreme top and bottom rows
    // are outside every plane's halo.
    const band = meanRows(frame, Math.round(H * 0.3), Math.round(H * 0.7));
    const top = meanRows(frame, 0, 6);
    const bot = meanRows(frame, H - 6, H);
    expect(band).toBeGreaterThan(top + 15);
    expect(band).toBeGreaterThan(bot + 15);
  });

  it('debug plane keys land in stacking order (bottom=plane1)', async () => {
    // Flat per-plane keys, no glow or grade: isolates the projection and the
    // bottom-to-top ordering from everything else.
    const frame = await runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0, 0, 0, 1],
      params: [...QUIET, ['debug_show_planes', 1]],
      dumpName: 'three_planes_keys',
    });
    expect(frame.success).toBe(true);

    // Plane 1 keys red and sits LOW (cover-square y grows downward);
    // plane 3 keys blue and sits HIGH.
    const [, y1] = toPx(0, planeY(0));
    const [, y3] = toPx(0, planeY(2));
    expect(y1).toBeGreaterThan(y3);

    const p1 = frame.pixelAt(...toPx(0, planeY(0)));
    const p3 = frame.pixelAt(...toPx(0, planeY(2)));
    expect(p1.r).toBeGreaterThan(p1.b);   // red key at the bottom plane
    expect(p3.b).toBeGreaterThan(p3.r);   // blue key at the top plane
  });

  it('is dark when every plane is unlit', async () => {
    const frame = await runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0, 0, 0, 1],
      params: [...QUIET,
        ['plane1_emission', 0], ['plane2_emission', 0], ['plane3_emission', 0]],
      dumpName: 'three_planes_unlit',
    });
    expect(frame.success).toBe(true);
    expect(meanRows(frame, 0, H)).toBeLessThan(3);
  });

  it('a masking plane occludes the halo beneath it but keeps its own outline',
     async () => {
    // THE core semantic. Plane 1 (bottom) glows; planes 2 and 3 are dark.
    // Turning plane 2 into a black mask must eat plane 1's glow wherever
    // plane 2's body covers it — while plane 2's own outline still emits.
    const base: [string, number][] = [
      ...QUIET,
      ['plane1_emission', 1], ['plane2_emission', 0.6], ['plane3_emission', 0],
      ['halo_gain', 1.2], ['halo_radius', 0.5],
    ];

    const open = await runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0, 0, 0, 1], params: [...base, ['plane2_fill', 0]],
      dumpName: 'three_planes_mask_open',
    });
    const masked = await runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0, 0, 0, 1], params: [...base, ['plane2_fill', -1]],
      dumpName: 'three_planes_mask_closed',
    });
    expect(open.success).toBe(true);
    expect(masked.success).toBe(true);

    // Deep inside plane 2's body, on the axis — plane 1's glow reaches here.
    const [mx, my] = toPx(0, planeY(1));
    expect(luma(masked.pixelAt(mx, my)))
      .toBeLessThan(luma(open.pixelAt(mx, my)) - 20);

    // But the mask is not a blackout: plane 2's outline still emits, so the
    // frame keeps a bright peak.
    let peak = 0;
    masked.forEachPixel((c) => { peak = Math.max(peak, luma(c)); });
    expect(peak).toBeGreaterThan(120);
  });

  // Published scalars only come back on the browser path: the native runner
  // (native/tools/native_test_runner.mm) hardcodes `pluginState` to an empty
  // object, so there is nothing to assert against under `metal`. The pixel
  // cases above still cover both backends.
  const itRails = backend === 'puppeteer' ? it : it.skip;

  itRails('publishes plane Y invariant under orbit while half-height swings',
     async () => {
    const read = async (azimuth: number) => {
      const f = await runGpuEffectTest({
        module: MODULE, bundle: BUNDLE, width: W, height: H,
        inputColor: [0, 0, 0, 1],
        params: [...QUIET, ['orbit_azimuth', azimuth]],
        dumpName: `three_planes_orbit_${azimuth}`,
      });
      expect(f.success).toBe(true);
      return f.pluginState as Record<string, number>;
    };

    const a = await read(0.0);      // |sin| + |cos| = 1
    const b = await read(0.125);    // 45 deg -> sqrt(2)

    // The plane centres sit ON the orbit axis, so azimuth cannot move them.
    for (const [k, i] of [['plane1_y', 0], ['plane2_y', 1], ['plane3_y', 2]] as const) {
      expect(a[k]).toBeCloseTo(planeY(i), 3);
      expect(b[k]).toBeCloseTo(a[k], 5);
    }
    // The silhouette height does swing, though.
    expect(a['plane2_half_h']).toBeCloseTo(halfH(0.0), 3);
    expect(b['plane2_half_h']).toBeCloseTo(halfH(0.125), 3);
    expect(b['plane2_half_h']).toBeGreaterThan(a['plane2_half_h'] + 0.05);
  });

  it('chroma bleed separates the channels on a white outline', async () => {
    // White planes, so the plane's own hue can't account for an r/b split.
    // Note the grade is NOT channel-neutral even at bleed 0: nano_vcr_softclip
    // saturates R sooner than B on purpose (film dye layers, style guide 3.1),
    // so white picks up a slight tint. The assertion is therefore relative —
    // what the split adds on top of that baseline.
    const white: [string, number | number[]][] = [
      ['grain', 0], ['scanline', 0], ['warmth', 0],
      ['plane1_color', [1, 1, 1]], ['plane2_color', [1, 1, 1]],
      ['plane3_color', [1, 1, 1]],
    ];
    const maxSplit = (f: Frame) => {
      let m = 0;
      f.forEachPixel((c) => { m = Math.max(m, Math.abs(c.r - c.b)); });
      return m;
    };

    const off = await runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0, 0, 0, 1],
      params: [...white, ['chroma_bleed', 0]] as any,
      dumpName: 'three_planes_chroma_off',
    });
    const on = await runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0, 0, 0, 1],
      params: [...white, ['chroma_bleed', 0.8]] as any,
      dumpName: 'three_planes_chroma_on',
    });
    expect(off.success).toBe(true);
    expect(on.success).toBe(true);

    expect(maxSplit(on)).toBeGreaterThan(maxSplit(off) + 25);
  });
});
});
