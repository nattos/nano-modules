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

**The extras live in another repo.** The `nano`, `lights` and `legacy` bundles (and `control.nanolooper`
+ the NanoLooper FFGL plugin) are in [nano-modules-extras](https://github.com/nattos/nano-modules-extras),
checked out beside this repo. Nothing here finds it implicitly — pass it explicitly:

```bash
native/wasm_modules/build_all.sh --extras ../nano-modules-extras        # builds them via the SDK into build/wasm
cmake -S native -B native/build -DNANO_EXTRAS_DIR=../nano-modules-extras  # NanoLooper + their native tests (path: absolute or repo-root-relative)
NANO_EXTRAS_DIR=../../nano-modules-extras npx jest <name>                # their web suites, on this harness (from web/)
npm run package:remote:mac -- --extras ../../nano-modules-extras          # packaging REQUIRES --extras or --no-extras
```

Our own coverage must never depend on them: every host import any bundle calls must be exercised by
an in-repo bundle — `native/tools/abi_coverage.py` checks, and `debug.raster_test` /
`debug.compute_probe` / `debug.trigger_probe` (testonly) exist for the paths only the extras used.

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

The **Effects** tab (`views/effect-store/`) is a full-takeover catalog of every effect. It renders
thumbnails and hover previews on its OWN engine worker (`preview/preview-engine.ts` — in Remote
Control the editor's worker renders nothing), from each effect's optional preview scenario
(`include/preview_scenario.h` → `preview/scenario.ts`); `state/effect-store-controller.ts` owns
Use / Preview (hot swap) and the breadcrumb from the type editor's Browse…. `npm run thumbs`
(`scripts/bake-thumbs.mjs` → `public/thumb-runner.html`) runs that same bake headless and writes the
thumbnails plus a flagging contact sheet to disk.

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
`.wasm` files (core/testonly/text/richtext here; nano/lights/legacy from the extras) loaded via WAMR on native and in-browser on
web. The web build serves the **same** `build/wasm/*.wasm` files, so rebuild bundles
(`native/wasm_modules/build_all.sh`) before running web e2e — a stale bundle is a common false failure.

### The arrangement's two engines

The arrangement's composition executor (`comp::CompExecutor`) runs either in the browser worker
(`ArrEngine`) or in a native **`nano_compositor`** process (`native/tools/nano_compositor.cpp`),
behind one seam: `views/arrangement/engine/comp-engine.ts`. The native one is a comp instance on
the shared runtime (`BarrelRuntime::createComp`, driven by `bridge/comp_host.h` — the same host
`comp_test_runner` uses), reached over the bridge WebSocket exactly as Remote Control reaches a
NanoBarrel: `comp_*` actions in, NBCJ `comp_report`s + NBPS/NBPV previews out
(`remote-comp-engine.ts`). `?compositor=ws://…` or, in the desktop app, `?engine=native` /
`NANO_ARRANGEMENT_ENGINE=native` selects it (`engine-select.ts`, `electron/compositor.cjs`).
Arrangement UI suites run on both through `test/comp-backend.ts` (`forEachCompBackend`; build
`nano_compositor` first); tests read the monitor through `engineBridge.sampleComposite`
(`test/arr-test-helpers.ts`), never the canvas.
`COMPOSITOR.md` maps what is built (decode pump, namespacing, native export) and holds the
roadmap: M3 outputs, M4 Windows, M5 remote, and the devices push (D1 MIDI shipped; lights, displays).

The WHOLE composition folds into ONE executor sketch (`native/src/sketch/comp/sketch_build.h`, the
only implementation — its existing output is pinned byte-for-byte by the `build*.json` goldens).
**Composition I/O** rides on that: `Composition.routes` connect track PORTS and texture fields
(ports are hubs — every route has a port end; `routeIsLegal` in both `composition.ts` and
`sketch_build.h`), and the builder resolves them into plain texture wires at the END of the build;
the executor delays any back edge by one frame on its own. A routed `__in__` enters a chain through a
`composite.blend` RELAY with BOTH slots wired (it no-ops with either unbound). `output.mode 'none'`
(send nowhere) renders a track without compositing it, which leaves the executor's column cursor on
the hidden track — `ensureCursor` re-emits the stack before anything that reads the cursor, and at
the end (the sketch's image is its LAST linear stage). A timeline track with NO clips is a
**clipless layer**: its own sketch is its content. UI: I/O mode (`store.ioMode`) swaps header
faders for `<arr-io-strip>` ports; routes are drawn by `arr-overlay` to the inspector's field
hit-boxes (the inspector registers the lookup — there are no field anchors otherwise).

**Devices** (the devices push): the arrangement's main area switches between the timeline and the
Devices panel — Remote Control's own `<devices-tab>`, mounted over a `DevicesHost`
(`views/devices/devices-host.ts`: sketches, wire edits, W mode, the gesture machine, filters; the
editor's host is `editor-devices-host.ts`, the arrangement's `state/arr-devices-host.ts`). Both views
stay MOUNTED (the inactive one `visibility: hidden`) so a wire dragged across the `Timeline | Devices`
switch keeps its source; mid-gesture, hovering the switch flips the view. A MIDI control wire is an
ordinary sketch wire from `midi:<uuid>` and works with or without a placement — `Composition.devices`
(`DevicePlacement`) only puts a device on the timeline as a row. `CompExecutor::setExternalScalars` /
`setInjectedScalars` carry the values (the injected table is keyed by the BUILT sketch's bare keys,
never namespaced). The worker engine gets the table `midiController` lowers from the COMPOSITION's
sketches (`state/arr-midi.ts`); the native compositor reads CoreMIDI itself and only takes the
library + on-screen simulation over the bridge (`CompEngine.mirrorMidi`). **Lights** (D2): a library
of types, rigs and networks (`web/src/lights/`, `light-devices.json`; a rig slot = type + Art-Net
address, whose network picks the interface and patches the destination on site) placed
per show (`DevicePlacement` kind `light`, per-slot layout; a route `{kind:'device'}` from an out port
picks what it samples, else the main output). The page resolves them into a flat plan
(`light-plan.ts` → `comp_lights`); the NATIVE compositor maps (`lights/light_map.h`, CompHost's
`LightRunner`) and transmits (`artnet/artnet_sender`, 40 Hz) — the worker engine can't (no UDP).
Tests redirect every light's DMX to loopback with `NANO_ARTNET_REDIRECT`; never let one reach the LAN.
**Displays** (D3): portable slots (`display.<n>`, `web/src/displays/`) placed per show (kind `display`,
`fit`; routes as for lights — `deviceSources`); which screen fills a slot is this machine's
(`display-devices.json`: a CGDisplay UUID, automatic = the Nth NON-main screen, or a rehearsal
window). The page sends the plan (`comp_displays`); CompHost's `DisplayRunner` presents
(`GPUBackend::presentScaled`) onto surfaces the compositor PROCESS provides
(`native/tools/compositor/display_windows_mac.mm`, via `bridge_comp_set_display_provider` — never
AppKit in the dylib). `nano_compositor`'s render thread owns the runtime (WAMR: wasm runs only on the
thread that brought it up) and the main thread owns the windows. Tests never open a window:
`NANO_DISPLAY_REDIRECT=offscreen` + `NANO_FAKE_SCREENS`. A slot's mode can be `syphon`: a Syphon
server in the process, on the VENDORED protocol core (`native/third_party/syphon` → `syphon_core`,
process-only — never the dylib, which Resolume loads beside its own Syphon).

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
was retired (the executor keeps its own raw-MSL path for blend/fusion; that's separate). See
testonly's `particles_renderer/` (and the extras' `flash_particles/` / `flow_swarm/`) for the canonical
instanced-quad-reading-a-storage-buffer template.

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
- After editing effect logic or shaders, rebuild the bundle before testing — both native and web load the built `.wasm`. The barrel loads a COPY inside `NanoBarrel.bundle/Contents/Resources/wasm` — `build_all.sh`/`build_aot.sh` refresh it automatically, but a lone `cd <bundle> && ./build.sh` does not: run `wasm_modules/refresh_barrel.sh` (or `cmake --build build`) before testing in Resolume. A running Resolume keeps what it loaded until an editor sends `reload_modules` (the app offers it on a rebuild; Settings → Resolume has the button) — and it skips an `.aot` older than its `.wasm`, so a reload after a lone `build.sh` runs the INTERPRETED bundle until `build_aot.sh` catches up and you reload again
- Rewriting a GPU **buffer** a dispatch already read this frame is safe on both platforms (the backend versions the backing buffer; each dispatch sees the latest write preceding its encode) — but rewriting a **texture** in that position is last-write-wins and only logs a warning: upload to a fresh texture instead. Never rely on effect-called `gpu::Device::submit()` for ordering — it's a no-op inside the native frame batch (a real flush on web)
- Host imports with more than 7 integer params get their tail args on the stack, and WAMR's 8-byte stack slots disagree with Apple arm64's packed 4-byte ones: declare params 8+ as `int64_t` in `host_functions.cpp` (see the comment there; `register_host_functions()` refuses an unaudited wide import). It failed SILENTLY before — every native blend PSO was alpha-over
- A cbuffer `uint3`/`float3` after a scalar (e.g. `uint count; uint3 _pad;`) isn't 16-byte aligned: naga rejects the shader on web and the effect never initializes. Pad with scalars
