# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nano Repatch is a node-based visual programming environment for real-time audio/graphics synthesis, built as a web app. The core engine is called **Structor** — a statically analyzable execution graph system with universal broadcast semantics.

## Commands

The repo has two build trees: **`web/`** (the Vite web app + unit/e2e tests) and **`native/`**
(the C++ barrel/executor, the WASM effect bundles, and Catch2 tests). There is no root
`package.json` — run web commands from `web/`.

```bash
# Web (run from web/)
npm run dev          # Vite dev server (config default port 5173)
npm run build        # vite build
npm test             # Vitest unit tests (--run), co-located as *.test.ts in src/
npm run test:e2e     # Jest+Puppeteer e2e (web/test/**/*.test.ts); needs the dev server up

# GPU e2e against a running dev server (point at whatever port it's on, e.g. 5174):
GPU_TEST_BASE_URL=http://localhost:5174 npx jest <name>   # gpu-pipeline, platform-features, particles, ...

# Native (run from native/)
cmake --build build              # build the barrel lib + executor.wasm + tests
ctest --test-dir build           # run Catch2 tests
cd wasm_modules && ./build_all.sh # rebuild ALL effect .wasm bundles (or `cd <bundle> && ./build.sh` for one)
```

VCS is **jj** (Jujutsu), not plain git: `jj commit -m "<msg>"`. Multiple workspaces share one repo
(`default`, `text`, etc.), each with its own working-copy commit (`@`).

No separate lint command — TypeScript strict mode (`strict: true`, `noImplicitAny: true`) is the primary static check.

Effect shaders compile with **DXC** (`dxc` must be on PATH).

## Architecture

### Multi-threaded Design

The app runs across four threads communicating via `postMessage`:

- **Main thread**: UI (Lit web components + MobX reactivity), state management (`AppController`, `LocalController`)
- **CompilerWorker**: Compiles UI graph state into executable `GraphDefinition`
- **ExecutorWorker**: Runs `GraphExecutor` loop with dirty-tracking
- **Wire Layout Worker**: Calculates wire routing paths

### Worker Isolation Rules

Node definitions split logic from UI to avoid circular imports in worker bundles:
- `nodes.ts` — Pure logic, shared with workers. No DOM/Lit/window imports.
- `ui-registration.ts` — Registers UI editors/renderers to node definitions. Only imported from `controllers.ts` (main thread).

### Serialization Boundary

MobX proxies cannot cross `postMessage`. Always sanitize with `JSON.parse(JSON.stringify(toJS(data)))` before sending to workers.

### Core Data Model

- **Structor**: Runtime data unit (atomic value, array, record, or functor)
- **StructorType**: Static type counterpart for compile-time analysis
- **Broadcast**: Universal operation for declarative data reshaping — nodes write scalar logic, the broadcast engine handles vectorization
- **Grab Bag Inputs**: Each node receives a single `StructorRecord` with all connected inputs (named `fields` + ordered `untagged`)

### State Architecture

- **AppController**: Graph state (nodes, connections), undo/redo (immer + command pattern), serialization
- **LocalController**: UI state (selection, viewport, metrics)
- **RuntimeManager**: Orchestrates workers and execution
- **TUIConfig vs TCompiledConfig**: Inspector-editable state vs processed runtime state. Always use `<TUIConfig, TCompiledConfig>` generics in `defineNode`.

### "Hero Node" Side-Channel

High-frequency visualization data (FFT, envelopes) bypasses MobX via a `ui` output property. Editor components poll `runtimeManager.uiStates.get(nodeId)` via `requestAnimationFrame`.

### Native barrel + WASM effect bundles

One C++ source (`sketch_executor.cpp`) builds into **both** the native barrel/FFGL lib **and**
`executor.wasm` (web), driving effects through the `effrt` host ABI. Effects compile to per-bundle
`.wasm` files (core/lights/nano/testonly/text/richtext) loaded via WAMR on native and in-browser on
web. The web build serves the **same** `build/wasm/*.wasm` files, so rebuild bundles
(`native/wasm_modules/build_all.sh`) before running web e2e — a stale bundle is a common false failure.

### Cross-platform shader pipeline (HLSL → SPV → {MSL, WGSL})

Effects author each shader stage **once as HLSL**. The build (DXC) compiles HLSL → SPIR-V and bakes
it into a C++ header (`<effect>_shaders.h` with `UPPER_SPV[]` / `UPPER_SPV_SIZE`) via
`_emit_spv_header_var` (helpers in `wasm_modules/wasm_build_env.sh`). At load the host translates SPV
→ **MSL** on native (SPIRV-Cross, `spv_to_msl.cpp`) or → **WGSL** on web (naga, via the dev-server
naga bridge). Effect side:

```cpp
state::registerShaderSPV("my_shader", MY_SHADER_SPV, MY_SHADER_SPV_SIZE [, "<wgsl_fmt>", "<access>"]);
auto mod = gpu::Device::createShaderModuleByName("my_shader");
```

