# Effects Style Guide

Conventions for authoring nano-modules effects. The goal is *playability* — every effect should feel intuitive and fun to tweak, hold up across modulation, and play nicely with the rail / tap routing system. This guide covers parameter design, time handling, visual character, randomness, and tuning surfaces.

This is a living document. When in doubt, prefer the option that makes a parameter sweep feel good live.

## 0. Shared helpers — use them

Cross-effect patterns live in two places. Reach for these before writing your own.

**C++ small helpers** (`#include <effect_utils.h>`):

| Helper                                        | Purpose                                                      |
|-----------------------------------------------|--------------------------------------------------------------|
| `fx::signedSliderToExp(slider)`               | `[-1, +1]` slider → `pow(2, ±3)` exponent (8↔1↔1/8 by default) |
| `fx::stops(slider, maxStops = 3.0)`           | Multiplicative gain in stops (`2^stops`)                     |
| `fx::coverSquare(vp_w, vp_h)`                 | Cover-square half-extents in viewport-uv (style guide §1.5)  |

**C++ kernels** — heavier-weight utilities. Each owns its own PSO + scratch resources; instantiate one per effect that needs it.

| Header              | Class               | What it gives you                                                                 |
|---------------------|---------------------|-----------------------------------------------------------------------------------|
| `<effect_blur.h>`      | `fx::GaussianBlur` | Two-pass separable Gaussian. `applyWithRadius(in, out, w, h, radius, quality)` does the whole thing. Tap locations are stable as `radius` modulates — no shimmer. **Use this for small-to-medium radii where you need exact Gaussian shape or smooth no-shimmer modulation.** Bundle's `build.sh` must list `compile_shaders_compute blur`. |
| `<effect_fast_blur.h>` | `fx::FastBlur`     | Iterative 13-tap downsample + 9-tap tent upsample (Jorge Jimenez, CoD: Advanced Warfare, SIGGRAPH 2014). `apply(in, out, w, h, iterations)`. Each iteration roughly doubles the effective radius for ~4/3 the per-mip cost — far cheaper than Gaussian for large radii. Trades exact shape for speed and uses integer iteration steps. **Use this for bloom downsamples, large-radius glow, soft shadows, anything where the radius is wide and shape doesn't have to be Gaussian-pure.** Bundle's `build.sh` needs three lines (see header for the exact `compile_shaders_compute_var` invocation). |

**HLSL** (`#include "nano_<name>.hlsl"` — search path is `wasm_modules/shaders_common/`):

| File              | Functions                                                                           |
|-------------------|--------------------------------------------------------------------------------------|
| `nano_coords.hlsl`| `nano_pixel_to_uv`, `nano_uv_to_cover_square`, `nano_cover_square_to_uv`, `nano_pixel_to_cover_square` |
| `nano_curves.hlsl`| `nano_signed_slider_exp`, `nano_apply_curve` (scalar + float3)                       |
| `nano_color.hlsl` | `nano_luminance`, `nano_rgb_to_hsl` / `nano_hsl_to_rgb`, `nano_rgb_to_hsv` / `nano_hsv_to_rgb` |
| `nano_hash.hlsl`  | `nano_hash21`, `nano_hash31`, `nano_value_noise2`, `nano_fbm2`                       |

When you find yourself writing the same five lines in three effects, that's the cue — extract into a shared helper and update this table.

**Bind groups: declare layouts explicitly (required)**

Every PSO declares its bindings up front:

```cpp
auto pso = gpu::Device::createComputePSO(cs_mod, "main", gpu::Bindings()
  .tex2d(0)
  .storageTex2d(1, gpu::TextureFormat::RGBA8)
  .uniform(2)
  .storage(3));
```

Why: WebGPU's auto-derived layout matches whatever the *shader* currently declares. The moment you start using `#ifdef`s in HLSL, naga prunes "unused" bindings, or you reuse one shader source from two PSOs that bind different subsets, the host's bind group disagrees with the auto-derived layout and the dispatch is silently invalid. With explicit layouts, the host honours what *you bind* — extra slots the shader doesn't read are fine, and conditional shaders never desync.

`gpu::Bindings()` builder methods: `uniform(slot)`, `storage(slot)` (read), `storageRW(slot)` (read-write), `sampler(slot)`, `tex2d(slot)`, `tex3d(slot)`, `tex2dArray(slot)`, `storageTex2d(slot, fmt)` (write), `storageTex2dRW(slot, fmt)` (read-write — formats r32float / r32sint / r32uint), and `storageTex3d` / `storageTex3dRW` for 3D. Pass an empty `Bindings()` for shaders that read no bind group resources (e.g. vertex-buffer-only render PSOs).

**Vector and color parameters — declare the actual shape**

When a parameter is logically a 2D point or a color, declare it as a vec / RGB / RGBA field rather than splaying it across `_x`/`_y` or `_r`/`_g`/`_b` floats. The IDE renders vec2/3/4 as labeled component sliders and renders RGB(A) fields as a native color picker.

```cpp
state::Schema()
  .vec2Field("center",  0.0f, 0.0f, state::PrimaryInput)        // X / Y sliders
  .rgbField("line",     1.0f, 1.0f, 1.0f, state::SecondaryInput) // color picker
  .rgbaField("bg",      0.0f, 0.0f, 0.0f, 0.0f, state::SecondaryInput) // color + alpha
```

In `on_state_patched` use `state::patchVec2(i)` / `patchVec3(i)` / `patchVec4(i)` to read the array value:

```cpp
if (state::pathIs(p, l, "center")) { auto v = state::patchVec2(i); cx = v.x; cy = v.y; }
if (state::pathIs(p, l, "line"))   { auto v = state::patchVec3(i); /* … */ }
```

`rgbField` / `rgbaField` are aliases for `vec3Field` / `vec4Field` with `hint="color"`. The hint also works on a raw `vec3Field`/`vec4Field` if you want the color picker without the alias.

