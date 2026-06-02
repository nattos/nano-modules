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
| `InteropTexture.{h,m}` | CVPixelBuffer-backed GL↔Metal texture pair. Copied from `streaky_blobs/`; the same code in two places lets the two plugins evolve independently. |
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
under `com.nattos.nanobarrel@0`, with this initial state shape:

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

## Effect registration — manifest-driven (automatic)

`initEffectRuntime()` (called from the ctor) bootstraps:

1. `MTLCreateSystemDefaultDevice()`, `gpu::createMetalBackend()`,
   `effect_runtime::EffectRuntime`, `ModuleRegistry`.
2. `nano_barrel_gen::registerAllBarrelEffects(rt, registry)` — generated
   code that, per effect, registers its shader MSL then its type.
3. `SketchExecutor` constructed against the runtime + registry + GPUBackend.

The effect set is **not hand-maintained here**. `effects_native/barrel_manifest.txt`
is the source of truth (one line per effect: bundle, namespace, id, display,
abi, shaders). At build time `gen_barrel_effects.py` (a CMake custom command)
reads it and emits, into `build/tmp/`:

- `<effect>_msl.h` — SPV→MSL (spirv-cross) for each shader the effect declares;
- `barrel_effects.gen.h` — namespace forward-decls + `registerAllBarrelEffects`,
  which registers each effect's shader MSL immediately before registering the
  effect. That **interleaving** is why effects can share bare shader names like
  `compute`/`pixel`: each effect's PSO is compiled from its own MSL during
  `module_init` (run synchronously inside `registerEffect`) before the next
  effect overwrites the global MSL-name slot.

CMake also derives the `effects_native` source list from the manifest
(`wasm_modules/<namespace>/*.cpp`).

**To add an effect to the barrel:** add one manifest line (after its WASM
bundle's `build.sh` has produced the effect's `.spv` under `build/tmp/`), then
rebuild. No edits to this plugin or CMake.

`abi` is `instance` (class-like: `module_init`/`create`/`destroy` + self-taking
lifecycle — each chain entry gets its own per-instance state via
`EffectRuntime::instanceFor`, so multiple entries render independently) or
`legacy` (old free-function effect, adapted by a generated native trampoline —
file-static state, so correct only single-instance in a native chain; convert
to the instance ABI for true per-instance behaviour).

**Helper-class shaders.** Effects whose shaders live in a shared helper header
(`fx::GaussianBlur` → `effect_blur.h`, `fx::FastBlur` → `effect_fast_blur.h`)
register shader names from inside the helper, not from the effect's `main.cpp`.
The manifest bootstrap only scans `main.cpp`, so those shaders must be added to
the manifest by hand — list the names the helper passes to
`registerShaderSPV` (e.g. `video.blur` → `blur_compute=compute`; `video.fast_blur`
→ `fast_blur_down=down,fast_blur_up=up`). `video.blur` / `video.fast_blur` are
wired this way and render correctly.

Render-pass effects work: the Metal backend implements instanced render
pipelines (`createInstancedRenderPSO` with alpha-over / additive blend),
load-action render passes (`beginRenderPassLoad`), and stage-unified render
buffer binding (`renderSetBuffer`). `video.flash_particles` (compute particle
sim + instanced raster) renders natively.

**Known gaps** (effect registers + appears in the inspector, but won't render
correctly until the native host gains the missing pieces — all degrade
gracefully to passthrough/black, no crashes):
- Multi-render-target effects: `begin_render_pass_mrt` /
  `create_instanced_render_pso_mrt_layout` are still stubs (no cared-about
  bundle effect needs MRT today).
- Canvas-overlay effects (e.g. `sequencer.nanolooper`): the `canvas_*` host
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

- **Legacy effects not yet on the instance ABI** keep file-static state, which
  only the sandboxed WASM path makes per-instance — they must be converted to
  the class-like instance ABI before being used multiple times in a native
  barrel chain. The three currently-registered effects are converted.
- **No HTTP-serve of the editor JS bundle.** The editor is hosted
  elsewhere; the user opens
  `http://localhost:5173/resolume/?barrel=ws://localhost:<port>` to
  connect.
- **Static effect link.** Effects are statically linked from
  `effects_native`. WASM loading from inside the plugin is doable
  later but not v0.
- **Macros are not yet routed by the executor.** They're persisted to
  bridge state; the editor handles mapping to sketch fields. The
  executor honors whatever state the editor mirrors.
