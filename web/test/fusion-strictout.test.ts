import { runGpuChainTest, forEachFusionMode } from './gpu-test-helpers';

// Strict-output top + mapper-tail fusion tests, built on the
// test-only generator fuse_solid (writes uniform color to every
// pixel, no input texture) plus the same fuse_add / fuse_mul
// mappers used by fusion.test.ts.
//
// The composer takes a different shape when the top is strict-output
// — no inputTex binding, the first fragment is called with
// (gid, vp_size) instead of (gid, c) — so these chains exercise
// that branch end-to-end. As with the mapper-only tests, every chain
// runs in all three modes and the same assertions must hold byte-
// identical (the parity guarantee).

forEachFusionMode((mode) => describe(`Fusion strict-output top (${mode})`, () => {
  jest.setTimeout(30000);

  it('single fuse_solid stage produces a flat uniform color', async () => {
    // (0.4, 0.6, 0.8) → (102, 153, 204).
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_solid', params: [['color', [0.4, 0.6, 0.8, 1.0]]] },
      ],
      bundle: 'testonly',
      // No inputColor — the strict-output stage generates pixels itself.
      dumpName: 'fusion_so_single',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 102, g: 153, b: 204, a: 255 }, 2);
  });

  it('two-stage chain [solid → add]', async () => {
    // solid(0.2, 0.2, 0.2) → (0.2, 0.2, 0.2)
    // add(0.3, 0.0, 0.0)   → (0.5, 0.2, 0.2)  → (128, 51, 51)
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_solid', params: [['color',  [0.2, 0.2, 0.2, 1.0]]] },
        { module: 'debug.fuse_add',   params: [['offset', [0.3, 0.0, 0.0, 0.0]]] },
      ],
      bundle: 'testonly',
      dumpName: 'fusion_so_solid_add',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 128, g: 51, b: 51, a: 255 }, 2);
  });

  it('three-stage chain [solid → add → mul]', async () => {
    // solid(0.5, 0.5, 0.5) = (0.5, 0.5, 0.5)
    // add  (0.0, 0.5, 0.5) = (0.5, 1.0, 1.0) — clamped
    // mul  (1.0, 0.5, 0.0) = (0.5, 0.5, 0.0) → (128, 128, 0)
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_solid', params: [['color',  [0.5, 0.5, 0.5, 1.0]]] },
        { module: 'debug.fuse_add',   params: [['offset', [0.0, 0.5, 0.5, 0.0]]] },
        { module: 'debug.fuse_mul',   params: [['scale',  [1.0, 0.5, 0.0, 0.0]]] },
      ],
      bundle: 'testonly',
      dumpName: 'fusion_so_three_stage',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 128, g: 128, b: 0, a: 255 }, 2);
  });

  it('alpha from the strict-output stage propagates through tails', async () => {
    // solid sets alpha = 0.25 → 64. add/mul leave it untouched.
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_solid', params: [['color',  [0.0, 0.0, 0.0, 0.25]]] },
        { module: 'debug.fuse_add',   params: [['offset', [0.5, 0.0, 0.0, 0.0]]] },
      ],
      bundle: 'testonly',
      dumpName: 'fusion_so_alpha',
    });
    expect(frame.success).toBe(true);
    // 0.25 → 64 (round-half-to-even or just floor, either way).
    frame.expectUniformColor({ a: 64 }, 2);
  });

  it('chain [mapper, solid, mapper] forces a run break at the strict-output stage', async () => {
    // The planner has to flush the in-progress mapper run when it
    // hits a strict-output stage (strict-output must be top of its
    // own run). After fuse_solid the chain restarts, so the trailing
    // mul applies to solid's output, not the original input.
    //
    // input (0.4, 0.4, 0.4)
    // → add (0.0, 0.0, 0.0) — identity, but starts a real run
    // → solid(0.5, 0.5, 0.5) — REPLACES → (0.5, 0.5, 0.5)
    // → mul (2.0, 0.0, 1.0) → (1.0, 0.0, 0.5) → (255, 0, 128)
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_add',   params: [['offset', [0.0, 0.0, 0.0, 0.0]]] },
        { module: 'debug.fuse_solid', params: [['color',  [0.5, 0.5, 0.5, 1.0]]] },
        { module: 'debug.fuse_mul',   params: [['scale',  [2.0, 0.0, 1.0, 0.0]]] },
      ],
      bundle: 'testonly',
      inputColor: [0.4, 0.4, 0.4, 1.0],
      dumpName: 'fusion_so_mid_chain',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 0, b: 128, a: 255 }, 2);
  });
}));