(FFGL doesn't support vec params, so any FFGL host will need to splay these back out at the boundary — the schema is the source of truth, not the FFGL projection.)

**Mode-dependent parameters — declare them all, hide the inactive ones**

When an effect has multiple "shapes" controlled by a mode selector (Span vs Inset crop, RGB vs HSV picker, …), register *every* parameter the effect can ever expose in the schema (`module_init`). Then use `state::setOnStateReady` to register a callback that — fired once after init + the initial state replay — calls `state::setFieldHidden(path, hidden)` to hide whichever fields the active mode doesn't use. In `on_state_patched`, when the mode field changes, re-run the visibility logic. The callback takes `self` so it can read the instance's mode.

```cpp
.selectField("mode", ModeSpan, state::PrimaryInput, {{"Span", 0}, {"Inset", 1}})
.floatField("width", 1.0f, 0.f, 1.f, state::PrimaryInput)        // span-only
.floatField("inset_left", 0.0f, 0.f, 1.f, state::PrimaryInput)   // inset-only
…

void init(void* self) {                // per-instance tail (schema is in module_init)
  state::setOnStateReady(&on_state_ready);
}
static void on_state_ready(void* self) {
  apply_mode_visibility(*static_cast<State*>(self));
}
void on_state_patched(void* self, ...) {
  auto* s = static_cast<State*>(self);
  /* update s->mode etc. */
  if (mode_changed) apply_mode_visibility(*s);
}
```

Why this shape:
- The schema stays a stable union of *every* field, so serialized state always round-trips — toggling mode doesn't drop or rename any data.
- `on_state_ready` fires after the executor replays serialized state, so the IDE only ever paints the post-restoration schema. The user never sees a transient "all fields visible" frame.
- Setting hidden is a pure UI overlay — `notifyStatePatched`, rail routing, and bridge-core state continue to work for hidden fields exactly as if they were visible.

**`selectField`** — single-choice integer with named options. Renders as a dropdown in the inspector. Use this for mode selectors, algorithm pickers, and anything else with a small fixed set of named values. Schema-wise it's `type:int` plus an `options:[{label,value},…]` array.

**GPU platform features** — what the host actually supports. Reach for the right tool instead of working around what you assume isn't there.

| Capability                              | API                                                                                          | When it's the right answer                                                            |
|-----------------------------------------|----------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|
| HDR float textures (`rgba16f`, `r32f`, `rgba32f`) | `gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA16F)`                              | Bloom, glow, motion-trail accumulators, energy fields — anything where values exceed 1.0 or you need sub-LSB precision. Default to `RGBA16F`; reach for `R32F`/`RGBA32F` only when half-precision isn't enough. |
| Atomic ops on storage buffers           | HLSL `RWStructuredBuffer<int>` + `InterlockedAdd` (round-trips through naga as `atomic<i32>` + `atomicAdd`) | Histograms (auto-exposure, auto-WB, color stats), point splatting, OIT counters, particle counters. |
| Read-write storage textures (`r32float`, `r32sint`, `r32uint`) | Hand-author WGSL `texture_storage_2d<r32float, read_write>` and bind via `cp.setTexture(tex, slot, 2)` (access=2) | In-place RMW: reaction-diffusion fields, energy decay accumulators, single-pass mutation that would otherwise need ping-pong textures. |
| Texture clear / texture copy            | `gpu::Device::clear(tex, r, g, b, a)`, `gpu::Device::copy(src, dst)`                        | Resetting an accumulator, ping-pong rebroadcast, freeze-frame snapshots. Clear works only on renderable formats (`rgba8/16f`, `bgra8`); for non-renderable formats run a fill compute pass. |
| Multi-render-target (MRT)               | `gpu::Device::createInstancedRenderPSOMRT({fmtA, fmtB, …})` + `gpu::RenderPass::beginMRT({{texA, ...}, {texB, ...}, …})` | G-buffer style effects: emit color + normal/depth/ID in one fragment pass, drive deferred stylization (toon, edge-aware, light propagation). |
| 3D textures                             | `gpu::Device::createTexture3D(w, h, d, fmt)` — bind as `texture_3d<f32>` (sample) or `texture_storage_3d<...>` (write) | Color LUTs (16³–32³ rgba8 cube), particle/density volumes, anything with three-axis lookup. |
| Mip chain + LOD sampling                | `gpu::Device::createTextureWithMips(w, h, n, fmt)` allocates an N-mip texture; `cp.setTextureMip(tex, slot, access, mipLevel)` binds *one* mip (single-mip view) for either sampled read or storage write. Sample at level via WGSL `textureSampleLevel(tex, samp, uv, lod)`. | Dual-filter blur, custom mip generation, hierarchical algorithms (DOF, screen-space scattering). **Always bind single-mip views via `setTextureMip` when a pass reads one mip and writes another of the *same* texture** — the default sampled view spans all mips and overlaps the write subresource, which WebGPU rejects. |

`fx::FastBlur` in `<effect_fast_blur.h>` packages the whole dual-filter pattern (multi-mip scratch, single-mip view bindings via `setTextureMip`, 13-tap down + 9-tap tent up shaders). `filter.blur.fast` is the thin wrapper effect — three-line `init()`, three-line `render()` — and any future bloom/glow/DOF should just instantiate `fx::FastBlur s_blur;` next to its `fx::GaussianBlur` and `fx::FastBlur` siblings.

**Effect structure — per-instance instances (the class-like ABI)**

Effects are **class-like**: a single effect *type* can be instantiated many
times (one per chain entry). Per-instance state lives in a heap-allocated
`State` object the host threads back to every callback as `void* self`; the
type's shared, immutable-after-compile resources stay file-static.

> **Why:** the native barrel runs one effect runtime shared across the whole
> chain, so two entries of the same type would collide on any file-static
> mutable state (params, uniform buffers). The web/WASM path sandboxes each
> chain entry in its own module instance, so file statics happen to be
> per-instance there — but the barrel does not. The instance ABI is the single
> source of truth; don't rely on file-static mutable state.

Every converted effect exposes exactly these entry points (all instance
callbacks take `self` first):

```cpp
void  module_init();                 // ONCE per type: schema + shared GPU resources
void* create();                      // alloc State + this instance's buffers; return it
void  destroy(void* self);           // release per-instance GPU resources, delete State
void  init(void* self);              // per-instance tail: defaults + registerFusion*
void  tick(void* self, double dt);
void  render(void* self, int vp_w, int vp_h);
void  on_state_patched(void* self, int n, const char* pb,
                       const int* off, const int* len, const int* ops);
void  on_resolume_param(void* self, long long param_id, double value);  // ok as no-op
int32_t is_identity(void* self);     // OPTIONAL: nonzero ⇒ pure passthrough now
```

### `is_identity` — let the executor skip your no-op

If your effect has a parameter setting that makes it a pure passthrough
(`output == primary input`), expose an `is_identity(self)` predicate returning
nonzero for that state. The executor then **skips the dispatch entirely** and
aliases input→output: a standalone stage costs zero GPU work, and a fused group
whose stages are *all* identity is dropped (a single identity stage inside a
larger fused group is dropped from the fused kernel). Examples: `exposure` at
`amount==0`; `color_temperature` at `temperature==0`; `brightness_contrast` at
`(0.5, 0.5)`; `transform` at neutral scale/rotation/translate; `sharpen` at
`amount==0`.

Rules:
- **Stateless only.** Never return nonzero from a stateful effect (particles,
  feedback, accumulators, anything with hysteresis) — skipping a frame freezes
  its simulation. Most generators have no identity either; leave the predicate
  off (`nullptr`) and nothing is skipped.
- **Side-effect free.** It's a pure read of the current param state; the runtime
  may call it any number of times per frame.
- **Wiring.** Export `is_identity` as part of the module's `EffectDesc_v2` (the
  effect's trailing descriptor field). The bundle's `nano_module_main` captures
  it when the `.wasm` loads, so it works identically on web and native — no
  manifest or per-host registration. Don't add the predicate to an effect that
  has no genuine identity state.
- **Taps.** The executor only skips tap-free chain entries (taps can drive
  params from rails or publish outputs); a tapped entry always runs.

The split — **mutable per-instance → `State`; immutable type-shared → file static:**

```cpp
struct State {                       // one per chain entry
  float brightness = 0.5f, contrast = 0.5f;
  bool  initialized = false;
  gpu::Buffer uniform_buf;           // per-instance: its own buffer
};
static gpu::ComputePSO s_pso;        // type-shared: compiled once, read by all instances

void module_init() {                 // schema + shaders + the shared PSO (once per type)
  state::init("video.example", {1,0,0}, state::Schema() /* … */);
  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("compute");
  s_pso = gpu::Device::createComputePSO(cs, "main", /* bindings */);
}
void* create() {                     // per-instance allocation
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  return s;
}
void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}
void init(void* self) {              // per-instance tail
  auto* s = static_cast<State*>(self);
  s->initialized = true;
  state::registerFusionByName(state::FusionKind::PerPixelMapper, "pixel",
                              s->uniform_buf.id, sizeof(FuseUniforms), &prepare);
}
void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  /* … read s->brightness etc., bind s->uniform_buf + the shared s_pso … */
}
```

Rule of thumb: **anything mutated per-frame or per-instance** (param scalars,
uniform buffers, scratch/accumulator textures, particle pools, RNG state, an
`initialized` flag) goes in `State`. **Anything immutable post-compile** (PSOs,
shader modules, samplers, compile-time constants) stays file-static and is
created once in `module_init()`. `brightness_contrast/main.cpp` is the canonical
template; `soft_glow` and `motion_blur` show richer State (blob pools, per-
instance pyramid textures, per-instance spec-constant PSOs).

**Registering in the bundle.** The aggregator's `nano_module_main` declares and
registers each effect with the instance macros. Every effect in every bundle is
on the instance ABI — there is no legacy trampoline:

```cpp
NANO_DECLARE_INSTANCE_EFFECT(example)   // forward-declares the 8 entry points

void nano_module_main() {
  nano::registerEffect({ 2, "filter.glitch.twitch_mask", "Twitch Mask", "…", "filter", "kw",
                         NANO_INSTANCE_LIFECYCLE(example) });
  // Effects with a genuine identity state pass &example::is_identity as the
  // trailing field (see §"is_identity").
}
```

(`struct_version` is `2`. The macros live in `wasm_modules/include/module_api.h`.)
The id string passed here **must** match the id the effect declares in its own
`state::init("<id>", …)` — both are renamed in lockstep.

### Naming: id, display name, category

Effect ids are **hierarchical dotted paths**: `domain.[group.[…]].name`. The first
segment is the **domain** and doubles as the `category` field (the 5th
`registerEffect` arg, used for colour-coding) — keep the two in sync. The full
roster and the rules live in `EFFECT_TAXONOMY.md`; the domains are `source,
color, filter, warp, composite, motion, mod, control, debug`.

- **Use the full path to group, not just two levels.** The effect chooser
  (`web/src/widgets/smart-input.ts`) drills down *one path segment at a time* —
  `source/` → `light/` → *Chroma Wave* — and lists sub-folders alongside the
  effects at each level. A deeper, well-chosen path (`source.light.chroma_wave`,
  `filter.blur.gaussian`, `mod.shaper.remap`) makes the effect easier to find;
  flat names bury it in one long list. Group siblings that share a family under a
  common middle segment (`filter.blur.*`, `color.tone.*`, `mod.source.*`).
- **Display name** is human-facing Title Case (`"Chroma Wave"`, `"Brightness &
  Contrast"`) — it's *not* derived from the id, so name it for clarity, not to
  echo the path. Don't repeat the bundle/domain in it ("Video Blend" → "Blend").
- **Bundle ≠ domain.** Which `.wasm` an effect ships in is independent of its id;
  the same domain can span bundles (`source.light.*` lives in `lights`,
  `source.gradient` in `core`).

### Skip whole stages on the host — don't early-out in the shader

We are **not in ShaderToy land**. An effect isn't one fragment program that has to do everything every pixel — it's a host-driven graph of compute dispatches, and `render(self, w, h)` is plain C++ that decides, per frame, *which* dispatches to issue. A pipeline can have as many stages as it wants, and that count can be **dynamic** — gated on parameters, connectivity, or mode. Lean into that.

So when a parameter setting makes some work unnecessary, the right move is to **not dispatch it** — branch in `render()` and skip the pass — rather than dispatch it anyway and `return` early inside the shader. A skipped dispatch costs nothing; a shader early-out still pays the launch, the bind-group setup, and one thread per pixel. More importantly it keeps the *cost model legible*: the work an effect does this frame is exactly the dispatches you can see it issue.

Patterns, in order of preference:

- **Gate optional producer passes on connectivity.** A `render_outputs/motion` (or any rail) pass should run only when something downstream reads it: `if (state::isOutputConnected("render_outputs")) { …dispatch motion pass… }`. No consumer → no dispatch.
- **Branch the algorithm before dispatching.** When a `mode` / `source` selector changes the *shape* of the pipeline, pick the branch in `render()` and skip the stages the active mode doesn't need. (`motion.local_delay`'s `flow_source` selector skips the entire pyramidal-Lucas-Kanade estimator — a luma pass, two downsamples, three LK levels, an upsample — when it's fed incoming vectors instead.)
- **`is_identity` for a whole no-op effect** (see above) — the executor skips the dispatch and aliases input→output for you.

The one caveat — producing `tex_out` when you skip the final pass. A stage still has to leave a valid output texture. The obvious move, `gpu::Device::copy(in, out)`, works **natively** but **not for mid-chain intermediates in the web executor**: that pool allocates intermediates `COPY_SRC` only (no `COPY_DST`), so `copyTextureToTexture` into `tex_out` is a validation error there. When you genuinely must write `tex_out` and `copy` isn't available, a thin one-read/one-write shader passthrough is the portable fallback — but you've still skipped the *expensive inner work* (the multi-step loop, the neighbor gathers), which is the real cost; the bare dispatch is noise. Skip whole *stages* freely on the host; only fall back to a shader passthrough for the single pass that has to emit the output.

### The frame loop paces to the GPU — don't fire-and-forget long jobs

The web executor caps GPU **frames-in-flight** (`MAX_FRAMES_IN_FLIGHT`, currently 2, in `engine-worker.ts`). Each frame it records a `device.queue.onSubmittedWorkDone()` fence and, once more than the cap are outstanding, blocks the loop on the oldest before issuing the next. That's what stops a heavy effect from letting command buffers pile up faster than the GPU drains them — without it the queue (and memory) grows unbounded and you get periodic catch-up stalls; with it, a too-heavy frame just degrades the frame rate smoothly.

The catch for effect authors: **`onSubmittedWorkDone()` awaits ALL work submitted to the queue, not just yours.** There is no separate "background" GPU lane. So you can't fire-and-forget a giant compute job and have it run out of lock-step with frames — whatever you submit in `render()` becomes part of the current frame's flight and is awaited by the pacing within ~2 frames. The runtime decides *when* to await; you only decide *what* to submit.

Consequences:
- **Keep per-frame GPU work bounded.** The cost model is exactly the dispatches you issue in `render()` this frame (§"Skip whole stages"). One huge submission stalls the loop for the whole column, not just your stage.
- **Amortize heavy work across frames in bounded slices**, not one mega-dispatch. Do a fixed chunk per `render()` and carry the partial result on `State` — the particle pools and the multigrid solvers (`height_from_gradient`) already work this way (a fixed N steps per frame, never "iterate to convergence now"). This stays responsive *and* interruptible.
- **Don't lean on async GPU completion racing ahead of the display.** There's no independent async path that escapes frame pacing.
- **One-off precomputes** (atlas bake, LUT build) belong in `module_init` / `create` / `init`, cached on `State` — not repeated per frame. If a one-off must happen mid-run, expect that single frame to hitch and don't redo it.

---

## 0.1 Fusion-aware effects — opt in when you can

Per-pixel effects that follow a strict shape can be **coalesced**: the engine collapses runs of adjacent fusion-aware stages in a column into a *single* compute dispatch, eliminating the intermediate texture round-trip between them. A column like `color_space → curve → vignette → saturate` becomes one dispatch instead of four — measurably faster on busy sketches and visible live in the **Debug Info** sidebar (it shows "Dispatches saved by fusion" per frame).

Opt-in is a single `state::registerFusionByName(...)` call in the effect's per-instance `init(self)` (using that instance's uniform buffer) plus a small refactor of the per-pixel logic into a `pixel.hlsl` file. **Default is no fusion** — effects that don't call it keep the standalone path verbatim.

