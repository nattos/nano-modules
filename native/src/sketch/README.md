# `native/src/sketch/` — shared sketch render preparation + execution

Host-agnostic C++ that turns a sketch JSON graph into rendered pixels.
Two libraries; combined they're the entire "what does the editor's
sketch *mean* at render time" layer:

| Library | Purpose | Depends on |
|---|---|---|
| `sketch_augment` | Synthesises implicit struct-rail connections so a sketch's chain modules can find their producers' outputs without the user wiring rails by hand. Schema-only logic; no GPU. | `nlohmann_json` |
| `sketch_executor` | Walks the augmented graph one frame at a time, dispatching effects through `EffectRuntime` and routing tap data between them. Owns the intermediate texture pool; touches `GPUBackend` only to allocate intermediates. | `sketch_augment`, `effect_runtime`, `gpu_backend` |

Both libraries are **silent** (no logging) and **host-agnostic**
(no FFGL, no bridge, no Resolume). The host wraps them.

---

## Why this layer exists

The editor's sketch is a graph of modules connected by columns + rails
+ taps. To render it, three things have to happen:

1. **Augmentation** — modules' structured inputs need rails synthesised
   when the user hasn't explicitly wired one. (eg `motion_blur` reads
   `render_outputs/motion`; `soft_glow` produces it; without a rail
   they're disconnected.) The editor used to do this in
   `web/src/state/controller.ts`; it now lives here so every renderer
   (the FFGL plugin today; the bridge_server dylib's render path
   tomorrow; a future wasm-bound browser engine-worker) uses the same
   logic.
2. **Module-instance lookup** — module_type strings from the sketch
   (`"video.brightness_contrast"`) need to resolve to runtime
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

Maps editor `module_type` strings to `RegisteredModule` records:

```cpp
struct RegisteredModule {
  effect_runtime::EffectInstance* inst;
  nlohmann::json schemaFields;            // for the augmenter
  std::vector<std::string> inputTexturePaths;   // for per-frame zeroing
  std::vector<std::string> outputTexturePaths;  // for connection markers
};
```

Built once at startup by the host:

```cpp
auto rt = std::make_unique<effect_runtime::EffectRuntime>(gpuBackend.get());
auto registry = std::make_unique<sketch_executor::ModuleRegistry>(rt.get());
registry->registerEffect(
    "video.brightness_contrast", "Brightness Contrast",
    &brightness_contrast::init, &brightness_contrast::tick,
    &brightness_contrast::render, &brightness_contrast::on_state_patched);
```

`registerEffect` runs the effect's `init()` synchronously. That's when
the effect publishes its schema, registers shader modules, allocates
its uniform buffer, etc. So the host must have called
`rt->registerShaderMSL(name, ...)` for every shader the effect will
ask for *before* `registerEffect` runs.

Hard invariant inherited from `effect_runtime`:
**single-instance-per-effect-type**. Effects use file-static state;
two instances of the same effect type would collide. Repeated
`registerEffect` calls for the same module_type are silent no-ops.

`registry->schemas()` produces the `module_type → schema-fields` map
the executor passes to the augmenter each frame.

---

## `SketchExecutor`

Owns:
- intermediate texture pool (allocated lazily, rotated each frame,
  resized on viewport changes, released in the destructor);
- per-frame tap routing state (constructed and discarded inside
  `execute()`).

Doesn't own:
- the `EffectRuntime`;
- the `GPUBackend`;
- the `ModuleRegistry`;
- input/output texture handles (host passes them in each frame).

### Per-frame contract

```cpp
int32_t SketchExecutor::execute(
    const nlohmann::json& rawSketch,
    int32_t inputHandle, int32_t outputHandle,
    int W, int H, double dt);
```

- `rawSketch` — the editor's current sketch graph. The executor
  augments internally.
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
       `setParamArray` / `setParamJson`.
     - Wire the primary `tex_in` / `tex_out` channels.
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

Three steps:

1. Set up an `EffectRuntime` and `GPUBackend`. Today only Metal is
   wired up (`gpu::createMetalBackend()`).
2. Build a `ModuleRegistry`; register every editor `module_type` you
   want to support, mapping to the matching effect namespace's
   `init / tick / render / on_state_patched`.
3. Build a `SketchExecutor`. Per frame:
   - Pull the sketch JSON from wherever it lives (a bridge state
     document, a file, an in-memory cache).
   - Adopt/prepare your input + output texture handles.
   - Call `executor->execute(sketch, in, out, W, H, dt)`.
   - Submit your GPU command buffer / release adopted handles / blit
     the returned handle to wherever it needs to go.

The FFGL barrel plugin
(`native/src/plugin/nano_barrel/nano_barrel_plugin.mm`) is the
reference host today; the bridge_server dylib is the next planned
consumer.

---

## What this layer does **not** do

- **No GL/Metal interop.** Host's job. (FFGL uses `InteropTexture`;
  another host might use a different bridge or skip GL entirely.)
- **No texture format conversion.** Metal handles BGRA↔RGBA channel
  semantics; intermediates are RGBA8.
- **No state persistence.** Host pulls the sketch JSON from
  somewhere and passes it in. The bridge keeps it persisted across
  composition save/reload; that's a host concern.
- **No editor-side reactivity.** The web editor's `controller.ts`
  also has logic for augmentation; *eventually* it should call the
  wasm-compiled version of `sketch_augment` instead of duplicating
  the logic in TypeScript. Until that lands the editor's renderer
  still uses its TS copy.
- **No logging.** Library code is silent. Hosts wrap the calls if
  they want traces.

---

## Constraints / known limitations

- **Single instance per effect type.** Inherited from
  `effect_runtime`. A sketch with two `brightness_contrast` instances
  in the same chain would step on each other's file-static state. The
  registry silently ignores the second `registerEffect` for the same
  module_type, and the executor binds both instance_keys to the same
  underlying instance — effectively the second one overwrites the
  first's state every frame.
- **Within-column rails only.** Sketch-wide rails (cross-column) are
  indexed but not routed differently from column-local rails. Fine
  today since the editor doesn't really use cross-column flow.
- **Float-rail scalar source is the sketch state.** The executor
  reads from `sketch.instances[<producer>].state[<fieldPath>]`, not
  from any "what's your live value right now" runtime API. So a
  rail that captures from a producer's *output* of an animated field
  will lag by however long it takes the editor's mirror to round-trip.
- **Asymmetric rail paths require explicit rails.** The auto-bridge
  matches by schema shape, but the routing names match by
  fieldPath. If producer and consumer name the same struct field
  differently (eg `render_outputs` vs `render_outputs_in`), the user
  has to wire a rail by hand — augmentation won't find them through
  the path-match.
