# NanoBarrel — sketch-hosting FFGL plugin

A single FFGL bundle that:

- **Persists a sketch graph + a stable instance UUID** as a single
  `FF_TYPE_FILE` parameter on the Resolume composition (no sidecar files;
  round-trips up to 16 MB — see probes 1–3 history under
  `~/Library/Logs/NanoProbe*/` and `~/Library/Logs/NanoBarrel/`). The param
  value is a wrapped `{"uuid":..,"sketch":..}` envelope.
- **Registers with the shared in-process server** (`libbridge_server.dylib`,
  located via `dladdr` next to the bundle and `dlopen`'d through
  `BridgeLoader` at `InitGL`). That singleton owns the ONE WebSocket server
  (fixed port **8081**) and the ONE unified state document — every NanoBarrel
  instance in the process is multiplexed under `/plugins/<key>/state`, where
  `<key>` is this instance's persisted UUID. The web editor connects to the
  single port, enumerates instances from `/global/plugins`, and picks one.
  Re-uses the existing `bridge_core` JSON-patch protocol.
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
| `nano_barrel_plugin.cpp` | The `CFFGLPlugin` subclass + all FFGL/GL glue. Platform-neutral: it names no graphics API of its own. |
| `barrel_codec.h` | Header-only base64 + the `nanobarrel://config?<base64>` wrapper format the FILE param uses. |
| `barrel_log.h` | `BARREL_LOG(event, fmt, ...)` macro. Writes to the platform log dir as `run-<pid>-<ms>.log`, plus `os_log` subsystem `com.nano.NanoBarrel` (macOS) / `OutputDebugString` (Windows). |
| `interop_texture.h` | The seam: one texture both the host's GL and the engine's graphics API can see. `ffgl_runner` and `benchmark_barrel` build against the same interface. |
| `interop_texture_metal.mm` | CVPixelBuffer/IOSurface backed. Sharing is implicit, so `lockForGL`/`unlockForGL` are no-ops. |
| `interop_texture_d3d11.cpp` | `WGL_NV_DX_interop2`. Sharing is explicit — GL only while locked, D3D only while not. **The one untested file in the port** (see below). |
| `interop_texture_desc_d3d11.h` | The D3D11 descriptor, shared with the test harness so the two cannot drift. |
| `Info.plist.in` (via parent dir) | Boilerplate bundle metadata. |

## Parameter layout (always 17)

| Idx | Name | Type | Purpose |
|---|---|---|---|
| 0 | `config` | `FF_TYPE_FILE` | `nanobarrel://config?<base64>` of a `{"uuid":..,"sketch":..}` envelope, persisted by Resolume |
| 1..16 | `macro_00..macro_15` | `FF_TYPE_STANDARD` | 16 user-mappable floats |