### Choosing a `FusionKind`

The engine refuses to fuse anything that doesn't fit one of two strict shapes:

| Kind | What the shader does | Examples |
|---|---|---|
| **`PerPixelMapper`** | Reads `inputTex[gid.xy]` exactly once, writes `outputTex[gid.xy]` exactly once. No neighbor sampling, no samplers, no mip chains, no second input. | brightness/contrast, curves, color space, saturate, hue basis, vignette, posterize. |
| **`StrictOutput`** | Writes every output pixel exactly once but doesn't sample `inputTex`. Generators that produce pixels from uniform parameters / `gid` / `vp_size`. | solid color, gradient, noise. |
| `Freeform` (default — don't call `registerFusion`) | Anything else: multi-pass, samplers, mip chains, neighbor reads, render passes, secondary inputs, struct-rail outputs. | blur, fast_blur, sharpen, edges, transform, video_blend. |

Fusion rules within a column:
- A `PerPixelMapper` can be the top of a fused run *and* tail any other mapper or strict-output run.
- A `StrictOutput` can only be the top of a fused run — the planner forces a run break when it sees one mid-chain.
- A `Freeform` stage breaks any in-progress fused run and runs alone (current behavior).

### The pattern — three files

For a fusion-aware effect, the per-pixel kernel lives in `pixel.hlsl`; the standalone compute shader (`compute.hlsl`) becomes a thin wrapper that includes it. The build pipeline emits BOTH `COMPUTE_WGSL/MSL` (standalone) and `PIXEL_WGSL/MSL` (a fragment template the runtime fuser splices into composed shaders).

**`pixel.hlsl`** — the per-pixel logic, with a fixed signature:

```hlsl
struct FuseUniforms {            // EXACT name expected by the build pipeline.
  float strength;
  float bias;
  float _pad0;
  float _pad1;
};
// b2 is the canonical "uniforms" slot — 0/1 are tex_in/tex_out for the
// standalone wrapper. The fuser renumbers this when composing.
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]                        // REQUIRED — DXC honors this; preserves the
                                  // function across SPIR-V/naga so the fuser
                                  // can call it. (glslc ignores the attribute,
                                  // but the standalone path is fine inlined.)
float4 fuse_transform(uint2 gid, float4 c) {     // PerPixelMapper signature
  return float4(c.rgb * u_fuse.strength + u_fuse.bias, c.a);
}
```

For `StrictOutput`, the signature differs (no input color):

```hlsl
[noinline]
float4 fuse_transform(uint2 gid, uint2 vp_size) { // StrictOutput signature
  return u_fuse.color;
}
```

Helper functions in `pixel.hlsl` are fine — DXC + `[noinline]` keeps `fuse_transform` and any helpers as named functions; the build's strip pass detects them and the runtime composer renames every top-level identifier with a per-stage prefix to avoid collisions.

**`compute.hlsl`** — wrapper for the standalone path:

```hlsl
#include "pixel.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  outputTex[gid.xy] = fuse_transform(gid.xy, inputTex[gid.xy]);
}
```

For `StrictOutput` effects the wrapper omits `inputTex` and passes `uint2(w, h)` as the second arg.

**`main.cpp`** — follow the per-instance ABI from §0 (struct `State`,
`module_init`/`create`/`destroy`/`init(self)`). The fusion `prepare` callback
**takes `self` first** (the engine calls it per fused stage with that stage's
instance), and registers via `registerFusionByName` using *this instance's*
uniform buffer handle:

```cpp
struct FuseUniforms { float strength; float bias; float _pad0; float _pad1; };

struct State {
  float strength = 1.0f, bias = 0.0f;
  bool  initialized = false;
  gpu::Buffer uniform_buf;             // per-instance
};
static gpu::ComputePSO s_pso;          // type-shared

// Updates THIS instance's uniform buffer. Called from render() (standalone)
// AND by the engine via the fusion prepare callback (fused path) — both share
// the same write so the dispatched output is identical. Takes self FIRST.
void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = { s->strength, s->bias, 0.f, 0.f };
  s->uniform_buf.writeOne(u);
}

void module_init() {                   // once per type: schema + shared PSO
  state::init("video.example", {1, 0, 0},
    state::Schema()
      .floatField("strength", 1.0f, 0.f, 4.f, state::PrimaryInput)
      .floatField("bias",     0.0f, -1.f, 1.f, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput));

  if (gpu::Device::backend() == gpu::Backend::None) return;
  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main",
    gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  return s;
}
void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}

void init(void* self) {                // per-instance: defaults + fusion opt-in
  auto* s = static_cast<State*>(self);
  if (!s || !s->uniform_buf.valid()) return;
  s->initialized = true;
  // Stage type, the per-pixel fragment's registered SPV name, THIS instance's
  // uniform buffer handle, its size, and the prepare callback. No-op for
  // effects that never call this (they stay Freeform).
  state::registerFusionByName(state::FusionKind::PerPixelMapper, "pixel",
                              s->uniform_buf.id, sizeof(FuseUniforms), &prepare);
}

void tick(void* self, double dt) { (void)self; (void)dt; }
void on_resolume_param(void*, long long, double) {}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  prepare(self, vp_w, vp_h);           // shared uniform write
  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);                    // shared PSO
  cp.setTexture(in,  0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);     // per-instance buffer
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();
  gpu::Device::submit();
}
```

**`build.sh`** — switch `compile_shaders_compute <effect>` to `compile_shaders_compute_fused <effect>`. The helper auto-detects the strict-output signature by greping `pixel.hlsl`, so the same call works for both kinds.

### Verifying

The per-effect E2E test should run in all three fusion modes (`force-off`, `force-on`, `auto`) and assert the same golden pixel values. Wrap the test body with `forEachFusionMode((mode) => describe(...))` from `gpu-test-helpers.ts`. Output must be byte-identical across modes — that's the parity guarantee the planner has to preserve.

```ts
forEachFusionMode((mode) => describe(`Example (${mode})`, () => {
  it('does the thing', async () => {
    const frame = await runGpuEffectTest({
      module: 'example.wasm', bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [['strength', 2.0]],
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 2);
  });
}));
```

### When NOT to convert

Don't bother (and don't risk it) when the effect:
- Reads neighbors (`inputTex[gid.xy + offset]`), uses a sampler, or samples mips (`textureSampleLevel`).
- Has more than one input texture (e.g. `tex_in_1`).
- Outputs a struct rail or GPU buffer rather than a texture.
- Has any taps on `entry.taps` — the planner refuses these to keep tap routing semantics intact.
- Runs multiple PSOs / dispatches per frame (multi-pass — give the standalone path a stable test first; revisit only when there's a reason).

When in doubt the safe default is to leave `registerFusion` off entirely. The standalone path always works.

### Existing examples

- `wasm_modules/saturate/` — `PerPixelMapper`, with helper functions in `pixel.hlsl`.
- `wasm_modules/fuse_solid/` — `StrictOutput`, no input texture (test-only).
- `wasm_modules/fuse_add/` and `fuse_mul/` — minimal `PerPixelMapper` references (test-only).

---

## 1. Parameter design

### 1.1 Expose lots of parameters

Effects with three sliders and nothing to discover die quickly. Lean toward exposing **everything that meaningfully changes the look or feel**. Two flavours:

- **Standard parameters** — the things the performer changes live. These show up by default in the UI, are typically the first 3–8 fields in the schema, and should be the *most* expressive controls.
- **Tuning parameters** — model-shape knobs that the performer rarely touches but the patch designer or developer does (curve shapes, internal gain, decay times, debug toggles, color-space selectors). Mark these clearly in the schema (today via field ordering / `io` flags; convention-wise put them after standard params).

Per-effect schemas should declare `order:` for every field so the UI can render them in a stable, designed sequence.

### 1.2 Prefer normalized ranges

Default to `[0.0, 1.0]` for unsigned quantities and `[-1.0, 1.0]` for signed (offsets, balance, bipolar gain). Avoid raw Hz, raw pixels, raw radians.

**Why:** rails and taps connect parameters together. A `[0,1]` slider drives a `[0,1]` slider out of the box; a `0..3.14` slider needs a `paramlinker` curve to be useful at the other end. Normalized ranges compose without scaffolding.

This applies to **screen coordinates** too — prefer viewport-normalized `(u, v)` ∈ `[0, 1]` (or `[-1, 1]` for centered coordinates) over pixel `(x, y)`. See *§4 Aspect ratio* for the exception when you want aspect-aware coordinates.

### 1.3 Use perceptually-linear curves

A linear `[0, 1]` slider rarely maps linearly to the underlying value. A `decay` slider that maps linearly to a one-pole filter coefficient is unusable — the entire interesting range is in the top 5%. Apply a curve so that **equal slider distance feels like equal change**.

Common patterns:

- **Exponential / power.** Decay coefficient: `coef = pow(coef_min, 1.0 - slider)`. Frequency: `freq = freq_min * pow(freq_max / freq_min, slider)`.
- **Decay time / half-life.** Even better than a curve: just expose the *time* directly (`half_life_ms` ∈ `[1, 10000]`, log-mapped). Convert internally: `coef = pow(0.5, dt / half_life_seconds)`. This reads the way a musician thinks.
- **dB for gain.** `gain = pow(10, slider_db / 20)` if you must expose audio-style gain. But often a `[0,1]` "amount" with a perceptual curve is friendlier than dB.

Document the mapping in the field's description string so the UI / param linker can make it visible.

### 1.4 Aspect-ratio aware

For *spatial* parameters (positions, scales, blur radius, displacement amount), **bake aspect ratio into the math, not the parameter**. The performer should be able to author a patch on a 16:9 monitor and have it look right on a 9:16 LED wall.

Concrete rules:

- A `radius` of `0.1` should mean "10% of the smaller viewport dimension" (or a defined screen-fraction reference), not 10% of pixel width.
- Anisotropic effects (motion blur, directional gradient) should sample with units that are the same in u and v even when the viewport isn't square.
- When you sample neighbours in a shader, scale offsets by viewport size: `vec2 px = vec2(1.0/W, 1.0/H);`. Don't use a single `px` value.

### 1.5 Anchors and pivots — the cover-square convention

For *transform-style* parameters (scale center, rotation pivot, polar origin, lens distortion center), use **signed-normalized coordinates inside a 1:1 cover-fit square**:

- The square is centered on the viewport.
- The square's side = `max(W, H)` (it covers the viewport, extending off the shorter axis).
- `(0, 0)` is the viewport center.
- `(-1, 0)` is the left edge of the cover square — this matches the **left edge of the viewport** when viewport is wider than tall.
- `(+1, 0)` is the right edge of the cover square — viewport right edge for wide layouts.
- For tall viewports, `±1` along Y matches the viewport top/bottom; the X range visible is narrower than `[-1, 1]`.

This means a fixed `pivot = (0.3, 0.0)` looks "30% right of centre" in any aspect ratio — exactly what a designer expects. Going past `(±1, ±1)` into the corners is *intentional* off-screen territory.

Use the **shared helpers** rather than rolling your own:

- C++: `auto [ax, ay] = fx::coverSquare(vp_w, vp_h);` from `<effect_utils.h>` — pass `ax`/`ay` to the shader as uniforms.
- HLSL: `#include "nano_coords.hlsl"` then `nano_pixel_to_cover_square(pixel, vp, aspect)`. There's also `nano_uv_to_cover_square` and `nano_cover_square_to_uv` for the inverse.

Use this for *every* effect that scales, rotates, or warps around a point. Even simple "kaleidoscope center" knobs benefit.

---

## 2. Time and motion

### 2.1 The big rule: use accumulators, not `time * rate`

❌ **Don't** do this:

```cpp
// BAD: phase jumps when rate changes
float phase = elapsed * rate;
float val = sinf(phase * 2.0f * PI);
```

If the performer turns the rate knob from 0.5 Hz to 2.0 Hz at `t = 10s`, the phase **leaps from 5.0 to 20.0** instantly — a glitch in the audible / visible signal.

✅ **Do** this:

```cpp
// GOOD: phase advances continuously regardless of rate changes
phase += dt * rate;          // dt is the per-frame delta from frameState
phase = fmodf(phase, 1.0f);  // wrap as needed
float val = sinf(phase * 2.0f * PI);
```

This is exactly how every audio-synthesis oscillator works, and for the same reason. It generalizes:

- LFOs: `phase += dt * rate;`
- Decay envelopes: `env *= pow(decay_per_second, dt);`
- Particle ages: `age += dt;` and act on `age`, not `t - spawn_time * speed`.
- Animation: `position += dt * velocity;` (also lets you change velocity smoothly).

The tradeoff: **the rate of change at any moment** depends on the parameter; **the accumulated state** is parameter-independent and continuous. For musical performance this is what you want.

> **Note on existing effects:** the LFO and similar effects in this codebase currently do the wrong thing (read `elapsed * rate`). When you touch them, fix it. New effects must use accumulators.

### 2.2 BPM / bar-relative time

The host frame state provides `barPhase ∈ [0, 1)` and `bpm`. For musical effects, consume `barPhase` directly — it's already a stable accumulator the host advances. Don't recompute it from `elapsed * (bpm / 60 / 4)`.

For sub-bar timings, derive from `barPhase` *change* between frames:

```cpp
double dphase = (barPhase - last_bar_phase + 1.0);
if (dphase >= 1.0) dphase -= 1.0;   // wrap
last_bar_phase = barPhase;
my_phase += dphase * my_rate_in_bars;
```

---

## 3. Visual character

### 3.1 Non-linear curves for warmth

Mathematically-precise effects (a clean blend, a clean blur) should be linear and predictable. **Character** effects (tape sat, tube glow, film grain, "vintage" anything) should *embrace* non-linearity.

Some go-to non-linearities:

- **Soft-clip:** `tanh(drive * x) / tanh(drive)` instead of `clamp(x, -1, 1)`.
- **Asymmetric bias:** apply a non-zero offset before the non-linearity, so even/odd harmonics are unequal — that's where "warmth" lives.
- **Per-channel different curves:** treat R, G, B with slightly different transfer functions to recreate the way photographic film responds.
- **Toe and shoulder:** any sigmoid-ish curve with a soft toe (dark crush) and shoulder (highlight roll-off) reads as "analogue".

Curves should be controlled by **tuning** parameters (drive, asymmetry, color balance) so the effect can be dialed from clean to gritty.

### 3.2 Use compute stages — and atomics

Compute shaders give you everything fragment shaders don't:

- **Atomic counters** for histogram-based effects, peak/average measurement, and order-independent scatter.
- **Workgroup-shared memory** for separable convolutions and reductions.
- **Storage buffers** for stateful particle simulations, trail buffers, and feedback that doesn't fit a single texture.
- **Shared accumulators** for things like "draw N quads scattered by a noise function" — emit straight into a buffer rather than doing N draw calls.

If an effect would need a complicated multi-pass setup with framebuffers, ask whether one compute pass with shared memory + atomics would do it more cleanly.

### 3.3 Don't be afraid of HDR / float textures

`rgba8unorm` clips at 1.0. For glow, bloom, motion blur trails, light wrapping, and any kind of accumulator, prefer **`rgba16float`** intermediate buffers. The cost is modest on modern GPUs and the headroom prevents the dingy, clipped look that low-precision pipelines have.

When the final output has to land in an 8-bit texture, do **tone mapping** at the last step rather than clamping — `x / (1 + x)` (Reinhard), ACES, or a custom S-curve are all easy.

### 3.4 Non-RGB color decompositions

RGB is an okay output space and a *terrible* control space. For anything that interacts with hue, saturation, brightness, warmth, or color temperature, work in:

- **HSV / HSL** for hue rotations, saturation pulls, and "vintage" desaturation.
- **YCbCr** when you want to separate luma manipulation (contrast, gamma, glow) from chroma manipulation (color shifts) cleanly — this is how film telecines work.
- **Oklab / Oklch** for perceptually-uniform color shifts, gradients, and complementary-color generation.
- **HCT / hue-rotation-with-perceived-brightness-preservation** for "rainbow shift" effects that don't get muddy.

A hue-rotation effect implemented in HSV is one line of math. The same effect in pure RGB is a 3×3 matrix that's hard to dial. Pick the right space.

### 3.5 Many primitives — rasterize geometry, don't loop per-pixel

To draw N particles / sprites / quads / splats, **do NOT loop over all of them inside a fragment or compute shader, one iteration per primitive per pixel.** That's `O(pixels × N)` — every pixel re-tests every particle even though each particle only covers a few pixels. It melts down the moment N or the resolution grows. This is *ShaderToy thinking* — ShaderToy can't emit geometry, so it fakes everything per-pixel. **We have real render stages. Push beyond it.** 😂

**Generate geometry and let the rasterizer do the work.** An instanced quad render pass costs only the *covered* area (`O(Σ primitive area)`), and the fixed-function blend hardware composites for free:

- An **update compute pass** owns the GPU-resident pool buffer (lifecycle, spawn, capture-at-spawn) — see §8.4 / §3.2.
- A **prefill** pass copies `tex_in → tex_out` (so the additive/alpha quads blend over the input).
- An **instanced render pass** draws 6 verts × `count` instances. The **vertex shader** reads the pool (`StructuredBuffer<Particle> : register(t0)`), looks up `SV_InstanceID`, and positions the quad at the particle's pos/size (use isotropic-uv so it's round on any aspect). **Dead particles collapse to a degenerate triangle outside clip space** (`pos = float4(2,2,2,1)`) so the rasterizer skips them — no compaction pass needed. The **fragment shader** shades only the covered fragments (mask, fade, color) and `discard`s out-of-mask pixels.
- The PSO picks the blend: `gpu::Device::createInstancedRenderPSO(vs, "main", fs, "main", fmt, bindings, gpu::Device::BlendMode::Additive /* or AlphaOver */)`, drawn via `gpu::RenderPass::beginLoad(out) → rp.setPSO/setBuffer/draw(6, count) → rp.end()`.