There is **no inline-WGSL effect path** — the raw `gpu::Device::createShaderModule(source)` effect ABI
was retired (the executor keeps its own raw-MSL path for blend/fusion; that's separate). See the
`flash_particles/` and `flow_swarm/` bundles for the canonical instanced-quad-reading-a-storage-buffer
template.

Key rules:
- **Binding indices are register numbers.** DXC maps HLSL `register(t1/b0/u2)` directly to the SPIR-V
  binding number (shared across resource types). These must line up with the `gpu::Bindings()` order
  AND the render-time `setBuffer`/`setTexture` slots, or you get silent mis-binds → black output.
- **Storage-texture formats:** the `registerShaderSPV(...,fmt,access)` override rewrites naga's default
  `rgba32float`. For a *second*, differently-formatted storage texture in one shader, pin it with
  `[[vk::image_format("r32f")]]` (DXC bakes the format so the override's regex won't touch it).
- **3D textures:** native `createTexture3D` exists, but querying a 3D texture's dimensions from a
  shader is non-portable — use a compile-time-constant size + exact-N³ dispatch.
- **Compute workgroup size:** MSL doesn't encode `[numthreads]`; `spv_to_msl.cpp` carries it as a
  `// nano_threadgroup: X Y Z` comment that the Metal backend parses per-PSO. Don't reintroduce a
  hardcoded `threadsPerThreadgroup`.

### Wire modulation + telemetry

Wires modulate a scalar input from a producer output. The whole transform pipeline lives in ONE
lock-step file `native/src/sketch/tap_mod.h` ↔ `web/src/tap-mod.ts` — keep them byte-identical
(shared goldens: `test_tap_mod.cpp` + `tap-mod.test.ts`). Pipeline per wire: `applyTapMod` (remap
curves, then `scale` applied **last** — in modulation space) → `applyMagnitude`/`combineTap` (fold
into the dest field's `[min,max]` per the combine mode + signed/unsigned `magnitude`). An output's
declared `floatField` min/max **is** its modulation-range contract (per-effect param changes like LFO
amplitude are intentionally not reflected).

To surface modulation in the UI, the executor records per modulated input `{value, min, max, neutral}`
(`recordModBand` — samples the lock-step fold over the source range, so web≡native for free) into
`lastModulationData()`. It rides a dedicated `modulationDataDiff` frame channel (cloned from
`pluginStatesDiff`) to `appState.local.engine.modulationData`; sliders read it via
`FieldBinding.getModulation()` and draw a band + neutral-anchored fill.

## Node Development

Nodes are defined with `defineNode`/`definePrimitiveNode` from `src/structor/type-helpers.ts`:

- `execute` must return a record matching `outputs` (e.g., `{ result: 5 }`)
- With `autoBroadcast: true`, `execute` receives scalars — the system iterates over vectors automatically
- Config schemas use spread syntax (`{ ...numberType, defaultValue: 60 }`), NOT `{ type: numberType }`
- Define inputs with `defaultValue` for virtual inputs — don't duplicate in both `inputs` and `config`
- Register nodes in `ALL_PRIMITIVES` in `src/structor/primitives.ts`
- Stateful nodes: use `createState` + `initialized` flag to avoid ghost triggers on first frame

## Testing

- **Vitest** unit tests: co-located as `*.test.ts` in `web/src/`. Config in `web/vite.config.ts`.
- **Jest+Puppeteer** E2E tests: in `web/test/`. Do not mix Jest/Vitest syntax. GPU e2e point at a running dev server via `GPU_TEST_BASE_URL`.
- **Catch2** native tests: `native/tests/` (e.g. `test_effect_render.cpp` drives effects through `SketchExecutor` and asserts pixels); run via `ctest --test-dir build`.
- E2E tests use `window.testing.appController` for programmatic state setup. Use `page.evaluate()` for shadow DOM traversal.
- Virtual inputs in tests: `executor.setNodeConfig(id, { values: { trigger: ... } })` — use the `values` sub-key.
- Environment mocks (Canvas, MIDI, AudioContext, Monaco) configured in `src/vitest.setup.ts`.

## Key Pitfalls

- `GraphExecutor.setNodeConfig` does shallow merge of top-level keys — never replace the entire config object with a partial update
- Moving a region must recursively move/push all children and their contents
- Collapsed region detection requires checking `MetricsProvider` (visibility can be `'auto'`)
- AudioContext state must be mirrored from main thread to worker via explicit messages — don't trust worker's view
- Nodes with dynamic ports need `shouldRecompileOnConfigChange` returning `true` to trigger topology updates
- Feedback loops use `cycleBreakingPorts` + two-phase execution (`execute` then `consolidate`)
- Native auto-connect (`sketch_augment`) **skips** chain entries lacking `"type":"module"` — a test sketch missing it silently generates no struct/texture rails (effect reads nothing). Web sketches already include it
- After editing effect logic or shaders, rebuild the bundle before testing — both native and web load the built `.wasm`
- Rewriting a GPU **buffer** a dispatch already read this frame is safe on both platforms (the backend versions the backing buffer; each dispatch sees the latest write preceding its encode) — but rewriting a **texture** in that position is last-write-wins and only logs a warning: upload to a fresh texture instead. Never rely on effect-called `gpu::Device::submit()` for ordering — it's a no-op inside the native frame batch (a real flush on web)
