# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nano Repatch is a live visual-synthesis environment. A **sketch** is a chain of wasm **effects**
with **wires** modulating their parameters; one shared C++ executor runs it on Metal (the Resolume
barrel/FFGL plugin) and on WebGPU (the web app), from the same document. The web app is the editor —
a linear effects list, an arrangement timeline, and a freeform sidecar canvas beside the list.

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

### Threading

- **Main thread**: UI (Lit web components + MobX reactivity via `MobxLitElement`) and document
  state (`state/controller.ts`'s `AppController`, `state/app-state.ts`'s `appState`).
- **Engine worker** (`engine-worker.ts`): owns `executor.wasm` through `executor-host.ts` and runs
  the render loop. The main thread talks to it via `engine-proxy.ts`; per-frame results come back on
  diff channels (`pluginStatesDiff`, `modulationDataDiff`, traced frames).

MobX proxies cannot cross `postMessage` — sanitize with `JSON.parse(JSON.stringify(toJS(data)))`
before sending.

### State architecture

`appState` splits into `database` (the persisted document: `sketches`, each a
`{chain, wires, instances}` per `sketch-types.ts`) and `local` (UI-only: selection, mode flags,
engine telemetry, `userSettings`).

All document edits go through `AppController.mutate(description, recipe)` — immer + a history
manager. Long-running gestures (slider drags, insert-then-pick-a-type) use `beginLongEdit`, which
previews live and lands as ONE undo point, or `cancel()`s leaving no history. Derived document
state is refreshed EXPLICITLY at the end of each recipe (see `reorderExec`), never from a reaction:
MobX reactions are for UI only.

### Editor UI stack

`sketch-app` / `effect-ide-app` → `app-shell` (tab rail + left panel + splitter + right panel) →
`sketch-column-editor` → `columns-view` (scroll container) → `column-group` (effect cards, field
widgets, inspectors, ports). `taps-overlay` draws wires as SVG arcs over it, resolving endpoints
per rAF from DOM rects (`field-anchor-lookup.ts`, `field-layout-manager.ts`).

A tab may set `renderRight` to take over the right panel while keeping the left editor mounted —
that is how the Devices tab and the sidecar canvas both work, and it is what lets wires be dragged
between the two panels. When something takes the monitor area, the output pops out to
`devices-float-monitor`.

### Sidecar canvas

A freeform node surface beside the linear effects list. It is a PARTITION of the same `chain`, not
a second array: an entry carrying a `canvas: {x,y}` placement is a canvas node, and those are kept
at the chain TAIL so canvas editing never shifts a linear chain index (monitor trace ids
`ce:<col>/<idx>` and implicit rail ids bake them in). It renders through a second `<column-group>`
in `layoutMode="canvas"`.

Execution order is computed by the UI (`state/exec-order.ts`, a topo-sort over the wires with
linear adjacency as a hard constraint) and stored as `Sketch.execOrder`; the executor only repairs
and replays it (`sketch_canvas::resolveExecOrder`, lock-step with `repairExecOrder`, pinned by
`web/test/fixtures/exec-order-cases.json`). The key omits itself whenever it equals chain order, so
canvas-free sketches serialize unchanged. Wire causality — `delayed` — is read from position in
THAT order, not from chain position.

A canvas stage never touches the linear image chain: it reads its own wired texture input (falling
back to the sketch input) and never advances the column's texture cursor. See `canvasStageInput` /
`publishStage` in `sketch_executor.cpp`, and `native/src/sketch/sketch_canvas.h`.

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

