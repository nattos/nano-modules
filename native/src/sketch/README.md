# `native/src/sketch/` — the unified sketch executor

Host-agnostic C++ that turns a sketch JSON graph into rendered pixels. This is
**one executor, two deployments**: the same source compiles to a native static
lib AND to **`executor.wasm`** (built by `native/wasm_modules/executor/build.sh`,
sibling to `bridge_core`). Both the native FFGL barrel and the web browser load
that single binary, so there is exactly one frame-loop implementation — no
TypeScript twin to drift against (the old `web/src/sketch-executor.ts` was
retired; see "The two hosts" below).

| Library | Purpose | Depends on |
|---|---|---|
| `sketch_augment` | Synthesises implicit struct-rail connections so a sketch's chain modules can find their producers' outputs without the user wiring rails by hand. Schema-only logic; no GPU. | `nlohmann_json` |
| `sketch_executor` | Walks the augmented graph one frame at a time, driving effects + GPU purely through two **host-import ABIs** (`effrt.h` for effect lifecycle/params, `exec_gpu.h` for textures/dispatch) + `exec_trace.h` for editor previews. Owns the intermediate texture pool + compiled plan cache. | `sketch_augment`, `nlohmann_json` (+ the host's ABI impls) |

`sketch_executor` no longer depends on `EffectRuntime` / `GPUBackend` /
`ModuleRegistry` directly — those are native types that can't compile to wasm.
Instead it calls a small set of `effrt_*` / `gpu_*` imports the **host** provides
(see the two-hosts section). Both libraries are **silent** (no logging) and
**host-agnostic** (no FFGL, no bridge, no Resolume). The host wraps them.

## The two hosts

The executor is pure orchestration; the host owns the effect instances + GPU
backend and services the `effrt_*` / `gpu_*` imports:

- **Native** — the FFGL barrel runs `SketchExecutor` **native in-process** (the
  same source, compiled to a static lib), driving the Metal `GPUBackend` +
  `EffectRuntime` directly through the `effrt_*` / `gpu_*` impls. This is by
  design, not a fallback: the per-frame executor loop is CPU-heavy and WAMR interp
  was measured 28–46× too slow (and AOT means per-arch artifacts), so on native
  the executor stays compiled-in. `executor.wasm` is still *built* and exercised on
  native by `executor_host.cpp` + `WasmExecutorDriver` (the `test_executor_wasm`
  parity test and `benchmark_barrel --wasm`), which register the same `effrt_*` /
  `gpu_*` WAMR native symbols — but the shipping barrel never loads it. (The
  *effects* the executor drives ARE WASM bundles either way — see
  `../plugin/nano_barrel/README.md`.)
- **Web** — `web/src/executor-host.ts` (`WasmSketchExecutor`) instantiates
  `executor.wasm` and implements the same imports over `WasmHost` (one effect
  instance per chain entry) + `GPUHost` (WebGPU). It is the **sole** web executor:
  `engine-worker.ts` creates one `WasmSketchExecutor` at init and drives every
  frame through it. The web host mirrors each producer's live OUTPUT scalars into
  the sketch's instance state before each `executor_execute`, so the executor's
  float write-taps read them (the native float-output write-tap contract — see
  Constraints).

---

## Why this layer exists

The editor's sketch is a graph of modules connected by columns + rails
+ taps. To render it, three things have to happen:

1. **Augmentation** — modules' structured inputs need rails synthesised
   when the user hasn't explicitly wired one. (eg `motion_blur` reads
   `render_outputs/motion`; `soft_glow` produces it; without a rail
   they're disconnected.) The editor used to do this in
   `web/src/state/controller.ts`; it now lives here so every renderer
   — the FFGL barrel and the **web browser** (both via `executor.wasm`) —
   uses the same logic.
2. **Module-instance lookup** — module_type strings from the sketch
   (`"color.tone.brightness_contrast"`) need to resolve to runtime
   instances of the corresponding effect.
3. **Per-frame walk** — for each column × chain entry: zero stale
   per-field state, apply persisted state, wire primary `tex_in` /
   `tex_out`, route taps, dispatch tick + render, capture outputs for
   later modules.

The `sketch_augment` library covers (1). `ModuleRegistry` covers (2).
`SketchExecutor` covers (3) — and it calls (1) internally so callers
don't have to.

---

## `sketch_augment`

Pure-functional: `augmentSketchWithImplicitConnections(rawSketch, schemas)`
returns a fresh JSON object with synthetic rails added to columns and
synthetic read/write taps added to module entries. The original input
is not mutated.

`schemas` is a `module_type → schema-fields-json` map. The schema is
whatever the effect published via `state::Schema()` during its
`init()` — `EffectInstance::schemaJson()` parses to it. The augmenter
needs the schema to know which fields are inputs vs outputs, which are
structured, and whether two struct-typed fields are rail-compatible
(`isRailCompatible` walks them shape-by-shape).

Algorithm per column: for each module's structured input that doesn't
already have an explicit read tap, walk earlier modules looking for a
compatible structured output. If found, reuse an existing write-tap'd
rail or synthesise one (deterministic id
`__implicit__/<col>/<producerChainIdx>/<fieldPath>`). Either way, add
a read tap on the consumer.

The supporting helper `collectTextureLeaves(schema, prefix, out)` is
exported for `sketch_executor` (and any future consumer) — it
flattens a schema's nested `object` fields into slash-joined paths to
texture leaves.

---

## `ModuleRegistry`

Maps editor `module_type` strings to `RegisteredModule` records. NOTE: the
executor keeps its **own** copy of these (`registered_module.h`, a pure struct
that compiles to wasm) — the host pushes each effect's schema in via
`executor_register_schema` / `registerModuleSchema`, and the executor derives the
slot/leaf paths + flags itself via `schema_util.h`. `ModuleRegistry` is the
native-host side that owns the actual effect instances.

```cpp
struct RegisteredModule {
  nlohmann::json schemaFields;            // for the augmenter + wire routing
  std::vector<std::string> inputTexturePaths;   // non-primary input leaves (per-frame zeroing)
  std::vector<std::string> outputTexturePaths;  // non-primary output leaves (connection markers)
  std::vector<std::string> slotInputTextureFields; // positional inputTexture(N) order, incl. tex_in/tex_a
  bool hasTextureOutput;                   // false ⇒ modulation source (passthrough, never renders)
};
```

Built once at startup by the host, by **loading WASM bundles** — effects are
never statically linked:

```cpp
auto rt = std::make_unique<effect_runtime::EffectRuntime>(gpuBackend.get());
auto registry = std::make_unique<sketch_executor::ModuleRegistry>(rt.get());

sketch_executor::WasmEffectBundles bundles;
bundles.init();   // bring up WAMR + register host-import namespaces
for (auto name : {"core", "lights", "nano", "text", "richtext"})
  bundles.loadBundleFile(resourceWasmPath(name), *registry, gpuBackend.get(),
                         /*stateDoc=*/nullptr);
```

`loadBundleFile` reads the bundle (preferring a per-arch `<name>-<arch>.aot`
sidecar over the `.wasm` when present), runs its `nano_module_main`, and registers
every effect the bundle carries via `registerWasmBundle`. Each effect's
`module_init()` runs synchronously during registration — publishing its schema,
registering its shaders (SPV→MSL at load time via SPIRV-Cross), and building its
compute PSO. (`ModuleRegistry` still has a native-function-pointer `registerEffect`
for the old statically-linked path, but no host uses it anymore — the WASM bundle
path is the only one.)

Per-instance state (uniform buffers, params) is created lazily per chain entry
via `EffectRuntime::instanceFor(type, instance_key)` — each chain entry gets its
own `EffectInstance` with its own `create()`-allocated state. Two
`brightness_contrast` entries with different params render independently.
Repeated `registerEffect` calls for the same module_type are silent no-ops (the
*type* is registered once; instances are per-key).

`registry->schemas()` produces the `module_type → schema-fields` map
the executor passes to the augmenter each frame.

---

## `SketchExecutor`

Owns:
- intermediate texture pool (allocated lazily, rotated each frame,
  resized on viewport changes, released in the destructor);
- per-frame tap routing state (constructed and discarded inside
  `execute()`).

Doesn't own (the host services these through the `effrt_*` / `gpu_*` imports):
- the effect instances (native: `EffectRuntime`; web: per-key `WasmHost`);
- the GPU backend (native: Metal `GPUBackend`; web: `GPUHost`/WebGPU);
- the effect schemas (host pushes them via `registerModuleSchema`);
- input/output texture handles (host passes them in each frame).

### Per-frame contract

```cpp
int32_t SketchExecutor::execute(
    const nlohmann::json& rawSketch,
    int32_t inputHandle, int32_t outputHandle,
    int W, int H, double dt, bool sketchDirty = true);
```

- `rawSketch` — the editor's current sketch graph (the wire-model
  `{chain, instances, wires}` shape; legacy `{columns, rails, taps}` also
  passes through). The executor normalises wires → rails/taps and augments
  internally.
