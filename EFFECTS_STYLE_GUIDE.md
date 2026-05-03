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
| `<effect_blur.h>`   | `fx::GaussianBlur`  | Two-pass separable Gaussian. `applyWithRadius(in, out, w, h, radius, quality)` does the whole thing. Tap locations are stable as `radius` modulates — no shimmer. **Use this for bloom, glow, depth-of-field, soft shadows, AO, energy diffusion, oil-paint stylizations, etc.** Bundle's `build.sh` must list `compile_shaders_compute blur`. |

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

When an effect has multiple "shapes" controlled by a mode selector (Span vs Inset crop, RGB vs HSV picker, …), register *every* parameter the effect can ever expose in `init()`. Then use `state::setOnStateReady` to register a callback that — fired once after init + the initial state replay — calls `state::setFieldHidden(path, hidden)` to hide whichever fields the active mode doesn't use. In `on_state_patched`, when the mode field changes, re-run the visibility logic.

```cpp
.selectField("mode", ModeSpan, state::PrimaryInput, {{"Span", 0}, {"Inset", 1}})
.floatField("width", 1.0f, 0.f, 1.f, state::PrimaryInput)        // span-only
.floatField("inset_left", 0.0f, 0.f, 1.f, state::PrimaryInput)   // inset-only
…

void init() {
  state::init(...);
  state::setOnStateReady(&on_state_ready);
}
static void on_state_ready() { apply_mode_visibility(); }
void on_state_patched(...) {
  /* update s_mode etc. */
  if (mode_changed) apply_mode_visibility();
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

`fx::FastBlur` (header utility planned alongside `fx::GaussianBlur`) wraps the dual-filter pattern: bind a multi-mip scratch, alternate `setTextureMip` reads and writes through the down/up chain, sample at LOD 0 of each single-mip view. See `video.fast_blur` for the canonical implementation.

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

- [ ] All parameters declared in `state::Schema` with `order:` and a sensible `io:` flag.
- [ ] Standard params come first; tuning / debug params after.
- [ ] Every parameter is on a normalized range OR has a documented perceptual mapping in its description.
- [ ] No `time * rate` patterns — accumulators only.
- [ ] Spatial parameters are aspect-aware. Pivots use the cover-square convention.
- [ ] Compute pass uses appropriate texture format (consider `rgba16float` for accumulators).
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