`wasm_modules/flash_particles/` (`vs.hlsl` + `fs_color.hlsl` + `fs_motion.hlsl`) and `wasm_modules/tingle_top/` (`vs.hlsl` + `fs.hlsl`) are the templates. Copy that shape for any pool.

**The only time a per-pixel loop is acceptable:** a very small, *fixed* number of primitives (≈10 or fewer) that **overlap heavily**, OR where you need **precise per-pixel control over how that small set combines** that the fixed blend hardware can't express — custom order-independent compositing, `min`/`max` accumulation, signed/clamped sums, soft metaball field merges, etc. (e.g. `source.light.bounce_resonator`'s 4 bands, `source.light.soft_glow`'s handful of blobs). Even then, reach for rasterization first; only loop when the small count *and* the precise-blend requirement both hold.

---

## 4. Randomness and stochasticity

Random behavior is what gives effects life. Use it deliberately, not by sprinkling `rand()` everywhere.

### 4.1 Discrete events: Poisson with exponential rate

For things that *fire* — particles spawning, glitches, flashes, MIDI-like triggers — use a **Poisson process**. The rate parameter follows an **exponential curve**:

| Slider value | Rate              |
|--------------|-------------------|
| `0.0`        | Off (no events)   |
| `0.5`        | 1 Hz              |
| `1.0`        | 60 Hz             |

