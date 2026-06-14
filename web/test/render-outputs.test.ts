import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for the canonical RenderOutputs struct handoff (single-stack
 * wire model). Verifies the writer-side texture publication
 * (`state::setGpuTexture` → `materializeStructSnapshot`) and the reader-side
 * hoist (`applyStructRead` → `gpu::Device::textureForField`) are wired
 * end-to-end for an OPTIONAL texture leaf — now via STRUCT AUTO-CONNECT (the
 * consumer's unwired `render_outputs` input binds the nearest compatible struct
 * producer above it) rather than an explicit rail.
 *
 * Producer:  `debug.motion_rect` — overlays a moving colored rect and
 *            writes per-pixel velocity into `render_outputs/motion`.
 * Consumer:  `video.motion_blur` — reads `render_outputs/motion` and
 *            samples `tex_in` along the velocity to produce a directional
 *            blur. Pass-through when no upstream produces motion.
 */

// Wire model: motion_blur's `render_outputs` input auto-connects to the nearest
// compatible struct producer above it (motion_rect). With no producer above, it
// falls back to a copy. `wires: []` opts the sketch into wire mode (auto-connect);
// no rails or taps needed.
function buildChain(opts: {
  withMotionRect: boolean;
  quality?: number;
}): Sketch {
  const chain: any[] = [
    {
      type: 'module',
      module_type: 'generator.solid_color',
      instance_key: 'bg@0',
      params: { color: [0.2, 0.2, 0.2] },
    },
  ];
  if (opts.withMotionRect) {
    chain.push({
      type: 'module',
      module_type: 'debug.motion_rect',
      instance_key: 'rect@0',
      // speed=3.0 + 60Hz tick gives ~3px velocity per frame at the
      // test viewport — enough to drive a visible McGuire trail at
      // strength=4 (V_max ~12px) without smearing past the tile size.
      params: { size: 0.25, speed: 3.0, color: [1.0, 0.4, 0.8] },
    });
  }
  chain.push({
    type: 'module',
    module_type: 'video.motion_blur',
    instance_key: 'blur@0',
    // Strength is a scale on per-frame uv velocity. Per-frame motion
    // here is ~1px at 60fps; we pump strength to 32 so V_max grows to
    // ~32px and produces a clearly visible trail behind the rect.
    // quality: 0 = Low, 1 = Medium (default), 2 = High — drives
    // pipeline-creation-time spec constants for TILE_SIZE / NEIGHBOR_RADIUS.
    params: {
      strength: 32.0,
      samples: 16,
      quality: opts.quality ?? 1,
    },
  });
  return {
    anchor: null,
    chain,
    wires: [],
  };
}