- `sketchDirty` — whether the sketch may have changed since last frame. Gates
  the per-instance state re-apply. The structural **plan** (which entries resolve,
  their fusion eligibility, the rail index) is rebuilt only when an internal
  topology *signature* changes — so a continuous slider drag (dirty every frame,
  but only param VALUES change) reuses the cached plan instead of rebuilding it.
- `inputHandle` — the upstream texture (typically a Metal handle the
  host adopted from a GL→Metal interop, or a real texture handle from
  a previous render pass). The executor reads but doesn't release it.
- `outputHandle` — the texture the *final* dispatched stage writes to.
  The host owns it (typically the Metal side of an output interop).
  The executor never releases it.
- Returns either `outputHandle` (if any module dispatched into it) or
  `inputHandle` (passthrough; sketch had no resolvable modules). The
  host blits whichever handle the executor returned.
- `dt` is forwarded to each effect's `tick`.

### Per-frame steps inside `execute`

1. **Augment** the raw sketch via `sketch_augment` and walk the result.
2. For each column:
   - Build a `railsById` map (column-local rails ∪ sketch-wide rails).
   - Walk chain entries. For each resolvable module:
     - **Zero stale field state**: `setTextureField(path, 0)` and
       `setFieldConnected(path, false, false)` for every non-primary
       input/output texture path. Prevents last frame's routing from
       leaking through when this frame's tap config doesn't cover it.
     - Apply persisted instance state from
       `sketch.instances[<key>].state` → `setParamFloat` /
       `setParamArray` / `setParamJson`. Falls back **per field** to the chain
       entry's legacy `params` object for any field the instance state lacks
       (the terse sketch format puts values there; matches the retired TS
       executor). Skipped entirely when `!sketchDirty`.
     - **Modulation-source passthrough**: a module whose schema declares no
       output texture (`hasTextureOutput == false`, e.g. `mod.source.lfo`) renders
       NOTHING — it ticks to publish its scalar/struct outputs, then passes the
       image chain through untouched. (Rendering it would clobber the chain with
       an empty black frame.)
     - Wire the primary `tex_in` / `tex_out` channels, and bind positional input
       slots (`inputTexture(N)`): slot 0 is the chain input; a wire-bound input
       overrides its slot, matched by the schema's NAMED field (`tex_a` → slot 0)
       or a NUMERIC index (`"0"`/`"1"`).
     - **Apply read taps** before render: for each `direction: "read"`
       tap, look up the rail's dataType and route either a single
       texture, a float scalar, or every texture leaf in a struct
       rail's schema.
     - **Mark write-tap outputs connected** before render
       (`setFieldConnected(path, false, true)`). Some effects gate
       expensive passes on `isOutputConnected(...)`.
     - `doTick(dt)`, `doRender(W, H)`.
     - **Capture write taps** after render: for each `direction: "write"`
       tap, save the producer's texture handles (or its current scalar,
       pulled from the sketch's instance state) into the per-column
       rail maps for downstream consumers.

