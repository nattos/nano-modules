import { describe, it, expect, beforeEach } from 'vitest';
import { SketchExecutor } from './sketch-executor';
import type { WasmModule } from './wasm-host';
import type { Sketch } from './sketch-types';

// ---------------------------------------------------------------------------
// Executor identity-skip logic
//
// `SketchExecutor.executeColumn` walks a column's chain, threading a texture
// handle stage-to-stage. A STATELESS effect whose current params make it a
// pure passthrough reports module.isIdentity() === true; the executor then
// skips its dispatch, consumes no intermediate slot, and aliases its input as
// its output (currentInputHandle threads past it unchanged).
//
// A full executeColumn run is deeply coupled to WebGPU (real GPUDevice /
// GPUHost / FusionDispatcher), which is mocked-out / unavailable in the
// Vitest jsdom environment — so we can't stand up the real GPU pipeline here.
// Instead we build a SketchExecutor with the GPU-touching seams stubbed:
//   - ensureInstance() returns FAKE LoadedModules (fake host + a module whose
//     isIdentity()/render()/tick() we control and observe),
//   - ensureIntermediates() hands back plain integer handles (no GPU textures),
//   - the gpuHost / fusionDispatcher collaborators are inert stubs.
// This exercises the real skip-decision code path in executeColumn (slot
// accounting, handle threading, debugStats) without any GPU.
// ---------------------------------------------------------------------------

interface FakeModule extends WasmModule {
  renderCalls: number;
  tickCalls: number;
}

function makeFakeModule(identity: boolean): FakeModule {
  const m: FakeModule = {
    renderCalls: 0,
    tickCalls: 0,
    init: () => {},
    tick: () => { m.tickCalls++; },
    render: () => { m.renderCalls++; },
    onStatePatched: () => {},
    isIdentity: () => identity,
  };
  return m;
}

// Minimal stand-in for the WasmHost fields executeColumn touches on the
// non-tap passthrough path (schema empty => resetInactiveStructInputs is a
// no-op; fusionKind FREEFORM => canFuseStage false => standalone render path).
function makeFakeHost(): any {
  return {
    // A renderable video effect declares a primary texture output (io 6 =
    // Output|Primary). Without it the executor would (correctly) treat the stage
    // as a texture-passthrough modulation source and skip its render.
    schema: { tex_out: { type: 'texture', io: 6 } },
    bridgeCore: undefined,
    pluginKey: undefined,
    fusionKind: 0 /* FUSION_KIND_FREEFORM */,
    fusionFragmentWgsl: '',
    fusionFragmentName: '',
    fusionUniformBufferHandle: 0,
    fieldsWithReader: new Set<string>(),
    fieldsWithWriter: new Set<string>(),
    tapInstalledTextureFields: new Set<string>(),
    textureFields: new Map<string, number>(),
    inputTextureHandles: [] as number[],
    drawList: [] as any[],
    frameState: {
      elapsedTime: 0, deltaTime: 0, barPhase: 0, bpm: 0,
      viewportW: 0, viewportH: 0, params: [] as number[],
    },
    fireStateReady: () => {},
    notifyStatePatched: () => {},
  };
}

// Build a SketchExecutor with the constructor bypassed so we don't need a
// real GPUDevice. We then install the fakes + stub the GPU seams.
function makeExecutor(modulesByKey: Map<string, FakeModule>): {
  executor: any;
  setSurfaceCalls: { value: number };
} {
  const executor: any = Object.create(SketchExecutor.prototype);

  const setSurfaceCalls = { value: 0 };
  executor.gpuHost = {
    setSurface: () => { setSurfaceCalls.value++; },
    injectTexture: () => 0,
  };
  executor.fusionDispatcher = { dispatch: () => {}, invalidate: () => {} };
  executor.instances = new Map();
  executor.sketchIntermediates = new Map();
  executor.chainEntryHandles = new Map();
  executor.tracedChainEntries = new Set();
  // Wire transient state — normally seeded by executeAllColumns; this test calls
  // executeColumn directly, so stub the empty (no-wires) shape the inline field
  // initializers would otherwise provide.
  executor.wireCur = new Map();
  executor.wirePrev = new Map();
  executor.wirePos = new Map();
  executor.wiresByDest = new Map();
  executor.wireSrcFields = new Set();
  executor.wireSrcInstances = new Set();
  executor.wirePrevBySketch = new Map();
  executor.delayedTexCache = new Map();
  executor.fusionMode = 'auto';
  executor.debugStats = {
    effectsExecuted: 0, standaloneDispatches: 0,
    fusedRuns: 0, fusedStages: 0, identitySkipped: 0,
  };

  // Stub the GPU-allocating intermediates helper: 64 plain integer handles
  // (100, 101, …) standing in for intermediate texture handles.
  executor.ensureIntermediates = () => ({
    textures: new Array(64).fill(null),
    handles: Array.from({ length: 64 }, (_, i) => 100 + i),
  });

  // Stub instance resolution to return our fakes.
  executor.ensureInstance = async (entry: any) => {
    const module = modulesByKey.get(entry.instance_key)!;
    return { host: makeFakeHost(), module };
  };

  return { executor, setSurfaceCalls };
}