Wires modulate a scalar input from a producer output. The whole transform pipeline lives in
`native/src/sketch/tap_mod.h`, which the web side reaches through `executor.wasm` — there is no TS
twin (the former `web/src/tap-mod.ts` was deleted; goldens are `test_tap_mod.cpp` plus the
behavioural web tests `mod-remap`/`mod-motion`). Pipeline per wire: `applyTapMod` (remap
curves, then `scale` applied **last** — in modulation space) → `applyMagnitude`/`combineTap` (fold
into the dest field's `[min,max]` per the combine mode + signed/unsigned `magnitude`). An output's
declared `floatField` min/max **is** its modulation-range contract (per-effect param changes like LFO
amplitude are intentionally not reflected).

To surface modulation in the UI, the executor records per modulated input `{value, min, max, neutral}`
(`recordModBand` — samples the lock-step fold over the source range, so web≡native for free) into
`lastModulationData()`. It rides a dedicated `modulationDataDiff` frame channel (cloned from
`pluginStatesDiff`) to `appState.local.engine.modulationData`; sliders read it via
`FieldBinding.getModulation()` and draw a band + neutral-anchored fill.

## Effect development

A sketch is a chain of wasm EFFECTS, not a graph of TS nodes. Effects live in
`native/wasm_modules/<name>/`, declare their parameters through `state::Schema` (which is what the
editor renders and what the executor's port/channel selection reads), and are built per bundle.
Schema conventions that the host depends on:

- `io` bits: 1 = input, 2 = output, 4 = primary. A `texture` field with `io & 2` is what makes an
  effect an image producer (`RegisteredModule::hasTextureOutput`); without one it ticks and
  publishes scalars but renders nothing and passes the image through.
- A float field carrying `magnitude` is a MODULATION CHANNEL; the `io & 4` one is primary. That
  marker drives both the executor's modulation auto-connect and the editor's port picking
  (`web/src/state/schema-channels.ts` — keep the two in lock-step).
- A schema is published once per module TYPE (`module_init` takes no `self`), so anything that
  varies per instance must be a VALUE, not a shape. Mode-dependent field sets declare the union
  and hide the inactive ones; the hidden set is resolved PER INSTANCE by
  `web/src/state/field-visibility.ts` (the `hidden` flags on `plugins[].schema` are only a
  type-level fallback). Variable arity works the same way — a fixed bank plus an `input_count`
  field, as in `mod_math/`. See EFFECTS_STYLE_GUIDE.md.

## Testing

- **Vitest** unit tests: co-located as `*.test.ts` in `web/src/`. Config in `web/vite.config.ts`.
- **Jest+Puppeteer** E2E tests: in `web/test/`. Do not mix Jest/Vitest syntax. GPU e2e point at a running dev server via `GPU_TEST_BASE_URL`.
- **Catch2** native tests: `native/tests/` (e.g. `test_effect_render.cpp` drives effects through `SketchExecutor` and asserts pixels); run via `ctest --test-dir build`.
- E2E tests set up state through `window.appController` / `window.appState` in `page.evaluate()`;
  walk shadow roots to reach anything in the editor. NEVER `import('/src/...')` in a page probe —
  Vite serves a second module instance and you get a different singleton.
- The app picks its surface AT BOOT from the persisted `appMode`; `?playground` / `?barrel` are the
  only ways to force one. Setting `appMode` at runtime does not remount.
- Environment mocks (Canvas, MIDI, AudioContext, Monaco) configured in `src/vitest.setup.ts`.

## Key Pitfalls

- Anything that reads an append index or a "last card" index for the LINEAR list must use
  `linearChainLength()`, never `sketchChain(...).length` — the tail of the chain is the canvas.
- A programmatic scroll write echoes back as a scroll EVENT one frame later, so an "applying" flag
  set and cleared around the assignment never suppresses it; remember the value written instead.
- AudioContext state must be mirrored from main thread to worker via explicit messages — don't trust worker's view
- Nodes with dynamic ports need `shouldRecompileOnConfigChange` returning `true` to trigger topology updates
- Feedback loops use `cycleBreakingPorts` + two-phase execution (`execute` then `consolidate`)
- Native auto-connect (`sketch_augment`) **skips** chain entries lacking `"type":"module"` — a test sketch missing it silently generates no struct/texture rails (effect reads nothing). Web sketches already include it
- After editing effect logic or shaders, rebuild the bundle before testing — both native and web load the built `.wasm`. The barrel loads a COPY inside `NanoBarrel.bundle/Contents/Resources/wasm` — `build_all.sh`/`build_aot.sh` refresh it automatically, but a lone `cd <bundle> && ./build.sh` does not: run `wasm_modules/refresh_barrel.sh` (or `cmake --build build`) before testing in Resolume
- Rewriting a GPU **buffer** a dispatch already read this frame is safe on both platforms (the backend versions the backing buffer; each dispatch sees the latest write preceding its encode) — but rewriting a **texture** in that position is last-write-wins and only logs a warning: upload to a fresh texture instead. Never rely on effect-called `gpu::Device::submit()` for ordering — it's a no-op inside the native frame batch (a real flush on web)