Mapping: `rate_hz = pow(60.0, slider) - 1.0` (so `slider = 0` → 0, `slider = 1` → 59 Hz). Tweak constants if you want a different ceiling, but keep the exponential shape — it makes the slider feel "right".

Per-frame Poisson sample:

```cpp
// Expected events per frame.
float lambda = rate_hz * dt;
// Sample events in this frame. For small lambda, p(0) ≈ 1 - lambda is fine;
// for larger, draw n ~ Poisson(lambda) properly.
float u = rand_uniform();          // [0, 1)
if (u < 1.0f - expf(-lambda)) {
  fire_event();
}
```

This gives natural, irregular spacing — never the metronomic feel of `if (frame % N == 0)`.

### 4.2 Continuous random curves: sinusoidal LFO with random-walk rate

For things that *modulate continuously* — a wobbling parameter, a drifting glow color, a breathing intensity — combine a **sinusoidal LFO** (smooth, periodic) with a **random walk on the LFO's rate** (so it doesn't feel mechanical):

```cpp
// State per modulator
double lfo_phase;       // accumulator, [0,1)
double lfo_rate;        // current rate in Hz
double lfo_rate_target; // walk target
double walk_phase;      // accumulator for rate walk

// Per frame
walk_phase += dt * walk_rate;        // walk_rate is a tuning param
if (walk_phase >= 1.0) {
  walk_phase -= 1.0;
  lfo_rate_target = mean_rate * exp(rand_normal() * spread);
}
// Smoothly approach target
lfo_rate += (lfo_rate_target - lfo_rate) * (1.0 - exp(-dt / smoothing_time));
lfo_phase += dt * lfo_rate;
double value = sin(lfo_phase * 2.0 * PI);
```