function makeSketch(instanceKeys: string[]): Sketch {
  return {
    anchor: 'generator.test@0',
    columns: [{
      name: 'main',
      chain: instanceKeys.map((key) => ({
        type: 'module' as const,
        module_type: 'video.test',
        instance_key: key,
      })),
    }],
  };
}

const FRAME = {
  elapsedTime: 0, deltaTime: 0.016, barPhase: 0, bpm: 120,
  viewportW: 256, viewportH: 256, params: [],
};

async function runColumn(executor: any, sketch: Sketch, inputHandle: number) {
  const slotCounter = { value: 0 };
  const out = await executor.executeColumn(
    'sketch0', sketch, 0, inputHandle, FRAME, 256, 256, slotCounter,
  );
  return { out, finalSlot: slotCounter.value };
}

describe('SketchExecutor identity skip', () => {
  it('baseline: a 3-stage non-identity chain renders every stage', async () => {
    const a = makeFakeModule(false);
    const b = makeFakeModule(false);
    const c = makeFakeModule(false);
    const modules = new Map([['a', a], ['b', b], ['c', c]]);
    const { executor } = makeExecutor(modules);

    const sketch = makeSketch(['a', 'b', 'c']);
    const { out, finalSlot } = await runColumn(executor, sketch, /*input*/ 7);

    // Every stage rendered and consumed a slot.
    expect(a.renderCalls).toBe(1);
    expect(b.renderCalls).toBe(1);
    expect(c.renderCalls).toBe(1);
    expect(finalSlot).toBe(3);
    expect(executor.debugStats.standaloneDispatches).toBe(3);
    expect(executor.debugStats.identitySkipped).toBe(0);
    // Output is the last stage's intermediate slot (handle 102), not input.
    expect(out).toBe(102);
  });

  it('an identity stage between two real stages is skipped (no slot, no dispatch)', async () => {
    const a = makeFakeModule(false);   // real
    const mid = makeFakeModule(true);  // identity passthrough
    const c = makeFakeModule(false);   // real
    const modules = new Map([['a', a], ['mid', mid], ['c', c]]);
    const { executor } = makeExecutor(modules);

    const sketch = makeSketch(['a', 'mid', 'c']);
    const { out, finalSlot } = await runColumn(executor, sketch, /*input*/ 7);

    // The identity stage ticked but did NOT render.
    expect(mid.tickCalls).toBe(1);
    expect(mid.renderCalls).toBe(0);
    expect(a.renderCalls).toBe(1);
    expect(c.renderCalls).toBe(1);

    // Only the two real stages consumed slots → final stage got slot 1
    // (handle 101). The skipped stage threaded a's output (100) into c.
    expect(finalSlot).toBe(2);
    expect(executor.debugStats.standaloneDispatches).toBe(2);
    expect(executor.debugStats.identitySkipped).toBe(1);
    expect(out).toBe(101);

    // The skipped stage's chain-entry handle aliases input==output (= a's
    // output handle 100), so a trace on it resolves to the upstream texture.
    const skippedEntry = executor.chainEntryHandles.get('sketch0/0/1');
    expect(skippedEntry).toEqual({ input: 100, output: 100 });
  });

  it('an all-identity chain returns the input handle unchanged (passthrough)', async () => {
    const a = makeFakeModule(true);
    const b = makeFakeModule(true);
    const modules = new Map([['a', a], ['b', b]]);
    const { executor } = makeExecutor(modules);

    const sketch = makeSketch(['a', 'b']);
    const { out, finalSlot } = await runColumn(executor, sketch, /*input*/ 42);

    expect(a.renderCalls).toBe(0);
    expect(b.renderCalls).toBe(0);
    expect(finalSlot).toBe(0);               // no slots consumed
    expect(executor.debugStats.standaloneDispatches).toBe(0);
    expect(executor.debugStats.identitySkipped).toBe(2);
    expect(out).toBe(42);                     // == original input handle
  });

  it('an identity stage whose output a wire consumes is NOT skipped', async () => {
    const wired = makeFakeModule(true);      // would be identity…
    const modules = new Map([['wired', wired]]);
    const { executor } = makeExecutor(modules);
    // A wire consumes this stage's output. The alias path leaves no real
    // texture for the wire to publish, so the executor must fall through to the
    // normal render path. (wireSrcInstances is normally populated from
    // sketch.wires by executeAllColumns; set it directly here.)
    executor.wireSrcInstances = new Set(['wired']);

    const sketch = makeSketch(['wired']);
    const { out, finalSlot } = await runColumn(executor, sketch, /*input*/ 7);

    // …but because its output is wired, it still renders and consumes a slot.
    expect(wired.renderCalls).toBe(1);
    expect(finalSlot).toBe(1);
    expect(executor.debugStats.identitySkipped).toBe(0);
    expect(executor.debugStats.standaloneDispatches).toBe(1);
    expect(out).toBe(100);
  });
});
