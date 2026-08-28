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

  // The highlight tint is the shared nano_vcr knob (see vcr_halo.test.ts for
  // its exact behaviour); this only checks it is wired through here — the
  // white-hot line cores must take the tint while the halos keep their own
  // per-plane colour.
  it('the highlight tint colours the white-hot line cores', async () => {
    const mk = (amount: number, name: string) => runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0, 0, 0, 1],
      params: [...QUIET, ['highlight_tint_amount', amount],
               ['highlight_tint', [0.10, 0.85, 0.25]]] as any,
      dumpName: name,
    });
    const off = await mk(0, 'three_planes_tint_off');
    const on  = await mk(1, 'three_planes_tint_on');
    expect(off.success && on.success).toBe(true);

    // Probe the brightest pixel of the UNTINTED frame — that is a line core,
    // and it is the pixel guaranteed to be over the pivot. Picking the
    // brightest of the tinted frame instead would find whatever stayed white.
    let best = -1, bx = 0, by = 0;
    off.forEachPixel((p, x, y) => {
      if (luma(p) > best) { best = luma(p); bx = x; by = y; }
    });
    const a = off.pixelAt(bx, by), b = on.pixelAt(bx, by);
    expect(Math.abs(a.r - a.b)).toBeLessThan(40);   // white-hot to start with
    expect(b.g).toBeGreaterThan(b.r + 60);
    expect(b.g).toBeGreaterThan(b.b + 60);
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

  // THE MEDIAL AXIS. A halo built on the nearest edge carries that construction's
  // skeleton into the picture: the distance to the outline ridges along both
  // diagonals of a quad — the locus where the nearest edge switches — and the
  // softmin's own bias brightens along the same locus, so the interior reads as
  // a dark four-pointed star or a bright centre ringed by a dark contour
  // depending on which of the two wins. Normally each plane's interior is washed
  // out by its neighbours' halos and you never see it; set the spacing to zero,
  // so all three coincide and there are no neighbours, and it is the only thing
  // in the frame. The interior is therefore a SUM over the four edges instead —
  // light from four tubes, no nearest-edge structure to inherit (render.hlsl,
  // kInteriorBlend).
  //
  // Probed as a DIP: on a smooth field a point on the axis sits at about the
  // mean of its two neighbours either side; across a kink it sits well below
  // them. Rendered larger than the rest of the suite because the probe needs a
  // few pixels of standoff to straddle.
  it('no medial-axis seam inside a plane', async () => {
    const BW = 480, BH = 320;
    const bax = Math.max(BW, BH) / (2 * BW), bay = Math.max(BW, BH) / (2 * BH);
    const bpx = (sx: number, sy: number): [number, number] =>
      [Math.round((sx * bax + 0.5) * BW), Math.round((sy * bay + 0.5) * BH)];

    const frame = await runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: BW, height: BH,
      inputColor: [0, 0, 0, 1],
      params: [...QUIET, ['plane_spacing', 0]] as any,
      dumpName: 'three_planes_medial',
    });
    expect(frame.success).toBe(true);

    // Well inside the rhombus, on the horizontal diagonal — the long arm of the
    // skeleton, and the one with the most room around it to measure.
    const on = luma(frame.pixelAt(...bpx(0.125, 0)));
    const up = luma(frame.pixelAt(...bpx(0.125, -0.025)));
    const dn = luma(frame.pixelAt(...bpx(0.125, 0.025)));
    const dip = (up + dn) / 2 - on;

    // A nearest-edge field reads about 0.47 here; the light-sum about 0.07.
    expect(on).toBeGreaterThan(4);          // the probe is on the lit interior
    expect(dip / on).toBeLessThan(0.25);
  });

  // ---------------------------------------------------------------- Glimmer
  // Travelling diagonal glints — the glare off metal in an old cel-animated
  // show. They multiply each plane's EMISSION rather than the finished
  // picture, which is what makes them read as light in the tube instead of a
  // highlight pasted over it. Rate and intensity come from outside (Three
  // Planes Rig's Sweep knob); this effect only draws a phase.

  // A flat lit target: the three planes collapsed onto one another, filled,
  // grown past the frame edges and graded neutrally. Everything visible is
  // then ONE uniform emission, so the glimmer field is readable straight off a
  // pixel with no geometry underneath it to confound the reading.
  const FLAT: [string, any][] = [
    ...QUIET,
    ['drive', 0], ['toe', 0], ['shoulder', 0], ['warmth', 0],
    ['asymmetry', 0], ['highlight_desat', 0],
    ['plane_spacing', 0], ['zoom', 1.5], ['plane_size', 1.5],
    ['plane1_emission', 0.30], ['plane1_fill', 1], ['fill_gain', 1],
    ['plane2_emission', 0], ['plane3_emission', 0],
    ['line_width', 0], ['halo_gain', 0],
    ['glimmer_density', 3], ['glimmer_gain', 0.6], ['glimmer_shadow', 0.5],
  ];

  const flat = (extra: [string, any][], name: string) => runGpuEffectTest({
    module: MODULE, bundle: BUNDLE, width: W, height: H,
    inputColor: [0, 0, 0, 1],
    params: [...FLAT, ...extra] as any,
    dumpName: name,
  });

  // Travel direction at the default 45 deg, and the band line square across it.
  // Cover-square y grows DOWNWARD, so "up-right" is (+, −).
  const R2 = Math.SQRT1_2;
  const TRAVEL: [number, number] = [R2, -R2];
  const BAND: [number, number] = [R2, R2];
  const scan = (f: Frame, dir: [number, number], ts: number[]) =>
    ts.map((t) => luma(f.pixelAt(...toPx(t * dir[0], t * dir[1]))));
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v);

  it('Glint Amount 0 leaves the picture exactly as it was', async () => {
    // The guard that used to be an early `return` in the shader — DXC compiles
    // one into a local naga rejects, which silently blanks the whole effect on
    // WebGPU. It is arithmetic now: `amount` scales both band sets, so zero
    // amount computes a multiplier of exactly 1. This is what pins that.
    const off = await flat([['glimmer_amount', 0]], 'three_planes_glim_off');
    const wild = await flat([
      ['glimmer_amount', 0], ['glimmer_phase', 0.37],
      ['glimmer_density', 11], ['glimmer_gain', 3], ['glimmer_shadow', 1],
    ], 'three_planes_glim_zero');
    expect(off.success && wild.success).toBe(true);
    let worst = 0;
    off.forEachPixel((p, x, y) => {
      const q = wild.pixelAt(x, y);
      worst = Math.max(worst, Math.abs(luma(p) - luma(q)));
    });
    expect(worst).toBe(0);
  });

  it('the glints run square across the travel direction', async () => {
    const on = await flat([['glimmer_amount', 1], ['glimmer_phase', 0.1]],
                          'three_planes_glim_axis');
    expect(on.success).toBe(true);

    // Two scans through the centre of the same uniform field: one along the
    // travel, one along a band. A band is a line of constant brightness by
    // construction, so only the first may vary.
    const ts = [-0.30, -0.20, -0.10, 0, 0.10, 0.20, 0.30];
    const along = scan(on, TRAVEL, ts);
    const across = scan(on, BAND, ts);
    expect(spread(along)).toBeGreaterThan(30);
    // Not zero: toPx rounds to whole pixels, so a "band line" sample sits up to
    // half a pixel off the true line and picks up a little of the gradient.
    expect(spread(across)).toBeLessThan(spread(along) / 4);
  });

  it('the phase wraps seamlessly at 1', async () => {
    // Why the second, finer band set travels at exactly TWO periods per wrap
    // rather than some prettier irrational: the rail that drives this counts
    // round and round, and a phase of 1 has to be the same picture as 0 or
    // every lap would show a jump.
    const zero = await flat([['glimmer_amount', 1], ['glimmer_phase', 0]],
                            'three_planes_glim_p0');
    const one  = await flat([['glimmer_amount', 1], ['glimmer_phase', 1]],
                            'three_planes_glim_p1');
    expect(zero.success && one.success).toBe(true);
    let worst = 0;
    zero.forEachPixel((p, x, y) => {
      worst = Math.max(worst, Math.abs(luma(p) - luma(one.pixelAt(x, y))));
    });
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('the phase carries the glints along the travel direction', async () => {
    // u = axis * density − phase, so a peak sits at axis = phase / density:
    // advancing the phase by 0.15 at density 3 slides it 0.05 UP-RIGHT.
    const ts: number[] = [];
    for (let t = -0.20; t <= 0.20001; t += 0.005) ts.push(t);
    const peakAt = (v: number[]) => ts[v.indexOf(Math.max(...v))];

    const a = await flat([['glimmer_amount', 1], ['glimmer_phase', 0]],
                         'three_planes_glim_move0');
    const b = await flat([['glimmer_amount', 1], ['glimmer_phase', 0.15]],
                         'three_planes_glim_move1');
    expect(a.success && b.success).toBe(true);
    const shift = peakAt(scan(b, TRAVEL, ts)) - peakAt(scan(a, TRAVEL, ts));
    expect(shift).toBeGreaterThan(0.02);   // up-right, not down-left
    expect(shift).toBeLessThan(0.08);
  });

  it('a glint lifts the halo, not just the line core', async () => {
    // HALF THE CLAIM THIS EFFECT MAKES. The glimmer multiplies emission, and
    // emission scales the core, the halo and the fill together — so a glint
    // crossing a tube brightens the glow around it as well, which is what
    // stops it reading as a highlight pasted on top of the picture.
    const only2: [string, any][] = [
      ...QUIET,
      ['plane1_emission', 0], ['plane3_emission', 0],
      ['plane2_emission', 0.8], ['halo_radius', 1.0], ['halo_gain', 1.2],
      ['glimmer_amount', 1], ['glimmer_density', 3],
      ['glimmer_gain', 1.4], ['glimmer_shadow', 0.6],
    ];
    const halo: number[] = [];
    for (const ph of [0, 0.2, 0.4, 0.6, 0.8]) {
      const f = await runGpuEffectTest({
        module: MODULE, bundle: BUNDLE, width: W, height: H,
        inputColor: [0, 0, 0, 1],
        params: [...only2, ['glimmer_phase', ph]] as any,
        dumpName: `three_planes_glim_halo_${Math.round(ph * 100)}`,
      });
      expect(f.success).toBe(true);
      // Plane 2 is a diamond with its top vertex at y = −0.279 (it is the
      // middle floor, so it is centred whatever the spacing). Just above that
      // is halo and nothing else — no line core reaches this far out.
      halo.push(luma(f.pixelAt(...toPx(0, -0.32))));
    }
    expect(Math.min(...halo)).toBeGreaterThan(0);   // the probe is in the halo
    expect(spread(halo)).toBeGreaterThan(8);
  });

  it('the glimmer cannot touch a pixel that is not emitting', async () => {
    // THE OTHER HALF. It is a multiplier ON EMISSION, not a layer over the
    // finished frame: with every plane dark the incoming image must survive
    // untouched, however hard the glints are driven. An overlay would tint it.
    const dark: [string, any][] = [
      ...QUIET,
      ['plane1_emission', 0], ['plane2_emission', 0], ['plane3_emission', 0],
      ['glimmer_amount', 1], ['glimmer_density', 3],
      ['glimmer_gain', 3], ['glimmer_shadow', 1],
    ];
    const mk = (ph: number) => runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0.45, 0.20, 0.30, 1],
      params: [...dark, ['glimmer_phase', ph]] as any,
      dumpName: `three_planes_glim_dark_${Math.round(ph * 100)}`,
    });
    const a = await mk(0);
    const b = await mk(0.37);
    expect(a.success && b.success).toBe(true);
    let worst = 0;
    a.forEachPixel((p, x, y) => {
      worst = Math.max(worst, Math.abs(luma(p) - luma(b.pixelAt(x, y))));
    });
    expect(worst).toBe(0);
  });
});
});