(The old `port` text param is gone — there's a single shared server on 8081.)

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

No per-instance server. At `InitGL` the barrel locates `libbridge_server.dylib`
next to its bundle (`dladdr` → sibling path), `dlopen`s it via `BridgeLoader`,
and `bridge_init()` (acquire) the ref-counted singleton — the first instance in
the process spins up the ONE `WsServer` (fixed port **8081**), the ONE
`BridgeCore`/`StateDocument`, and the server's own pump thread; the last
instance to `bridge_release()` tears them down. Acquisition is in `InitGL`, NOT
the ctor (the host constructs throwaway prototype instances during its param
scan, which must not start a server).

The barrel registers itself via `bridge_register_plugin(requested_key=<uuid>)`
and uses the returned key (the server remints on collision — duplicated clips
carrying the same persisted UUID get a unique derivative the barrel re-persists)
as `barrel_plugin_key_`, with this initial state shape:

```jsonc
{
  "sketch":   { "anchor": null, "columns": [{"name": "Column 1", "chain": []}] },
  "macros":   [0.0, 0.0, /* … 16 floats … */],
  "triggers": {},
  "host":     {}     // populated when SetHostInfo arrives ("Resolume Arena", "7.23.2 51094")
}
```

State document mutations from the editor (`{action:"patch", target:"/plugins/<key>/state", ops:[...]}`)
fire this instance's per-key patch listener (`onPatchTrampoline`, registered via
`bridge_register_patch_listener` — invoked on the shared server's pump thread, so
it only flips atomics), which sets `dirty_=true` and timestamps `dirty_since_ms_`.
After 200 ms of quiet the plugin re-encodes the `{uuid,sketch}` envelope as
`nanobarrel://config?<base64>` and raises `FF_EVENT_FLAG_VALUE` on the FILE param
so Resolume persists it. (Probe 3 established that 200 ms is below the threshold
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

1. `gpu::createBackend()` (Metal or D3D11), `effect_runtime::EffectRuntime`,
   `ModuleRegistry`. The plugin then asks the runtime for that backend's OWN
   device (`bridge_rt_gpu_device`) to build its interop pair against — not a
   second device made the same way, which on D3D11 would be a different device
   and therefore useless.
2. `sketch_executor::WasmEffectBundles` — `init()` brings up the (refcounted,
   process-global) WAMR runtime + registers the host-import namespaces, then
   `loadBundleFile(...)` loads each bundle from the **shared resource root**'s
   `wasm/` (see below): **`core`, `lights`, `nano`, `text`, `richtext`,
   `legacy`**. Each bundle's
   `nano_module_main` runs, registering every effect it carries into the
   `ModuleRegistry` (schema publish + SPV -> MSL/HLSL translation + PSO build,
   on the real backend). There is **no static fallback** — a load failure means
   a broken install and is logged.
3. `effect_runtime::textInstallDefaultFonts(...)` — fonts are a host concern (see
   *Text effects* below).
4. `SketchExecutor` constructed against the runtime + registry + GPUBackend. The
   executor itself runs **native in-process** here (it is NOT WASM on the
   barrel — only the *effects* are; see `../../sketch/README.md` for why).

**Per-arch AOT sidecar.** When a `<bundle>-<arch>.aot` sits next to the `.wasm`
(produced at build time by `wasm_modules/build_aot.sh` via
`wamrc`, gated on `NANO_WASM_AOT`), the loader prefers it — it runs at ~native
speed. The portable `.wasm` is always the floor and the graceful fallback; AOT is
an optional per-platform speed bonus (nothing ships per-user beyond the small
`.aot` files). Text effects are the CPU-heavy case that benefits most.

**Schemas reach the editor independently of the bridge doc.** The WASM modules
are deliberately given a NULL state document — a WASM effect's `state.set_val`
would otherwise write to the shared doc on the *render* thread every frame
(diff under the doc mutex), needless contention with the server's pump thread.
Schemas still publish: the barrel sends them from `registry_->schemas()` (parsed
off each `EffectInstance` via the host sink), independent of the doc.

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

### Where the WASM and fonts come from — the shared resource root

The barrel used to carry its own copy of every bundle inside
`Contents/Resources/wasm/`. It doesn't any more. One directory now serves both
the plugin and the Electron app:

```
<root>/nano-resources.json     marker; both halves look for it
<root>/app/                    the built web app  (Electron only)
<root>/wasm/*.wasm             effect bundles     (both)
<root>/wasm/*-<arch>.aot       AOT sidecars       (native only)
<root>/fonts/default.ttf       primary text face  (native only; the web app
                               carries its own copy inside app/)
<root>/ffgl/NanoBarrel.bundle          this plugin
<root>/ffgl/libbridge_server.dylib     its SIBLING — see "Bridge wiring"
```

In a dev tree `<root>` is the repo's `build/`, which is exactly where
`wasm_modules/build_all.sh` already writes. In a release it is
`Nano Modules.app/Contents/Resources/nano/`.

**Why bother:** a copy inside the bundle had to be re-deployed *and re-signed*
every time an effect was rebuilt, because any write into `Contents/Resources`
after `codesign` breaks the ad-hoc seal and Resolume then refuses the load.
That forgotten step is what `wasm_modules/refresh_barrel.sh` exists to paper
over. With the payload outside, rebuilding an effect can't invalidate anything,
and 60 MB is stored once instead of twice.

**Resolution order** (`src/platform/resource_root.h`), first hit wins, each
candidate checked for an actual `wasm/core.wasm`:

1. `NANO_RESOURCE_ROOT` — explicit; tests, CI and tools.
2. `NANO_BARREL_WASM_DIR` — back-compat. Names the **wasm dir**, not the root.
3. **Walk up from our own loaded image**, looking for the marker at each
   ancestor and at `<ancestor>/build`. Finds the dev tree and an in-app plugin
   alike, with nothing configured.
4. The legacy in-bundle `Contents/Resources` — so an old deployment still runs.
5. The Electron app's install record,
   `~/Library/Application Support/NanoBarrel/electron_app.json`
   (`%APPDATA%\NanoBarrel\` on Windows), written on every app launch.

**Step 5 is last on purpose.** `tools/barrel_host_portability.sh` (a registered
ctest) and `tools/soak_test.py` run the dev-built bundle with no env override
and inherit whatever the plugin resolves. If an installed app outranked the
image-relative walk, a dev-tree test run would load a *released* app's effects
and report a pass against code that was never built here. That ordering is
pinned by `tests/test_resource_root.cpp`, and verified against a real installed
app rather than a synthetic one.

The record only matters when the plugin has been **copied out** of the app into
a host's own plug-ins folder — the normal Resolume setup — at which point there
is no app above it to walk up to.

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

## Running outside Resolume

Nothing in the render path needs Resolume. `tools/ffgl_runner.mm` is a plain
FFGL host and drives the whole stack — effects, bridge server, web editor —
with no Arena running and nothing on Resolume's API port. `ctest -R
barrel_host_portability` (`tools/barrel_host_portability.sh`) is the regression
gate; run it after touching anything in `ProcessOpenGL`.

Two things FFGL leaves to the host that the barrel has to cope with itself:

| | What FFGL says | What the barrel does |
|---|---|---|
| **Input texture target** | Nothing — `FFGLTextureStruct` has no target field | Attaches and checks FBO completeness, `GL_TEXTURE_RECTANGLE` (Resolume/IOSurface on macOS) or `GL_TEXTURE_2D` (most others), caching the answer. See `attachHostInput`. |
| **`SetTime` / `SetBeatInfo`** | Both optional | Tracks whether either ever arrived; falls back to a local monotonic clock and a free-running barPhase at `hostBpm`. A host with no transport loses SYNC, not motion. |

### What Resolume's API adds (and what its absence costs)

Separately from hosting, the shared dylib opens a WebSocket CLIENT to Resolume's
own API (`ws://127.0.0.1:8080/api/v1`, override with `NANO_RESOLUME_URL`). That
is a different thing from the barrel's own server on 8081, and it is the
connection that goes away both in a third-party host AND when Arena's webserver
is switched off in preferences. It never blocks: `ix::WebSocket` retries on its
own thread, `poll()` returns nothing, and every writer is guarded.

What stops working, none of it in the render path:

- **Instance names and placement.** `InstanceLocator`'s composition scan is what
  resolves "Layer 3 / Clip 2"; without it `/global/composition_barrel_ids` is
  never published and the editor labels instances by their UUID prefix.
- **Placeholder cards** for composition members that haven't been launched.
- **Clip launching** from trigger rails, and **channel reassignment**.
- **Copy-paste fork detection.** Duplicated clips carrying the same persisted
  UUID still get a unique key — the server remints on collision — they just
  aren't proactively forked.

The dylib publishes the state of that client at
`/global/host/server.resolumeConnected`, change-gated, alongside its own image
path, the bridge port and the resource root it resolved. Everything above
degrades SILENTLY, so without the flag the editor could not tell "Resolume
isn't running" from "Resolume is running with its webserver off" — the
Settings-tab setup checklist is the consumer. The FFGL plugin writes the
sibling `/global/host/plugin` (its `.bundle` path + resolved root) once, at
load, from the ctor/prototype pass — before any clip is launched, so the
checklist can answer "is Resolume loading the plugin that shipped with this
app?" with no live instance.

### The other host-portability question: does it persist?

The sketch lives in parameter 0, an `FF_TYPE_FILE` the host is expected to save
and restore via `SetTextParameter`/`GetTextParameter`. Whether a given host
actually round-trips a FILE param through its project file is a host capability,
not something this plugin can arrange. In a host that doesn't, the barrel comes
up with an empty sketch and whatever the editor authors lives only in the bridge
document for that session.

## Known limitations / future work

- **No HTTP-serve of the editor JS bundle.** The editor is hosted
  elsewhere; the user opens `http://localhost:5173/resolume/` (which connects
  to the shared server on `ws://localhost:8081` by default; `?barrel=ws://host:port`
  remains an optional override) and picks an instance from the Organize tab.
- **Executor runs native in-process, not as WASM.** Only the *effects* are WASM
  here. The per-frame executor loop is CPU-heavy and WAMR interp was measured
  28–46× too slow; the same source still compiles to `executor.wasm` for the web
  host. See `../../sketch/README.md`.
- **Macros are not yet routed by the executor.** They're persisted to
  bridge state; the editor handles mapping to sketch fields. The
  executor honors whatever state the editor mirrors.

## Windows

The plugin is the same source. FFGL on Windows is a plain `NanoBarrel.dll`
exporting `plugMain`, so the entire `.bundle` / `Info.plist` / codesign / deploy
apparatus simply does not exist there; the DLL goes into Resolume's FFGL folder
beside ONE copy of `libbridge_server.dll`, for the same reason the bundle sits
beside one copy of the dylib — same path, same image, one shared singleton.

What is proven, under CrossOver:

* `libbridge_server.dll` builds and runs — 151 effects across six bundles, a
  D3D11 device at feature level 11_1, the WS server and its preview lanes.
* `test_bridge_loader` loads it by hand and binds all 36 ABI symbols.
* `test_barrel_render` drives the exact per-frame entry the plugin drives
  (`bridge_executor_render`) with textures made from the interop's own
  descriptor, and checks the pixels that come back.

What is **not** proven, and cannot be here: the share itself.
`wglDXOpenDeviceNV` needs one driver behind both OpenGL and D3D11, and
CrossOver's are two separate translation layers over Metal. The first run on
real hardware is where `interop_texture_d3d11.cpp` gets its first real
execution; its header comment lists what to check.

Not ported: `ffgl_runner` and `benchmark_barrel`. Both exist to drive the plugin
through a real GL context, which is the part CrossOver cannot do.
