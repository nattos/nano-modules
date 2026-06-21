# NanoBarrel — sketch-hosting FFGL plugin

A single FFGL bundle that:

- **Persists a sketch graph** as a single `FF_TYPE_FILE` parameter on the
  Resolume composition (no sidecar files; round-trips up to 16 MB —
  see probes 1–3 history under `~/Library/Logs/NanoProbe*/` and
  `~/Library/Logs/NanoBarrel/`).
- **Hosts a per-instance WebSocket bridge** on an auto-allocated port
  so the web sketch editor can connect, observe state, and push
  patches. Re-uses the existing `bridge_core` JSON-patch protocol.
- **Runs the sketch's effects every frame** through the shared
  `sketch_executor` library, blitting Resolume's GL input texture
  through GL↔Metal interop into the executor's Metal pipeline and
  blitting the result back to Resolume's output FBO.
- **Exposes 16 generic macro params** (`macro_00..macro_15`) that the
  editor maps to specific sketch fields. Macros published to the
  bridge state at `/plugins/<key>/state/macros/<i>`; up-edge crossings
  (`<0.5 → ≥0.5`) publish a sequence counter at
  `/state/triggers/macro_<i>`.

## Files

| Path | Role |
|---|---|
| `nano_barrel_plugin.mm` | The `CFFGLPlugin` subclass + all FFGL/Metal interop glue. ~700 lines now that the executor was extracted. |
| `barrel_codec.h` | Header-only base64 + the `nanobarrel://config?<base64>` wrapper format the FILE param uses. |
| `barrel_log.h` | `BARREL_LOG(event, fmt, ...)` macro. Writes to `~/Library/Logs/NanoBarrel/run-<pid>-<ms>.log` and `os_log` subsystem `com.nano.NanoBarrel`. |
| `InteropTexture.{h,m}` | CVPixelBuffer-backed GL↔Metal texture pair. The canonical copy — `ffgl_runner` (the headless host) borrows this same source. |
| `Info.plist.in` (via parent dir) | Boilerplate bundle metadata. |

## Parameter layout (always 18)

| Idx | Name | Type | Purpose |
|---|---|---|---|
| 0 | `config` | `FF_TYPE_FILE` | `nanobarrel://config?<base64>` — the whole sketch JSON, persisted by Resolume |
| 1 | `port` | `FF_TYPE_TEXT` | The WS port the bridge bound, for the editor to read |
| 2..17 | `macro_00..macro_15` | `FF_TYPE_STANDARD` | 16 user-mappable floats |

Why 16 fixed macros instead of dynamic registration per effect param:
probe 1 confirmed Resolume only re-scans the param surface on plugin
discovery and on `delete + undo` of an effect instance. Live
registration of new params via `SetParamInfo` is silently ignored.
16-macro slot pool keeps the FFGL param surface stable; the editor
handles the per-effect mapping.

## Frame body

```
ProcessOpenGL:
  bridge_core_.tick()                              // broadcast pending patches to subscribers
  maybeRegenerateConfig()                          // 200ms debounce → RaiseParamEvent on FILE
  if no input texture: drawBadgeOnly; return

  ensureInterop(inW, inH, outW, outH)              // recreate Interops on viewport changes
  blitGlInputToInterop(host GL tex → input MTL tex)  // glBlitFramebuffer; zero shader work

  inputHandle  = gpu_->adoptExternalTexture(input_interop  → MTLTexture)
  outputHandle = gpu_->adoptExternalTexture(output_interop → MTLTexture)

  effect_runtime::setHostTime/DeltaTime/Viewport
  sketch_json = bridge_core_.state_document().get_at("/plugins/<key>/state/sketch")
  finalHandle = executor_->execute(sketch_json, inputHandle, outputHandle, W, H, dt)

  gpu_->submit()                                   // commit the pending Metal command buffer
  rt_->drainConsoleLog()
  gpu_->release(inputHandle); gpu_->release(outputHandle)  // adopted, not owned

  blitInteropToGlOutput(finalHandle == outputHandle)  // Y-flip; either output or input interop
  drawBadgeOnly()                                  // green corner badge
```

Everything between `adoptExternalTexture` and `release` is the shared
executor's domain; this file's job is the I/O around it.

## Bridge wiring