The last resolvable module in the last column writes into
`outputHandle`. Every other module writes into an intermediate from
the rotating pool.

---

## Adding the executor to a new host

A host loads `executor.wasm` and services its imports:

1. Implement the `effrt_*` (effect lifecycle/params/textures) and `gpu_*`
   (texture alloc/dispatch/submit) imports over your effect runtime + GPU
   backend. Native does this with WAMR native symbols (`executor_host.cpp`,
   `effrt_impls.cpp`, `gpu_impls.cpp`); web does it in JS (`executor-host.ts`).
   Optionally implement the `trace_*` imports (`exec_trace.h`) for editor previews.
2. Push every effect's schema once via `executor_register_schema`
   (`registerModuleSchema`) before the first frame.
3. Per frame: marshal the sketch JSON in, adopt/prepare input + output texture
   handles, call `executor_execute(sketch, in, out, W, H, dt, dirty)`, then submit
   your GPU command buffer / blit the returned handle.

The reference hosts are the FFGL barrel
(`native/src/plugin/nano_barrel/nano_barrel_plugin.mm`, native WAMR) and the web
engine worker (`web/src/engine-worker.ts` → `WasmSketchExecutor`).

---

## What this layer does **not** do

- **No GL/Metal interop.** Host's job. (FFGL uses `InteropTexture`;
  another host might use a different bridge or skip GL entirely.)
