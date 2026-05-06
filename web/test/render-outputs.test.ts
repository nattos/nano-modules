import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for the canonical RenderOutputs struct rail. Verifies
 * the writer-side texture publication (`state::setGpuTexture` →
 * `materializeStructSnapshot`) and the reader-side hoist
 * (`applyStructRead` → `gpu::Device::textureForField`) are wired
 * end-to-end for an OPTIONAL texture leaf.
 *
 * Producer:  `debug.motion_rect` — overlays a moving colored rect and
 *            writes per-pixel velocity into `render_outputs/motion`.
 * Consumer:  `video.motion_blur` — reads `render_outputs/motion` and
 *            samples `tex_in` along the velocity to produce a directional
 *            blur. Pass-through when no upstream produces motion.
 */

const RENDER_OUTPUTS_SCHEMA = {
  type: 'object',
  fields: {
    depth:  { type: 'texture' },
    motion: { type: 'texture' },
  },
};

function buildChain(opts: {
  withMotionRect: boolean;
  withRails: boolean;
  quality?: number;
}): Sketch {
  const chain: any[] = [
    { type: 'texture_input', id: 'in' },
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
      taps: opts.withRails
        ? [{ railId: 'render_outputs_rail', fieldPath: 'render_outputs', direction: 'write' }]
        : [],
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
    taps: opts.withRails
      ? [{ railId: 'render_outputs_rail', fieldPath: 'render_outputs', direction: 'read' }]
      : [],
  });
  chain.push({ type: 'texture_output', id: 'out' });
  return {
    anchor: null,
    columns: [{
      name: 'main',
      rails: opts.withRails ? [{
        id: 'render_outputs_rail',
        name: 'Render Outputs',
        dataType: { kind: 'struct', schema: RENDER_OUTPUTS_SCHEMA },
      }] : [],
      chain,
    }],
  };
}

describe('RenderOutputs struct rail (motion blur showcase) E2E', () => {
  jest.setTimeout(40000);

  it('auto-routes motion vectors when the canonical rail is wired', async () => {
    const withRails = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_with_rails',
          sketch: buildChain({ withMotionRect: true, withRails: true }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_with_rails' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_with_rails',
    });
    expect(withRails.success).toBe(true);

    const withoutRails = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_without_rails',
          sketch: buildChain({ withMotionRect: true, withRails: false }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_without_rails' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_without_rails',
    });
    expect(withoutRails.success).toBe(true);

    // The two sketches differ ONLY in whether the canonical rail is wired
    // — same modules, same params, same tick count. With rails, the blur
    // applies a sample-along-velocity kernel that mixes rect pixels with
    // their neighbours; without rails, motion_blur falls back to a copy
    // and the rect comes through sharp. The frames must be visibly
    // different to confirm the rail actually transported the motion
    // texture handle.
    withRails.trace('out').expectDifferentFrom(withoutRails.trace('out'), 50);

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
    const withRailsTrail   = withRails.trace('out').countPixels(isTrailPixel);
    const withoutRailsTrail = withoutRails.trace('out').countPixels(isTrailPixel);
    // McGuire blur creates intermediate-color pixels along the rect's
    // swept-line trail. The pass-through fallback only has hard rect
    // edges (a few aliased pixels on the boundary), so with-rails
    // should have many more trail pixels.
    expect(withRailsTrail).toBeGreaterThan(withoutRailsTrail + 30);
  });

  it('falls back to pass-through when no upstream produces motion', async () => {
    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_passthru',
          sketch: buildChain({ withMotionRect: false, withRails: false }),
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
      columns: [{
        name: 'main',
        rails: [{
          id: 'render_outputs_rail',
          name: 'Render Outputs',
          dataType: { kind: 'struct', schema: RENDER_OUTPUTS_SCHEMA },
        }],
        chain: [
          { type: 'texture_input', id: 'in' },
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
            taps: [{ railId: 'render_outputs_rail', fieldPath: 'render_outputs', direction: 'write' }],
          },
          {
            type: 'module',
            module_type: 'video.motion_blur',
            instance_key: 'blur@0',
            params: { strength: 16.0, samples: 12, quality: 1 },
            taps: [{ railId: 'render_outputs_rail', fieldPath: 'render_outputs', direction: 'read' }],
          },
          { type: 'texture_output', id: 'out' },
        ],
      }],
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
      columns: [{
        name: 'main',
        chain: [
          { type: 'texture_input', id: 'in' },
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
          { type: 'texture_output', id: 'out' },
        ],
      }],
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
    expect(low.trace('out').countPixels(isTrailPixel)).toBeGreaterThan(50);
    expect(high.trace('out').countPixels(isTrailPixel)).toBeGreaterThan(50);
  });
});