The result: a sine wave whose period drifts in a believable, organic way. Two of these on different walk rates layer beautifully.

### 4.3 Stable noise hashes

For per-pixel / per-particle noise that should be **stable across frames**, use a hash of `(id, frame_chunk)` rather than `rand()`. `pcg`, `xxhash32`, or `wang_hash` are all fine. This lets you decorrelate without losing temporal coherence.

---

## 5. Debug surfaces

Complicated effects should ship with **debug layers** controllable via tuning parameters. Examples:

- A `debug_show_motion` boolean that overlays motion vectors as colored arrows.
- A `debug_show_buckets` boolean that visualizes the regions a Voronoi or spatial-hash effect divides the image into.
- A `debug_show_particles` boolean that draws particle hitboxes / IDs.

These are throwaway-feeling but indispensable when something looks wrong on stage. Hide them at the end of the schema (last `order:`) so they don't clutter the live UI, but always include them.

For `bool`-typed debug toggles, the `mute`-style schema entry works well:

```cpp
"\"debug_show_motion\":{\"type\":\"bool\",\"default\":false,\"io\":5,\"order\":99}"
```

---

## 6. Patterns to follow / patterns to avoid

### Follow

- Schema-driven parameters — declare in `state::Schema()`, never hand-roll `decl_param`.
- Compute pipelines — most effects in this repo land in a single compute dispatch. That's the right default.
- Output-only texture writes via `gpu::Device::renderTarget()`; rail / tap inputs via `gpu::Device::inputTexture(N)`.
- Named state fields that match the schema field names verbatim — the host maps state patches by string path.

### Avoid

- Wide-range non-normalized sliders ("frequency 1..10000 Hz"). Apply a curve and normalize.
- Hard-coded pixel sizes in shaders. Always derive from viewport.
- Magic numbers in the per-frame loop without a parameter behind them. Today's "looks pretty good" is tomorrow's "could we tweak this on stage?".
- Reading `elapsed_time` directly when `dt` would do the same job parameter-stably.
- Single-file dumps where the shader, schema, and state handling are all tangled. Match the brightness-contrast / solid-color shape.