- **No texture format conversion.** Metal handles BGRA↔RGBA channel
  semantics; intermediates are RGBA8.
- **No state persistence.** Host pulls the sketch JSON from
  somewhere and passes it in. The bridge keeps it persisted across
  composition save/reload; that's a host concern.
- **No editor-side reactivity.** The web editor's `controller.ts` has its own
  augmentation logic for editor-graph display; the *render* path no longer
  duplicates the executor — `executor.wasm` (this code) augments + renders for
  both web and native. The retired `web/src/sketch-executor.ts` was the last TS
  twin of this layer.
- **No logging.** Library code is silent. Hosts wrap the calls if
  they want traces.

---

## Constraints / known limitations

- **Per-instance state via the class-like effect ABI.** Each chain entry
  gets its own `EffectInstance` (its own `create()`-allocated `State` +
  uniform buffer), keyed by `instance_key` through
  `EffectRuntime::instanceFor`. Two `brightness_contrast` entries with
  different params render independently. Every effect now ships via the class-like
  WASM ABI — `create()` returns a fresh per-entry `State` offset in the bundle's
  linear memory (file-static *globals* stay type-shared across entries; only
  immutable type-shared data belongs there). The old free-function path that kept
  *mutable* state in file statics — which collided when a type appeared twice in a
  chain — is gone.
- **Within-column rails only.** Sketch-wide rails (cross-column) are
  indexed but not routed differently from column-local rails. Fine
  today since the editor doesn't really use cross-column flow.
- **Float-rail scalar source is the sketch state.** The executor reads a float
  wire's producer value from `sketch.instances[<producer>].state[<fieldPath>]`,
  not from a live runtime API. So the host must inject producers' live output
  scalars into the sketch state before each frame: the native barrel surfaces
  them via the bridge state document; the web host (`executor-host.ts`) mirrors
  each instance's published `pluginState` outputs into the marshalled sketch.
  A rail capturing an animated output therefore lags by one mirror round-trip.
- **Asymmetric rail paths require explicit rails.** The auto-bridge
  matches by schema shape, but the routing names match by
  fieldPath. If producer and consumer name the same struct field
  differently (eg `render_outputs` vs `render_outputs_in`), the user
  has to wire a rail by hand — augmentation won't find them through
  the path-match.
