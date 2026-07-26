import { runGpuChainTest, forEachFusionMode, forEachBackend } from './gpu-test-helpers';

// Multi-stage fusion tests, built on the test-only mappers fuse_add
// and fuse_mul (predictable per-pixel math: clamp(c.rgb + offset),
// clamp(c.rgb * scale)). Each chain runs in BOTH 'force-off' (every
// stage standalone) and 'force-on' (consecutive mappers fuse into
// one dispatch); the same golden assertions must hold in both modes,
// proving byte-identity between the standalone and fused paths
// regardless of run length.

// Both backends: the native chain path runs the same SketchExecutor +
// fusion planner the web dispatcher mirrors, so the goldens below are a
// real cross-backend claim about the fused kernels, not just the math.
forEachBackend((backend) =>
forEachFusionMode((mode) => describe(`Fusion multi-stage (${mode}, ${backend})`, () => {
  jest.setTimeout(30000);

  it('single fuse_add stage: input + offset', async () => {
    // (0.5, 0.5, 0.5) + (0.1, 0.0, -0.5) → (0.6, 0.5, 0.0).
    // 0.6 → 153, 0.5 → 128, 0.0 → 0.
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_add', params: [['offset', [0.1, 0.0, -0.5, 0.0]]] },
      ],
      bundle: 'testonly',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'fusion_single_add',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 153, g: 128, b: 0, a: 255 }, 2);
  });

  it('two-stage chain [add → mul]', async () => {
    // (0.0, 0.5, 0.0) + (0.5, 0.0, 0.5) = (0.5, 0.5, 0.5)
    // (0.5, 0.5, 0.5) * (2.0, 1.0, 0.0) = (1.0, 0.5, 0.0)
    // 1.0 → 255, 0.5 → 128, 0.0 → 0.
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_add', params: [['offset', [0.5, 0.0, 0.5, 0.0]]] },
        { module: 'debug.fuse_mul', params: [['scale',  [2.0, 1.0, 0.0, 0.0]]] },
      ],
      bundle: 'testonly',
      inputColor: [0.0, 0.5, 0.0, 1.0],
      dumpName: 'fusion_chain_add_mul',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 128, b: 0, a: 255 }, 2);
  });

  it('three-stage chain [add → mul → add]', async () => {
    // (0.2, 0.2, 0.2) + (0.1, 0.1, 0.1) = (0.3, 0.3, 0.3)
    // (0.3, 0.3, 0.3) * (2.0, 0.5, 1.0) = (0.6, 0.15, 0.3)
    // (0.6, 0.15, 0.3) + (0.1, 0.0, 0.0) = (0.7, 0.15, 0.3)
    // 0.7 → 178, 0.15 → 38, 0.3 → 76.
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_add', params: [['offset', [0.1, 0.1, 0.1, 0.0]]] },
        { module: 'debug.fuse_mul', params: [['scale',  [2.0, 0.5, 1.0, 0.0]]] },
        { module: 'debug.fuse_add', params: [['offset', [0.1, 0.0, 0.0, 0.0]]] },
      ],
      bundle: 'testonly',
      inputColor: [0.2, 0.2, 0.2, 1.0],
      dumpName: 'fusion_chain_add_mul_add',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 178, g: 38, b: 76, a: 255 }, 2);
  });

  it('clamp at the top of [0, 1] survives chaining', async () => {
    // (0.8, 0.8, 0.8) + (0.5, 0.5, 0.5) = clamp → (1.0, 1.0, 1.0)
    // (1.0, 1.0, 1.0) * (0.5, 0.5, 0.5) = (0.5, 0.5, 0.5)  → 128.
    // The intermediate clamp matters: without it the second stage
    // would receive 1.3, multiply by 0.5, and produce 0.65 → 166.
    // Force-off and force-on must agree the answer is 128.
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_add', params: [['offset', [0.5, 0.5, 0.5, 0.0]]] },
        { module: 'debug.fuse_mul', params: [['scale',  [0.5, 0.5, 0.5, 0.0]]] },
      ],
      bundle: 'testonly',
      inputColor: [0.8, 0.8, 0.8, 1.0],
      dumpName: 'fusion_chain_clamp',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 128, g: 128, b: 128, a: 255 }, 2);
  });

  it('alpha passes through unchanged across a 3-stage chain', async () => {
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_add', params: [['offset', [0.1, 0.1, 0.1, 0.0]]] },
        { module: 'debug.fuse_mul', params: [['scale',  [1.0, 1.0, 1.0, 0.0]]] },
        { module: 'debug.fuse_add', params: [['offset', [0.0, 0.0, 0.0, 0.0]]] },
      ],
      bundle: 'testonly',
      inputColor: [0.0, 0.0, 0.0, 0.5],
      dumpName: 'fusion_alpha_passthrough',
    });
    expect(frame.success).toBe(true);
    // alpha 0.5 → 128 (rounds up from 127.5).
    frame.expectUniformColor({ a: 128 }, 2);
  });

  it('mixed fusable + freeform: planner splits at the freeform stage', async () => {
    // brightness_contrast is not fusion-aware (no registerFusion call),
    // so it forces a run break. With force-on the chain becomes:
    //   [fused(fuse_add)] → [single(brightness_contrast)] → [fused(fuse_mul)]
    // With force-off everything is single. Both paths must agree on
    // the final pixel — that's the parity guarantee the planner has
    // to keep.
    //
    // Math (with brightness=0.0 / contrast=0.5 = identity defaults):
    //   (0.4, 0.4, 0.4) + (0.1, 0.1, 0.1) = (0.5, 0.5, 0.5)
    //   brightness_contrast at defaults = pass-through
    //   (0.5, 0.5, 0.5) * (1.0, 0.0, 2.0) = (0.5, 0.0, 1.0) → (128, 0, 255).
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_add',            params: [['offset', [0.1, 0.1, 0.1, 0.0]]] },
        { module: 'color.tone.brightness_contrast', params: [] },
        { module: 'debug.fuse_mul',            params: [['scale',  [1.0, 0.0, 2.0, 0.0]]] },
      ],
      bundle: 'testonly',
      inputColor: [0.4, 0.4, 0.4, 1.0],
      dumpName: 'fusion_mixed_split',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 128, g: 0, b: 255, a: 255 }, 2);
  });
})));