---

## 7. Checklist before merging an effect

- [ ] Uses the per-instance ABI (§0): mutable state in `struct State` threaded via `self`; only immutable type-shared resources (PSOs, shader modules, samplers) are file-static. No file-static mutable state.
- [ ] All parameters declared in `state::Schema` with `order:` and a sensible `io:` flag.
- [ ] Standard params come first; tuning / debug params after.
- [ ] Every parameter is on a normalized range OR has a documented perceptual mapping in its description.
- [ ] No `time * rate` patterns — accumulators only.
- [ ] Spatial parameters are aspect-aware. Pivots use the cover-square convention.
- [ ] Compute pass uses appropriate texture format (consider `rgba16float` for accumulators).
- [ ] Many primitives (particles/sprites/quads) are rasterized as instanced geometry, NOT a per-pixel loop over the pool (§3.5). Per-pixel looping only for a tiny, heavily-overlapping set needing precise blend control.
- [ ] At least one tuning param exposes a debug-overlay layer if the effect has internal state worth visualizing.
- [ ] Unit / integration tests in `web/test/<effect>.test.ts` covering metadata + a handful of param settings (see existing per-effect tests for the pattern).
- [ ] The effect renders in the IDE at 1920×1080 without visible aspect-ratio issues. Drop a video on it and confirm it reads as natural and tweakable.

---

## Appendix: example field schema (annotated)

```cpp
state::init("video.warmgrade", {1, 0, 0},
  state::Schema()
    // Standard — the live performer reaches for these
    .floatField("warmth",        0.5f,  0.f, 1.f, state::PrimaryInput)  // perceptual: -1..+1 internal
    .floatField("saturation",    0.5f,  0.f, 1.f, state::PrimaryInput)
    .floatField("highlight_roll",0.3f,  0.f, 1.f, state::PrimaryInput)
    .float2Field("center",       {0.f, 0.f},      state::PrimaryInput)  // anchor (cover-square)
    .floatField("vignette",      0.4f,  0.f, 1.f, state::PrimaryInput)

    // Tuning — patch designer; placed later in the order
    .floatField("toe_amount",    0.2f,  0.f, 1.f, state::SecondaryInput)
    .floatField("shoulder",      0.7f,  0.f, 1.f, state::SecondaryInput)
    .floatField("asymmetry",     0.0f, -1.f, 1.f, state::SecondaryInput)

    // Debug — last
    .boolField("debug_split_view", false, state::SecondaryInput)
    .boolField("debug_show_centerline", false, state::SecondaryInput)

    // I/O
    .textureField("tex_in",  state::PrimaryInput)
    .textureField("tex_out", state::PrimaryOutput)
);
```

---

## 8. Triggered / stateful effects — patterns from the lights bundle

Distilled from building `plasma_beam_cannon` and friends. These apply to any effect with a phase machine (ADSR), an internal particle pool, or anything that fires on a cue.

> **Per-instance note:** the examples below show file-static state (`s_phase`,
> `s_pool`, `s_*_rng`, `s_gate_prev`, `s_cycle_count`, …) for brevity, but in the
> shipping code every one of these lives in a per-instance `struct State` (per
> §0) — the lights bundle and all others are fully on the instance ABI. When
> reading these patterns, mentally map each `s_foo` to `s->foo` (and any
> `on_state_ready` / RNG / pool state to a `State` member). The patterns (ADSR
> machine, Poisson triggers, Plummer softening, …) are unchanged; only their
> *storage* is per-instance.

### 8.1 Trigger surface — bool gate + event trigger + auto_rate

Standard three inputs (style guide §1.1 — expose lots of parameters):

- **`gate` (bool, PrimaryInput)** — momentary / rising-edge fires the cycle. The held state after the rising edge is **irrelevant**; the synthetic pulse drives the envelope to completion on its own timer. Inspector checkbox can stay checked without "stuck in sustain"; toggle false→true to re-fire.
- **`trigger` (event, PrimaryInput)** — one-shot; synthesizes the same pulse as a rising-edge gate. **Critical**: see §8.2 below.
- **`auto_rate` (float, 0..1, PrimaryInput)** — Poisson auto-trigger per §4.1. **Default to a small non-zero value** (typically 0.2 ≈ 1.6 Hz) so the IDE preview demonstrates motion immediately when the effect is dropped fresh. Production patches set it to 0 when MIDI / Resolume drives the cue explicitly.

Why momentary gate (not synth-style hold-to-sustain): the inspector checkbox is the primary tuning surface, and a held checkbox can't be quickly tapped. Hold-to-sustain semantics confuse users who expect "click → cycle plays." For *true* hold-to-sustain (continuous level signal from upstream), wire that to a separate continuous-level field — don't overload `gate`.

### 8.2 Event handlers — momentary, rising-edge detected