One `BridgeCore` + one `WsServer` per FFGL instance, both created in
the ctor. The WS server binds the first available port starting at
9090 (per-process counter, retries up to 100). The bound port is
written back to `port_str_` and surfaced via `RaiseParamEvent(P_PORT,
FF_EVENT_FLAG_VALUE)` so the editor can read it.

The barrel registers itself as a plugin in the bridge's state document
under `com.nano.nanobarrel@0`, with this initial state shape:

```jsonc
{
  "sketch":   { "anchor": null, "columns": [{"name": "Column 1", "chain": []}] },
  "macros":   [0.0, 0.0, /* … 16 floats … */],
  "triggers": {},
  "host":     {}     // populated when SetHostInfo arrives ("Resolume Arena", "7.23.2 51094")
}
```

State document mutations from the editor (`{action:"patch", target:"/plugins/<key>/state", ops:[...]}`)
trigger the `BridgeCore`'s `client_patch_callback`, which sets
`dirty_=true` and timestamps `dirty_since_ms_`. After 200 ms of quiet
the plugin re-encodes the sketch as `nanobarrel://config?<base64>` and
raises `FF_EVENT_FLAG_VALUE` on the FILE param so Resolume persists
the value. (Probe 3 established that 200 ms is below the threshold
that makes Resolume's inspector chug on FILE param mutations.)

A process-wide static `g_cache_blob()` holds the latest sketch JSON
so the editor's `delete + undo` workflow — which destroys and
recreates the plugin instance to refresh Resolume's param surface —
can repopulate the bridge state in the new instance's ctor before the
host's restored `SetTextParameter` fires.

## Effect loading — WASM bundles (no static linking)

Effects are **never statically linked** into this plugin. Each effect compiles
once to a `.wasm` bundle (the *same* artifact the web app loads) and the barrel
loads those bundles at startup through WAMR.

`initEffectRuntime()` (called from the ctor) bootstraps:

1. `MTLCreateSystemDefaultDevice()`, `gpu::createMetalBackend()`,
   `effect_runtime::EffectRuntime`, `ModuleRegistry`.
2. `sketch_executor::WasmEffectBundles` — `init()` brings up the (refcounted,
   process-global) WAMR runtime + registers the host-import namespaces, then
   `loadBundleFile(...)` loads each bundle from `Contents/Resources/wasm/`:
   **`core`, `lights`, `nano`, `text`, `richtext`**. Each bundle's
   `nano_module_main` runs, registering every effect it carries into the
   `ModuleRegistry` (schema publish + SPV→MSL shader compile + PSO build, on the
   real Metal backend). There is **no static fallback** — a load failure means a
   broken install and is logged.
3. `effect_runtime::textInstallDefaultFonts(...)` — fonts are a host concern (see
   *Text effects* below).
4. `SketchExecutor` constructed against the runtime + registry + GPUBackend. The
   executor itself runs **native in-process** here (it is NOT WASM on the
   barrel — only the *effects* are; see `../../sketch/README.md` for why).

**Per-arch AOT sidecar.** When a `<bundle>-<arch>.aot` sits next to the `.wasm`
in `Resources/wasm/` (produced at build time by `wasm_modules/build_aot.sh` via
`wamrc`, gated on `NANO_WASM_AOT`), the loader prefers it — it runs at ~native
speed. The portable `.wasm` is always the floor and the graceful fallback; AOT is
an optional per-platform speed bonus (nothing ships per-user beyond the small
`.aot` files). Text effects are the CPU-heavy case that benefits most.

**Schemas reach the editor independently of the bridge doc.** The WASM modules
are deliberately given a NULL state document — a WASM effect's `state.set_val`
would otherwise write to the doc on the *render* thread (diff under the doc
mutex), deadlocking against the WS thread on a sketch change
(`tick_mu_` → doc mutex → `WsServer` → `tick_mu_`). Schemas still publish: the
barrel sends them from `registry_->schemas()` (parsed off each `EffectInstance`
via the host sink), independent of the doc.

**To add an effect:** write the WASM module under `wasm_modules/<name>/`, add it
to a bundle's `build.sh`, rebuild that bundle (and optionally re-run
`build_aot.sh`). No edits to this plugin or its CMake target — the bundle's
`nano_module_main` registers it automatically on load.