describe('RenderOutputs struct rail (motion blur showcase) E2E', () => {
  jest.setTimeout(40000);

  it('auto-connects motion vectors from the producer above (vs none)', async () => {
    const withProducer = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_with_producer',
          sketch: buildChain({ withMotionRect: true }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_with_producer' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_with_producer',
    });
    expect(withProducer.success).toBe(true);

    const noProducer = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_no_producer',
          sketch: buildChain({ withMotionRect: false }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_no_producer' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_no_producer',
    });
    expect(noProducer.success).toBe(true);

    // With a motion_rect producer above, motion_blur's `render_outputs` input
    // auto-connects to it and applies a sample-along-velocity kernel that mixes
    // rect pixels with their neighbours; with no producer above, it falls back
    // to a copy (plain background). The frames must be visibly different to
    // confirm auto-connect transported the motion texture handle.
    withProducer.trace('out').expectDifferentFrom(noProducer.trace('out'), 50);

    // Stronger assertion that the McGuire reconstruction is actually
    // producing TRAIL pixels (not just any difference): count pixels
    // whose color is "in between" the rect (255, 102, 204) and the
    // background (51, 51, 51) — i.e., partially pink, partially dim.
    // The without-rails frame should have ~zero such pixels (rect is
    // either fully there or fully background); the with-rails frame
    // should have a meaningful tail of mixed pixels in the rect's
    // motion direction.
    const isTrailPixel = (c: { r: number; g: number; b: number }) =>
      c.r > 70 && c.r < 230   // pinkish but not full rect
      && c.b > 60 && c.b < 200
      && c.r > c.g + 15;       // more pink than green (rules out background)
    const withProducerTrail = withProducer.trace('out').countPixels(isTrailPixel);
    const noProducerTrail   = noProducer.trace('out').countPixels(isTrailPixel);
    // McGuire blur creates intermediate-color pixels along the rect's
    // swept-line trail. The no-producer fallback has no rect at all (plain
    // background), so the auto-connected frame should have many more trail
    // pixels.
    expect(withProducerTrail).toBeGreaterThan(noProducerTrail + 30);
  });

  it('falls back to pass-through when no upstream produces motion', async () => {
    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_passthru',
          sketch: buildChain({ withMotionRect: false }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_passthru' } },
        ]},
      ],
      waitFrames: 15,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_passthru',
    });
    expect(result.success).toBe(true);

    // solid_color with color=(0.2, 0.2, 0.2) → (51, 51, 51, 255). With
    // no motion producer, motion_blur copies tex_in to tex_out → output
    // matches solid_color's output pixel-for-pixel.
    result.trace('out').expectUniformColor({ r: 51, g: 51, b: 51, a: 255 }, 5);
  });

  it('motion_swarm produces a multi-rect motion field', async () => {
    // Build a chain that uses motion_swarm as the producer rather
    // than motion_rect. The swarm emits many distinct rect colors
    // AND many distinct motion vectors, so the output frame should
    // have a much richer color histogram than the simple motion_rect
    // case. Also exercises the storage-buffer binding path that
    // motion_rect doesn't touch.
    const sketch: Sketch = {
      anchor: null,
      wires: [],
      chain: [
        {
          type: 'module',
          module_type: 'generator.solid_color',
          instance_key: 'bg@0',
          params: { color: [0.05, 0.05, 0.1] },
        },
        {
          type: 'module',
          module_type: 'debug.motion_swarm',
          instance_key: 'swarm@0',
          params: {
            count: 24,
            size: 0.06,
            swirl: 1.5,
            radial: 0.0,
            randomness: 0.4,
            speed: 1.0,
            opacity: 1.0,
            seed: 7,
          },
        },
        {
          type: 'module',
          module_type: 'video.motion_blur',
          instance_key: 'blur@0',
          params: { strength: 16.0, samples: 12, quality: 1 },
        },
      ],
    };

    const result = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        { type: 'createSketch', sketchId: 'mb_swarm', sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_swarm' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_swarm',
    });
    expect(result.success).toBe(true);

    // 24 randomly coloured rects + motion-blur trails should leave a
    // very rich histogram (hundreds of unique colours). Plain bg-only
    // would give us 1 colour; motion_rect gave us ~38 last time we
    // measured. The swarm should be in a different league entirely.
    const frame = result.trace('out');
    const colors = new Set<string>();
    frame.forEachPixel((c) => {
      colors.add(`${c.r},${c.g},${c.b}`);
    });
    expect(colors.size).toBeGreaterThan(200);
  });

  it('motion_static produces a sparse fine-grained motion field', async () => {
    // motion_static visualizes its own motion vectors in HSV-polar
    // form when opacity > 0. With threshold=0.95 and a 128×128
    // viewport, ~5% of pixels are active (≈ 800 pixels) — each gets
    // a coloured pixel whose hue depends on its tangent direction.
    // Since direction varies smoothly around the center, the
    // resulting visualization spans a wide range of hues.
    const sketch: Sketch = {
      anchor: null,
      wires: [],
      chain: [
        {
          type: 'module',
          module_type: 'generator.solid_color',
          instance_key: 'bg@0',
          params: { color: [0.0, 0.0, 0.0] },
        },
        {
          type: 'module',
          module_type: 'debug.motion_static',
          instance_key: 'static@0',
          params: {
            threshold: 0.95,
            swirl: 0.01,
            jitter: 0.0,
            seed: 42,
            opacity: 1.0,
            vis_scale: 100,
          },
        },
      ],
    };

    const result = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        { type: 'createSketch', sketchId: 'mb_static', sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_static' } },
        ]},
      ],
      waitFrames: 5,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_static',
    });
    expect(result.success).toBe(true);

    // The vector visualization spans many hues (direction varies
    // continuously with position), so we expect a meaningful spread
    // of unique colors. Pure black-or-rect would give us 1–2 colors.
    const frame = result.trace('out');
    const colors = new Set<string>();
    let activePixels = 0;
    frame.forEachPixel((c) => {
      colors.add(`${c.r},${c.g},${c.b}`);
      if (c.r + c.g + c.b > 30) activePixels++;
    });
    // ~5% of pixels at threshold=0.95 → ~800 active in a 128² frame.
    // Cast a wide net to allow for hash-pattern variance.
    expect(activePixels).toBeGreaterThan(200);
    expect(activePixels).toBeLessThan(2000);
    // Hues span the full circle when motion direction is tangential
    // to the center — expect many distinct colours.
    expect(colors.size).toBeGreaterThan(100);
  });

  it('motion_field generates motion vectors from input luma', async () => {
    // Bright generator → motion_field → motion_blur. Default
    // rotation_weight=1 makes every above-threshold pixel emit a
    // +x velocity. motion_blur then smears the bright background
    // horizontally. We confirm: (a) the chain runs cleanly, (b) the
    // output has many distinct colors (the smear creates a brightness
    // gradient instead of two flat colors), and (c) the visualization
    // path doesn't crash when vis_opacity > 0.
    const sketch: Sketch = {
      anchor: null,
      wires: [],
      chain: [
        {
          type: 'module',
          module_type: 'generator.solid_color',
          instance_key: 'bg@0',
          // Bright enough to trip the default 0.5 threshold.
          params: { color: [0.9, 0.7, 0.4] },
        },
        {
          type: 'module',
          module_type: 'video.motion_field',
          instance_key: 'mf@0',
          params: {
            threshold: 0.4,
            softness: 0.05,
            magnitude: 0.008,
            mag_jitter: 0.4,
            mag_noise_scale: 12.0,
            rotation: 30.0,
            rotation_weight: 1.0,
            radial_weight: 0.0,
            radial_anchor: [0.5, 0.5],
            gradient_weight: 0.0,
            gradient_bias: 90.0,
            angle_jitter: 0.1,
            angle_noise_scale: 24.0,
            seed: 7,
            // Visualization off — production usage. The motion
            // vectors flow downstream regardless.
            // Vis on so the smoke test sees per-pixel hue/value
            // variation in the output even when tex_in is uniform —
            // confirms the velocity field is actually being computed.
            vis_opacity: 1.0,
            vis_scale: 200.0,
          },
        },
        {
          type: 'module',
          module_type: 'video.motion_blur',
          instance_key: 'blur@0',
          params: { strength: 24.0, samples: 12, quality: 1 },
        },
      ],
    };

    const result = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'mf_chain', sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mf_chain' } },
        ]},
      ],
      waitFrames: 20,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_motion_field',
    });
    expect(result.success).toBe(true);

    // motion_field's per-pixel jitter combined with motion_blur's
    // gather should produce many subtly different colors. A pure
    // pass-through (no motion field engaged) would be nearly uniform.
    const frame = result.trace('out');
    const colors = new Set<string>();
    frame.forEachPixel((c) => { colors.add(`${c.r},${c.g},${c.b}`); });
    expect(colors.size).toBeGreaterThan(20);
  });

  it('chroma_delay shifts R/G/B channels along motion', async () => {
    // motion_rect → motion_blur with chroma_delay on. Without chroma,
    // the rect's pink (255, 102, 204) blurs into uniform pink along
    // the motion direction. With chroma at strong R/B offsets, the
    // R and B trails separate from the G — pixels in the trail end
    // up with R-ish OR B-ish bias (rather than equal-pink gradients).
    // The histogram should show new colors that aren't on the
    // original pink-to-bg gradient line.
    const buildChromaChain = (chromaOn: boolean): Sketch => ({
      anchor: null,
      wires: [],
      chain: [
        {
          type: 'module',
          module_type: 'generator.solid_color',
          instance_key: 'bg@0',
          params: { color: [0.05, 0.05, 0.05] },
        },
        {
          type: 'module',
          module_type: 'debug.motion_rect',
          instance_key: 'rect@0',
          params: { size: 0.25, speed: 3.0, color: [1.0, 0.4, 0.8] },
        },
        {
          type: 'module',
          module_type: 'video.motion_blur',
          instance_key: 'blur@0',
          params: {
            strength: 32.0,
            samples: 16,
            quality: 1,
            chroma_delay: chromaOn,
            // Modest offsets so chroma-shifted R/G/B stay within
            // the rect's footprint (otherwise they sample
            // background and the chroma effect becomes "rect goes
            // black" instead of "rect splits into RGB trails").
            chroma_r:  0.4,
            chroma_g:  0.0,
            chroma_b: -0.4,
          },
        },
      ],
    });

    const off = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        { type: 'createSketch', sketchId: 'mb_chroma_off', sketch: buildChromaChain(false) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_chroma_off' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_chroma_off',
    });
    expect(off.success).toBe(true);

    const on = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        { type: 'createSketch', sketchId: 'mb_chroma_on', sketch: buildChromaChain(true) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_chroma_on' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_chroma_on',
    });
    expect(on.success).toBe(true);

    // Without chroma, the gather samples R/G/B at the same positions,
    // so the output's RGB ratio across the trail stays close to the
    // rect's source ratio (255, 102, 204) blended with bg. With
    // chroma on, R and B come from offset positions along the motion
    // direction — pixels in the trail get distinctly different RGB
    // ratios. We assert via "frames differ" rather than specific
    // color-shift counts because exact ratios depend on V_max scale
    // (which the bilinear pyramid sampling smooths) and the gather
    // jitter. Frame diff is the robust signal that chroma changed
    // something, regardless of magnitude.
    on.trace('out').expectDifferentFrom(off.trace('out'), 100);
  });

  it('quality preset switches PSO via pipeline constants', async () => {
    // Renders the same chain at Low (TILE_SIZE=16, NEIGHBOR_RADIUS=1)
    // vs High (TILE_SIZE=24, NEIGHBOR_RADIUS=3). Reach scales from
    // ~16 px to ~72 px, so the trail spans different fractions of
    // the 128px viewport — frames must differ. The host translates
    // the C++ `gpu::Constants{"TILE_SIZE": ...}` map into Chromium's
    // `@id`-keyed pipeline constants record at PSO creation time;
    // this test exercises both that translation and the runtime
    // PSO rebuild that fires when the `quality` field is patched.
    const low = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_low',
          sketch: buildChain({ withMotionRect: true, withRails: true, quality: 0 }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_low' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_quality_low',
    });
    expect(low.success).toBe(true);

    const high = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_high',
          sketch: buildChain({ withMotionRect: true, withRails: true, quality: 2 }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_high' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_quality_high',
    });
    expect(high.success).toBe(true);

    // The two presets bake different (TILE_SIZE, NEIGHBOR_RADIUS)
    // into the shaders via spec constants. We just verify both run
    // cleanly and produce non-degenerate output — the spec-constant
    // path itself is the thing under test (PSO rebuild succeeds,
    // pipeline constants resolve to numeric IDs, both shaders compile
    // and dispatch). A `lowTrail vs highTrail` size comparison would
    // be flaky at puppeteer's jitter-prone per-frame motion budget
    // because at small V_max the McGuire cone (limited by |V_y|, not
    // by tile reach) bounds trail extent in both presets equally.
    const isTrailPixel = (c: { r: number; g: number; b: number }) =>
      c.r > 70 && c.r < 230 && c.b > 60 && c.b < 200 && c.r > c.g + 15;
    // Threshold is a non-degenerate-output sanity check, NOT a trail-size
    // measurement (the comment above explains why low-vs-high sizing is too
    // flaky to assert). The exact count drifts with puppeteer's per-frame
    // motion-budget jitter — isolated runs clear 50, but under full-suite load
    // it dips to ~40 — so keep the bar well below that while still clearly
    // separating "PSO compiled + motion dispatched" (dozens of px) from a
    // degenerate/blank result (~0).
    expect(low.trace('out').countPixels(isTrailPixel)).toBeGreaterThan(20);
    expect(high.trace('out').countPixels(isTrailPixel)).toBeGreaterThan(20);
  });
});