The executor replays **every** instance-state value as `PatchReplace` patches **every frame** (`executor.wasm`'s applyState rebuilds the patch set from the stored instance state each tick). Inspector hover and continuous-edit broadcasts can amplify this. An event field is **not** value-less — it round-trips through JSON like everything else, so its stored value is replayed too. Concretely, `event` fields are **momentary, on/off like a `bool` gate**: the inspector's trigger button sends `1` on press and `0` on release (`field-trigger.ts`), and whatever value last landed is what gets replayed.

So an event handler that fires whenever a `trigger` patch *arrives* re-arms itself forever — even with `auto_rate` at 0, the replayed `trigger: 0` re-fires the cycle on every return to IDLE:

```cpp
// ❌ BAD — fires on every replayed patch (any value), loops forever.
if (state::pathIs(path, plen, "trigger")) {
  s->trigger_pulse = true;
  s->trigger_hold_remaining = pulse_duration;
}

// ❌ ALSO BAD — a phase guard is NOT a fix. The replayed patch still arrives
// every frame; this just re-fires each time the effect lands back in IDLE.
if (state::pathIs(path, plen, "trigger") && s->phase == PHASE_IDLE) { … }
```

**The fix: rising-edge detection on the value**, exactly like `gate` (via `s->gate_prev`). Treat the event as a momentary binary and act only on the `0 → 1` transition. Replays of a constant value (0 *or* 1) never re-fire:

```cpp
// ✅ Replay-safe. A fresh press (0→1) fires once; releases and replays don't.
if (op == state::PatchReplace && state::pathIs(path, plen, "trigger")) {
  bool tval = state::patchFloat(i) != 0.0f;
  if (tval && !s->trigger_prev) {       // rising edge
    s->trigger_pulse = true;
    s->trigger_hold_remaining = pulse_duration;
  }
  s->trigger_prev = tval;
}
```

Store a `bool trigger_prev` in `State` (reset in `init`). Because the button is momentary (1→0 per click), repeated clicks are repeated rising edges → re-triggers work, including mid-cycle (same as a `gate` rising edge). If you genuinely want *idle-only* one-shots, you may AND in a `&& s->phase == PHASE_IDLE` — but that's a behavioral choice, **not** the replay defense. The rising edge is what makes it safe.

### 8.3 ADSR phase machine

Five states: `IDLE` / `ATTACK` / `DECAY` / `SUSTAIN` / `RELEASE`. State is `(phase, time_in_phase)`. Drive via an "effective gate" signal that's just the synthetic trigger pulse:

```cpp
bool effective_gate = s_trigger_pulse;
switch (s_phase) {
  case PHASE_IDLE:    if (effective_gate) enter_phase(PHASE_ATTACK); break;
  case PHASE_ATTACK:  if (!effective_gate) enter_phase(PHASE_RELEASE);
                      else if (time_in_phase >= attack_s) enter_phase(PHASE_DECAY); break;
  // ... etc
}
```

Pulse duration: `attack_s + decay_s + sustain_s`. After it expires, `effective_gate` falls, sustain transitions to release. Total cycle = `attack + decay + sustain + release` seconds.

**Per-phase curve params** (signed `[-1, +1]`, mapped via `fx::signedSliderToExp`): one per envelope phase that has a visible ramp.
```cpp
float t_curved = std::pow(t_in_phase, fx::signedSliderToExp(s_phase_curve));
```
`-1` → exp 8 → slow start, fast finish. `+1` → exp 1/8 → fast start, slow finish. Linear at 0.

For release effects whose visual decay is driven by other systems (particles, breaks, etc.), `release_curve` warps `release_t` **globally** at the top of those systems — so length targets, activation thresholds, and flicker onsets all shift together when the user dials it.

**Tick/render ordering caveat**: first tick after a transition does `enter_phase(X); time_in_phase = 0`. Render then sees `t = 0`. Tests that need a phase to be visibly active need **at least 2 ticks** (one to enter, one to accumulate `time_in_phase > 0`).

### 8.4 Particle pools (per-bar)

Per-bar pool with compile-time max + runtime count:
```cpp
static constexpr int MAX_PER_BAR = 32;
static CpuParticle s_pool[BARS][MAX_PER_BAR];   // pre-allocated
// runtime `count_per_bar` clamped to MAX, inactive slots set to safe values
```

**Active-flag pattern**: compute `is_active[i]` once per tick (from age, threshold, lifetime, etc.). Gate every later operation — forces, length controller, render — by that flag. Inactive particles must contribute zero force AND not appear in rendering. Don't try to keep inactive particles "partially in" the simulation; it gets messy.

**Lazy pop-to-min on first activation**: initialize particles with `size = 0`, then on first frame they're active set `size = min_size`. Avoids the awkward "size grows from 0 invisibly for 3 ticks before becoming visible" — particles pop into existence at minimum visible size, then the length controller takes over.

**Staggered activation thresholds**: instead of all particles entering simultaneously, give each one a random `threshold` in `[activation_min, 1.0]` shaped by a power curve. They activate one-by-one over the lifetime instead of popping all at once. Use the standard signed-slider exp mapping for the curve param.

### 8.5 N-body forces — Plummer softening

The pair force `1/r²` is singular at close range. Two particles that seed even slightly close produce arbitrarily large velocity changes — even with a tiny strength multiplier. Use Plummer softening:
```cpp
float d_sq = abs_dy * abs_dy + softening * softening;
force[i] += sign * strength / d_sq;
```
At `dy = 0`, force tops out at `strength / softening²` — bounded. Expose `softening` as a tuning param (~0.05 in uv-space is a good default for 1D bar-height sims). The hard floor variant (`d = max(abs_dy, floor)`) works too but introduces a discontinuity at the floor; Plummer is smooth and standard.

### 8.6 Bimodal distributions for visual variety

When you want particles to visibly fall into two visual classes (e.g. some breaks "stay small," others "grow large"), use **binary class assignment with per-particle personal max**, not a continuous distribution:
```cpp
bool wants_to_grow = rand_unit() < s_growth_fraction;
p.personal_max_size = wants_to_grow ? s_max_size : s_min_size;
```
Then the global length-controller (or whatever drives size) clamps each particle to its personal max. Continuous distributions tend to look uniform — "everything is medium" — even when statistically they shouldn't. Hard binary gives the eye distinct visual classes.

### 8.7 Per-particle teleport for organic churn

Stochastic teleport of active particles keeps a field from settling into static configurations. Use size-biased rates: small particles teleport often, large ones never. Mapping:
```cpp
float size_factor = 1.0f - size_normalized;          // 1 at min, 0 at max
float rate_hz = std::pow(60.0f, s_teleport_rate) - 1.0f;   // §4.1 mapping
float lambda = rate_hz * size_factor * dt;
if (rand_unit() < 1.0f - std::exp(-lambda)) p.y = rand_unit();
```
Add as a tuning knob (`teleport_rate` slider). At 0 the field locks down; cranking up animates it.

### 8.8 Cycle seed — deterministic per-trigger pattern

If you want each trigger to produce a fresh-but-deterministic random pattern (e.g. a different break arrangement each cycle):
```cpp
static int s_cycle_count = 0;
// On phase entry into the relevant state:
if (s_cycle_seed_enabled) s_cycle_count++;
// In your seeding code:
uint32_t effective_seed = (uint32_t)s_user_seed + (uint32_t)s_cycle_count;
```
Expose `cycle_seed` as a bool toggle. Default `true` for variety; flip off to lock the exact same pattern every trigger (useful for staging deterministic cues). **Don't** rely on global RNG drift from other systems (auto-trigger Poisson, etc.) — it works but is fragile across HMR, instance recreation, and changes to unrelated stochastic code.

### 8.9 Separate RNG streams

For unrelated stochastic operations (auto-trigger Poisson, per-particle teleport, seed generation), use **separate LCG state variables**:
```cpp
static uint32_t s_autotrigger_rng = 0xCAFEBABEu;
static uint32_t s_break_op_rng    = 0xBADDCAFEu;
```
Independent streams mean toggling `auto_rate` doesn't subtly shift teleport timing, and changing one tuning param doesn't ripple unrelated stochastic state.

### 8.10 Strict on/off rendering — "no alpha fades"

For hard-edge aesthetics (90s anime, glitch, etc.), render decisions are boolean trees with passthrough as the default:
```hlsl
if (!active)                      { out = passthrough; return; }
if (out_of_bar)                   { out = passthrough; return; }
if (out_of_beam_extent)           { out = passthrough; return; }
if (flicker_on == 0)              { out = passthrough; return; }
if (covered_by_solid_break)       { out = passthrough; return; }
out = beam_color * intensity;
```
No alpha computed anywhere. Tests use `expectPixelAt` for exact pixel assertions or `expectCoverage` for coverage thresholds; avoid soft-edge tolerance values.

### 8.11 Param order matters in test runners

The E2E runner applies `params: [...]` in array order. Rising-edge handlers compute pulse durations from THEN-CURRENT timing values. **Always set timing params before any field that triggers on rising edge**:
```ts
params: [
  ['attack_s', 0.05],
  ['decay_s',  0.05],
  ['release_s', 1.0],
  ['gate', 1.0],     // ← LAST so gate's pulse hold uses the small values
]
```
Otherwise gate fires with default-value pulse durations and your test ends up in a different phase than you expected.

### 8.12 Cross-cutting recipe — checklist for a new triggered effect

- [ ] Three trigger inputs: `gate` (bool, rising edge), `trigger` (event, momentary — rising-edge detected on its value, §8.2), `auto_rate` (Poisson, sensible default > 0).
- [ ] Pulse duration = `attack + decay + sustain_s` (so one-shots auto-complete through sustain).
- [ ] Per-phase `*_curve` params via `fx::signedSliderToExp`.
- [ ] Tick/render: phase transition resets `time_in_phase = 0`, so the first render after transition sees `t = 0`. Tests need `ticks: 2` minimum to see in-phase visible state.
- [ ] Pool of particles: compile-time max + runtime count, `is_active[]` gating everything, lazy pop-to-min on activation, staggered activation thresholds.
- [ ] Plummer softening on any 1/r² force.
- [ ] Bimodal distributions where you want visual variety.
- [ ] Separate RNG streams for unrelated stochastic operations.
- [ ] `cycle_seed` bool for trigger-to-trigger pattern variety.
- [ ] All curves use the standard signed-slider exp mapping; default 0 (linear).
- [ ] Strict on/off rendering decisions, no alpha (when aesthetic calls for it).