Per-instance state: each chain entry gets its own `EffectInstance`
(`create()`-allocated `State` + uniform buffer) via
`EffectRuntime::instanceFor(type, key)`, so multiple entries of the same effect
render independently. An effect that exposes `is_identity()` is skipped (input
aliased to output, dropped from any fused group) when it reports a pure
passthrough — see EFFECTS_STYLE_GUIDE.md.

### Text effects

`source.text.plain` / `source.text.rich` load from `text.wasm` / `richtext.wasm` like any
other effect — they are **not** special-cased or statically linked. Their
`text.*` imports (layout/measure/render/atlas/glyphs/release) resolve to the
native `TextEngine` (FreeType + msdfgen + Blitz) through the **"text" WAMR
bridge** registered by `WasmEffectBundles::init` → `registerTextHostFunctions`
(`src/sketch/text_host_wasm.cpp`). The engine needs font BYTES, installed
host-side via `textInstallDefaultFonts(bundleFontPath("default.ttf"))` — the
parity-exact Latin primary (falling back to the system UI font), plus the OS's
CJK faces as the fallback chain. No MSL shaders: the text.* service owns its MSDF
compositor PSO.

### What works

Render-pass effects render natively: the Metal backend implements instanced
render pipelines (`createInstancedRenderPSO` with alpha-over / additive blend),
load-action passes (`beginRenderPassLoad`), stage-unified render buffer binding
(`renderSetBuffer`), and multi-render-target pipelines + passes
(`createInstancedRenderPSOMRT` / `beginRenderPassMRT`, up to 8 attachments).
`source.particles.flash_particles` (compute particle sim + instanced raster) renders. GPU
fusion of adjacent compute stages works across the WASM ABI (effects register SPV
fragments by name; the host runs SPV→MSL fused codegen).

**Known gap** (effect registers + appears in the inspector, but won't render
correctly natively — degrades gracefully to passthrough/black, no crashes):
- Canvas-overlay effects (e.g. `control.nanolooper`): the `canvas_*` host
  imports are no-ops natively (a debug surface — intentionally deferred).

## Macros

`SetFloatParameter(P_MACRO_00 + i, value)`:

1. Lock `tick_mu_`, store `macros_[i] = value`.
2. If `macros_prev_[i] < 0.5 && value >= 0.5`: increment
   `trigger_seq_`, write `/state/triggers/macro_<i>` ←
   `trigger_seq_`.
3. Write `/state/macros/<i>` ← value.

The editor observes those paths and applies them to sketch fields via
its own mapping. The macros are *not* currently routed by the
sketch_executor — that's an editor-side decision that ends up in the
sketch's instance state, which the executor *does* honor each frame.

## State and threading

The plugin holds one mutex (`tick_mu_`) guarding all
`bridge_core_`, `bridge_core_.state_document()`, and dirty-tracking
reads/writes. The WS server's message + disconnect callbacks acquire
it before calling into `bridge_core_`. `ProcessOpenGL` acquires it
to read the sketch out of the state document before handing off to
the executor.

The executor itself is **not** thread-safe — the plugin only ever
calls `executor_->execute(...)` from `ProcessOpenGL` on FFGL's render
thread, so this isn't an issue today. If a future host runs effects
off-thread, the host owns the serialization.

## Logging

Lifecycle events log to `~/Library/Logs/NanoBarrel/run-<pid>-<ms>.log`
and `os_log` (subsystem `com.nano.NanoBarrel`). Per-frame diagnostic
logs were used during bring-up and have been removed. Re-add ad-hoc
`BARREL_LOG` calls during debugging; library code (`sketch_augment`,
`sketch_executor`, `module_registry`) is silent by design.

## Known limitations / future work

- **No HTTP-serve of the editor JS bundle.** The editor is hosted
  elsewhere; the user opens
  `http://localhost:5173/resolume/?barrel=ws://localhost:<port>` to
  connect.
- **Executor runs native in-process, not as WASM.** Only the *effects* are WASM
  here. The per-frame executor loop is CPU-heavy and WAMR interp was measured
  28–46× too slow; the same source still compiles to `executor.wasm` for the web
  host. See `../../sketch/README.md`.
- **Macros are not yet routed by the executor.** They're persisted to
  bridge state; the editor handles mapping to sketch fields. The
  executor honors whatever state the editor mirrors.
