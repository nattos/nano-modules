import { runGpuChainTest, forEachFusionMode } from './gpu-test-helpers';

// Trace-variant tests. When a chain entry inside a fused run has an
// active trace point, the dispatcher should compile a "traced"
// shader variant that writes the post-stage pixel value to a real
// texture (instead of letting it stay in registers as a normal fused
// run does). The captured value must equal what the standalone path
// would have written at the same point.
//
// Tests pass `traceSteps` on the config; the runner pre-allocates a
// dedicated trace texture per step, threads it through the
// dispatcher (or copyTextureToTexture in the standalone path), and
// surfaces the readback via Frame.tracePixels / Frame.traceFrame.
//
// PUPPETEER-ONLY, and this is a recorded gap rather than an oversight. The web
// chain runner (public/gpu-test-runner.html) walks the chain and drives the
// fusion dispatcher itself, which is what lets it allocate a trace texture per
// step and hand the dispatcher per-stage trace handles. The native chain path
// goes through SketchExecutor, which has no per-stage trace capture to bind —
// so `traceSteps` would silently come back empty rather than fail. Enabling
// metal here means teaching SketchExecutor to expose that seam, which is a
// change to the executor, not to this suite. Its SIBLINGS (fusion.test.ts,
// fusion-strictout.test.ts) do run on both backends, so the fused kernels
// themselves are covered cross-backend; only the trace variant isn't.

forEachFusionMode((mode) => describe(`Fusion trace variants (${mode})`, () => {
  jest.setTimeout(30000);

  it('captures the post-stage value of a mid-fused-run mapper stage', async () => {
    // Chain: input (0.0, 0.0, 0.0)
    //   step 0 add(0.5, 0.0, 0.0) → (0.5, 0.0, 0.0)         [traced]
    //   step 1 add(0.0, 0.5, 0.0) → (0.5, 0.5, 0.0)
    //   step 2 mul(2.0, 1.0, 0.0) → (1.0, 0.5, 0.0)
    // Final: (255, 128, 0)
    // Trace step 0: (128, 0, 0)
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_add', params: [['offset', [0.5, 0.0, 0.0, 0.0]]] },
        { module: 'debug.fuse_add', params: [['offset', [0.0, 0.5, 0.0, 0.0]]] },
        { module: 'debug.fuse_mul', params: [['scale',  [2.0, 1.0, 0.0, 0.0]]] },
      ],
      bundle: 'testonly',
      inputColor: [0.0, 0.0, 0.0, 1.0],
      traceSteps: [0],
      dumpName: 'fusion_trace_mid_step0',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 128, b: 0, a: 255 }, 2);
    frame.traceFrame(0).expectUniformColor({ r: 128, g: 0, b: 0, a: 255 }, 2);
  });

  it('captures multiple stages within a single fused run', async () => {
    // (0.0, 0.0, 0.0)
    //   step 0 add(0.25, 0.0, 0.0) → (0.25, 0.0, 0.0)        [traced]
    //   step 1 add(0.25, 0.5, 0.0) → (0.5, 0.5, 0.0)         [traced]
    //   step 2 mul(2.0, 1.0, 2.0)  → (1.0, 0.5, 0.0)
    // 0.25 → ~64; 0.5 → 128; 1.0 → 255.
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_add', params: [['offset', [0.25, 0.0, 0.0, 0.0]]] },
        { module: 'debug.fuse_add', params: [['offset', [0.25, 0.5, 0.0, 0.0]]] },
        { module: 'debug.fuse_mul', params: [['scale',  [2.0, 1.0, 2.0, 0.0]]] },
      ],
      bundle: 'testonly',
      inputColor: [0.0, 0.0, 0.0, 1.0],
      traceSteps: [0, 1],
      dumpName: 'fusion_trace_two_intermediates',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 128, b: 0, a: 255 }, 2);
    frame.traceFrame(0).expectUniformColor({ r: 64, g: 0, b: 0, a: 255 }, 2);
    frame.traceFrame(1).expectUniformColor({ r: 128, g: 128, b: 0, a: 255 }, 2);
  });

  it('captures the final stage of a fused run (also the chain output)', async () => {
    // Trace step 1 == last fused stage; trace texture should match
    // the chain output exactly. This exercises the "last stage"
    // branch of flushFusedRun (snapshot from outputHandle, no trace
    // binding in the dispatcher).
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_add', params: [['offset', [0.5, 0.0, 0.0, 0.0]]] },
        { module: 'debug.fuse_mul', params: [['scale',  [1.0, 0.0, 2.0, 0.0]]] },
      ],
      bundle: 'testonly',
      inputColor: [0.0, 0.0, 0.5, 1.0],
      traceSteps: [1],
      dumpName: 'fusion_trace_last_stage',
    });
    expect(frame.success).toBe(true);
    // (0.0, 0.0, 0.5) + (0.5, 0.0, 0.0) = (0.5, 0.0, 0.5)
    // (0.5, 0.0, 0.5) * (1.0, 0.0, 2.0) = (0.5, 0.0, 1.0) → (128, 0, 255).
    frame.expectUniformColor({ r: 128, g: 0, b: 255, a: 255 }, 2);
    frame.traceFrame(1).expectUniformColor({ r: 128, g: 0, b: 255, a: 255 }, 2);
  });

  it('captures a strict-output top inside a fused run', async () => {
    // Strict-output IS the top — composer emits the trace before any
    // mapper tails run. Trace value === u_fuse.color.
    const frame = await runGpuChainTest({
      chain: [
        { module: 'debug.fuse_solid', params: [['color',  [0.4, 0.6, 0.8, 1.0]]] },
        { module: 'debug.fuse_add',   params: [['offset', [0.2, 0.0, 0.0, 0.0]]] },
      ],
      bundle: 'testonly',
      traceSteps: [0],
      dumpName: 'fusion_trace_strictout_top',
    });
    expect(frame.success).toBe(true);
    // After add: (0.6, 0.6, 0.8) → (153, 153, 204)
    frame.expectUniformColor({ r: 153, g: 153, b: 204, a: 255 }, 2);
    // Trace step 0: solid output = (0.4, 0.6, 0.8) → (102, 153, 204)
    frame.traceFrame(0).expectUniformColor({ r: 102, g: 153, b: 204, a: 255 }, 2);
  });
}));
