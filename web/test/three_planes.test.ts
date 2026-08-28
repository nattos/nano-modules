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
  // Travelling glints — the glare off metal in an old cel-animated show. They
  // are PARTICLES: each is born at a boundary, crosses, and dies at the far
  // side. Their lives are pinned host-free in
  // native/tests/test_three_planes_glints.cpp, which owns the clock; what only
  // a render shows is that a live one draws as a separate slash across the
  // picture, and where it draws.
  //
  // `ticks` is the whole reason these are readable: it advances the particle
  // system at a FIXED dt with no wall clock in it, so both backends run the
  // identical sequence and land on the identical frame.

  // A flat lit target: the three planes collapsed onto one another, filled,
  // grown past the frame edges and graded neutrally. Everything visible is
  // then ONE uniform emission, so the glint field is readable straight off a
  // pixel with no geometry underneath it to confound the reading.
  const FLAT: [string, any][] = [
    ...QUIET,
    ['drive', 0], ['toe', 0], ['shoulder', 0], ['warmth', 0],
    ['asymmetry', 0], ['highlight_desat', 0],
    ['plane_spacing', 0], ['zoom', 1.5], ['plane_size', 1.5],
    ['plane1_emission', 0.30], ['plane1_fill', 1], ['fill_gain', 1],
    ['plane2_emission', 0], ['plane3_emission', 0],
    ['line_width', 0], ['halo_gain', 0],
    ['glimmer_gain', 1.6], ['glimmer_shadow', 0.5],
  ];

  const flat = (extra: [string, any][], name: string, ticks = 0) =>
    runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0, 0, 0, 1], ticks,
      params: [...FLAT, ...extra] as any,
      dumpName: name,
    });

  // Travel direction at the default 45 deg, and the line square across it.
  // Cover-square y grows DOWNWARD, so "up-right" is (+, −).
  const R2 = Math.SQRT1_2;
  const TRAVEL: [number, number] = [R2, -R2];
  const ACROSS: [number, number] = [R2, R2];
  const scanAlong = (f: Frame, dir: [number, number], ts: number[]) =>
    ts.map((t) => luma(f.pixelAt(...toPx(t * dir[0], t * dir[1]))));
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v);

  /**
   * Samples along the travel axis. The scan walks the frame's centre diagonal,
   * which runs out of picture at |t| ≈ 0.955 (the short axis gives out first);
   * 0.90 stays inside that with room for the peak detector's standoff.
   */
  const AXIS: number[] = [];
  for (let t = -0.90; t <= 0.9001; t += 0.01) AXIS.push(t);

  /**
   * Local maxima that stand clear of the field around them — i.e. glints.
   *
   * The standoff has to be comparable to a glint's OWN width or nothing counts
   * as a peak: at the default width a glint spans about 0.17 of the travel, so
   * comparing against the samples immediately beside it compares two points on
   * the same slope. PEAK_SPAN is six samples, 0.06 of travel, out on the skirt.
   */
  const PEAK_SPAN = 6;
  const peaks = (v: number[], prominence: number) => {
    const out: number[] = [];
    for (let i = PEAK_SPAN; i < v.length - PEAK_SPAN; i++) {
      const isTop = v[i] >= v[i - 1] && v[i] >= v[i + 1] &&
                    v[i] > v[i - PEAK_SPAN] + prominence &&
                    v[i] > v[i + PEAK_SPAN] + prominence;
      // One glint counts once, however flat its top is.
      if (isTop && (out.length === 0 ||
                    i - out[out.length - 1] > PEAK_SPAN)) out.push(i);
    }
    return out;
  };

  it('Glint Drive 0 leaves the picture exactly as it was', async () => {
    // An unwired card must be untouched — and stay untouched however long it
    // runs, because with no drive nothing is ever born. This also pins the
    // shader's branchless idle path: the obvious early `return` compiles into
    // a local naga rejects, which silently blanks the whole effect on WebGPU.
    const still = await flat([['glimmer_drive', 0]], 'three_planes_glint_off');
    const later = await flat([
      ['glimmer_drive', 0], ['glimmer_density', 16], ['glimmer_gain', 3],
    ], 'three_planes_glint_off_late', 120);
    expect(still.success && later.success).toBe(true);
    let worst = 0;
    still.forEachPixel((p, x, y) => {
      worst = Math.max(worst, Math.abs(luma(p) - luma(later.pixelAt(x, y))));
    });
    expect(worst).toBe(0);
  });

  it('a glint draws as one slash square across its travel', async () => {
    // One particle, alone in the frame: a single bright band, constant along
    // the line square across the travel and varying sharply along it. That is
    // what says "slash", as opposed to a blob or a wash.
    const one = await flat([
      ['glimmer_drive', 1], ['glimmer_density', 0.001], ['glimmer_speed', 1.2],
    ], 'three_planes_glint_one', 24);
    expect(one.success).toBe(true);

    const along = scanAlong(one, TRAVEL, AXIS);
    expect(peaks(along, 8).length).toBe(1);

    // Through the peak, square across the travel: flat.
    const at = AXIS[along.indexOf(Math.max(...along))];
    const across = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map((u) =>
      luma(one.pixelAt(...toPx(at * TRAVEL[0] + u * ACROSS[0],
                               at * TRAVEL[1] + u * ACROSS[1]))));
    expect(spread(along)).toBeGreaterThan(30);
    expect(spread(across)).toBeLessThan(spread(along) / 4);
  });

  it('a glint travels, and keeps its own brightness while it does', async () => {
    // THE BRIEF. It crosses under its own power: the same particle, sampled
    // later, has MOVED but has not dimmed — even though the drive that threw
    // it has been taken away in the meantime.
    // 16 and 38 ticks at the harness's fixed 16 ms: the glint sits at either
    // end of the stretch of travel the centre diagonal actually crosses. (The
    // travel axis reaches past the frame's corners, so a glint further out
    // than this is real but off the line the scan walks.)
    const born = await flat([
      ['glimmer_drive', 1], ['glimmer_density', 0.001],
    ], 'three_planes_glint_t16', 16);
    const later = await flat([
      ['glimmer_drive', 1], ['glimmer_density', 0.001],
    ], 'three_planes_glint_t38', 38);
    expect(born.success && later.success).toBe(true);

    const a = scanAlong(born, TRAVEL, AXIS);
    const b = scanAlong(later, TRAVEL, AXIS);
    const pa = peaks(a, 8), pb = peaks(b, 8);
    expect(pa.length).toBe(1);
    expect(pb.length).toBe(1);
    // Moved UP-RIGHT along the travel axis...
    expect(AXIS[pb[0]]).toBeGreaterThan(AXIS[pa[0]] + 0.05);
    // ...and just as bright as it was. A pattern would have re-spaced and
    // re-levelled instead.
    expect(Math.abs(b[pb[0]] - a[pa[0]])).toBeLessThan(12);
  });

  it('a glint dies at the boundary rather than fading out early', async () => {
    // 1.2 crossings/s at full drive is ~52 frames from edge to edge: at 24
    // ticks it is halfway, and by 200 it is long gone — with nothing behind it,
    // because at this arrival rate the next one is half a minute away.
    const mid = await flat([
      ['glimmer_drive', 1], ['glimmer_density', 0.001],
    ], 'three_planes_glint_mid', 24);
    const gone = await flat([
      ['glimmer_drive', 1], ['glimmer_density', 0.001],
    ], 'three_planes_glint_gone', 200);
    expect(mid.success && gone.success).toBe(true);
    expect(peaks(scanAlong(mid, TRAVEL, AXIS), 8).length).toBe(1);
    expect(peaks(scanAlong(gone, TRAVEL, AXIS), 8).length).toBe(0);
  });

  it('a harder drive puts more glints on screen at once', async () => {
    // Arrivals scale with the drive outright while travel only lifts off a
    // floor, so density follows the knob — without any one glint's brightness
    // following it.
    const gentle = await flat([
      ['glimmer_drive', 0.2], ['glimmer_density', 8], ['glimmer_speed', 0.8],
    ], 'three_planes_glint_gentle', 90);
    const hard = await flat([
      ['glimmer_drive', 1.0], ['glimmer_density', 8], ['glimmer_speed', 0.8],
    ], 'three_planes_glint_hard', 90);
    expect(gentle.success && hard.success).toBe(true);
    const nGentle = peaks(scanAlong(gentle, TRAVEL, AXIS), 6).length;
    const nHard = peaks(scanAlong(hard, TRAVEL, AXIS), 6).length;
    expect(nHard).toBeGreaterThan(nGentle);
    expect(nHard).toBeGreaterThan(1);   // several distinct entities, not a wash
  });

  it('a glint lifts the halo, not just the line core', async () => {
    // HALF THE CLAIM THIS EFFECT MAKES. The glimmer multiplies emission, and
    // emission scales the core, the halo and the fill together — so a glint
    // crossing a tube brightens the glow around it as well, which is what
    // stops it reading as a highlight pasted on top of the picture.
    const only2: [string, any][] = [
      ...QUIET,
      ['plane1_emission', 0], ['plane3_emission', 0],
      // Dim enough that the probe pixel has headroom BOTH ways: at the
      // effect's own default levels a wide halo clips the probe flat at the
      // top, and a glint crossing a clipped pixel is invisible.
      ['plane2_emission', 0.30], ['halo_radius', 1.0], ['halo_gain', 0.7],
      ['glimmer_drive', 1], ['glimmer_density', 5],
      ['glimmer_gain', 1.6], ['glimmer_shadow', 0.6],
    ];
    const halo: number[] = [];
    for (const t of [10, 20, 30, 40, 50]) {
      const f = await runGpuEffectTest({
        module: MODULE, bundle: BUNDLE, width: W, height: H,
        inputColor: [0, 0, 0, 1], ticks: t,
        params: only2 as any,
        dumpName: `three_planes_glint_halo_${t}`,
      });
      expect(f.success).toBe(true);
      // Plane 2 is a diamond with its top vertex at y = −0.279 (it is the
      // middle floor, so it is centred whatever the spacing). Just above that
      // is halo and nothing else — no line core reaches this far out.
      halo.push(luma(f.pixelAt(...toPx(0, -0.32))));
    }
    expect(Math.min(...halo)).toBeGreaterThan(0);   // the probe is in the halo
    expect(spread(halo)).toBeGreaterThan(8);        // and glints cross it
  });

  it('the glimmer cannot touch a pixel that is not emitting', async () => {
    // THE OTHER HALF. It is a multiplier ON EMISSION, not a layer over the
    // finished frame: with every plane dark the incoming image must survive
    // untouched, however hard the glints are driven. An overlay would tint it.
    const dark: [string, any][] = [
      ...QUIET,
      ['plane1_emission', 0], ['plane2_emission', 0], ['plane3_emission', 0],
      ['glimmer_drive', 1], ['glimmer_density', 12],
      ['glimmer_gain', 3], ['glimmer_shadow', 1],
    ];
    const mk = (ticks: number) => runGpuEffectTest({
      module: MODULE, bundle: BUNDLE, width: W, height: H,
      inputColor: [0.45, 0.20, 0.30, 1], ticks,
      params: dark as any,
      dumpName: `three_planes_glint_dark_${ticks}`,
    });
    const a = await mk(0);
    const b = await mk(40);
    expect(a.success && b.success).toBe(true);
    let worst = 0;
    a.forEachPixel((p, x, y) => {
      worst = Math.max(worst, Math.abs(luma(p) - luma(b.pixelAt(x, y))));
    });
    expect(worst).toBe(0);
  });
});
});
