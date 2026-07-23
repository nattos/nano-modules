#pragma once
/*
 * module_api.h — Module registration API.
 *
 * Each WASM module exports a single entry point `nano_module_main()`.
 * It calls the imported `register_effect()` once per effect it provides.
 * The descriptor struct's first field is a version number for forward compat.
 *
 * v2 (canonical, class-like instances): effects are no longer a bag of
 * file-static free functions. The descriptor exposes:
 *   - `module_init()`  — run once per effect TYPE: register shaders, create
 *                        the shared compute PSO, publish the schema prototype,
 *                        declare fusion type metadata.
 *   - `create()`       — construct a per-instance state object and return an
 *                        opaque pointer (the effect's `State*`). The host
 *                        threads this back as `self` on every instance call.
 *   - `destroy(self)`  — release the per-instance state.
 *   - `init/tick/render/on_state_patched(self, ...)` —
 *                        per-instance lifecycle; all take `self` first.
 *
 * There is no backward-compat v1 path — the old free-function ABI is gone.
 */

#include <cstdint>

// ── Host↔effect ABI version ────────────────────────────────────────────────
// Version of the host<->effect CONTRACT: which host imports exist (and their
// signatures) and which effect callbacks the host drives. This is DISTINCT
// from a Schema's effectVersion / moduleVersion (per-effect/module SEMANTICS).
//
// The effect descriptor is registered by STRING NAME (see the builder protocol
// below), so the common kinds of growth no longer touch this version: adding a
// new optional lifecycle hook or a new metadata field is fully back/forward
// compatible — the host looks names up and treats an absent name as "not
// provided". Only a SMALLER class of changes needs a bump: changing the
// signature/semantics of an EXISTING import or callback, or renaming/removing
// one. A bundle built before this existed exports no `nano_abi_version()`; the
// host reads that absence as version 0.
//
// ── ABI evolution conventions (how to grow WITHOUT bumping) ──────────────
// Pick the mechanism by call class:
//   • Effect exports (host → effect): name-keyed via register_effect_fn.
//     New hook = new name; absent name = "not provided". A signature change
//     is a NEW name, never a mutation of an existing one.
//   • Hot-path host imports (per-frame: effrt drive, param/texture set,
//     dispatch/draw): FLAT scalar args only — never descriptor-ify these.
//     Signature evolution = a new import name (the `_v2` pattern, e.g.
//     gpu.create_compute_pso_v2).
//   • Setup-time host imports whose OPTIONS accumulate (samplers, pass
//     descriptors, PSO creation): a SIZED DESCRIPTOR STRUCT — first field is
//     the struct's own byte size; the host reads min(sent, known) and
//     defaults the rest. Appending a field is then non-destructive with no
//     new name (see gpu.h SamplerDesc for the canonical example). Fields are
//     4-byte scalars in declaration order (no padding surprises across the
//     wasm boundary).
//   • Binary blobs with hard-coded layouts (state.read's Field[]/PODs, the
//     effrt read_triggers event layout, packed spec constants) are covered by
//     THIS version number — changing one is a breaking change and bumps it.
//
//   1 — name-keyed effect registration + the effrt + state/gpu/host/canvas/
//       resolume/text/module/io/val import surface as of 2026-06.
//   2 — V1-gate cleanup (2026-07): the `canvas` import module, the
//       state.set / state.declare_param / state.register_fusion (dual-source)
//       imports, and gpu.create_compute_pso_layout /
//       gpu.create_instanced_render_pso (non-layout) are REMOVED — hosts no
//       longer register them, so a bundle built against ABI 1 that imported
//       any of them fails to instantiate. Rebuild against current headers.
//       Also: gpu.create_buffer takes an i64 size, and gpu.create_sampler
//       takes a sized SamplerDesc pointer (was two flat ints).
//   3 — streams surface (2026-07): the `streams` import module (streams.h) —
//       identity-derived i64 handles, the sized StreamDesc (grows by APPEND,
//       no bump), flat f64 position/duration calls, and the FIXED 5-double
//       event record [time, kind, clipOrdinal, clipIdHash48, channel]. The
//       event record's layout is covered by this version; new import names
//       (streams.seek, streams.frame_at), new Kind/Flags values, and new
//       reserved transport_* published-output field names stay name-keyed
//       (no bump).
//   4 — resources surface (2026-07): the `resources` import module
//       (resources.h) — the ASSET namespace behind streams. Identity-derived
//       i64 handles in a disjoint domain ("res:clip:<id>"), the sized 64-byte
//       ResourceDesc (grows by APPEND, no bump), resources.stream fetches the
//       seekable-stream view, resources.fork arms the owner-controlled
//       successor used by transition effects. New resource Kind/Flags values
//       and future view ops (data/texture) stay name-keyed (no bump).
#define NANO_ABI_VERSION 4

// Emit the exported `nano_abi_version()` accessor. Each bundle's aggregator
// TU (the one that defines nano_module_main) invokes this ONCE at file scope.
// `used` + `export_name` keep it from being dead-stripped and fix the export
// name regardless of C++ mangling — no per-bundle linker flag needed.
#define NANO_EXPORT_ABI_VERSION()                                              \
  extern "C" __attribute__((used, export_name("nano_abi_version")))           \
  int32_t nano_abi_version(void) { return NANO_ABI_VERSION; }

// The host provides effect registration as imports.
//
// Boundary representation: on WASM the effect descriptor is NOT passed as a
// fixed-layout struct (no byte offsets cross the host boundary). Each piece is
// registered by STRING NAME via a small builder protocol — begin() → a
// sequence of str()/fn() → end(). Adding a new metadata field or lifecycle
// hook later needs no change to the host-side readers and no ABI version bump;
// the host just looks the name up and treats an absent name as "not provided".
// `register_effect_fn` takes the callback as a void*: on wasm32 a function
// pointer's value IS its indirect-function-table index (an i32), so the host
// stores that index keyed by name and call_indirects it.
//
// On a NATIVE build (statically-linked effects, no WASM in the loop) there is
// no boundary to cross — registerEffect() hands the in-process struct straight
// to nano_register_effect(), which the runtime reads directly.
#if defined(__wasm__)
extern "C" {
__attribute__((import_module("module"), import_name("register_effect_begin")))
int32_t nano_register_effect_begin(void);
__attribute__((import_module("module"), import_name("register_effect_str")))
void nano_register_effect_str(int32_t handle, const char* name, int32_t name_len,
                              const char* value, int32_t value_len);
__attribute__((import_module("module"), import_name("register_effect_fn")))
void nano_register_effect_fn(int32_t handle, const char* name, int32_t name_len,
                             void* fn);
__attribute__((import_module("module"), import_name("register_effect_end")))
void nano_register_effect_end(int32_t handle);
}
#else
extern "C" {
void nano_register_effect(const void* desc_ptr);
}
#endif

namespace nano {

/// Version 2 of the effect registration descriptor (the canonical ABI).
/// All char pointers are to null-terminated strings in WASM linear memory.
/// Function pointers are WASM indirect-function-table indices.
struct EffectDesc_v2 {
    int32_t struct_version;     // Must be 2

    // Metadata
    const char* id;             // Module identifier, e.g. "com.nano.brightness_contrast"
    const char* name;           // Display name, e.g. "Brightness & Contrast"
    const char* description;    // Human-readable description
    const char* category;       // e.g. "Video", "Source", "Data"
    const char* keywords;       // Comma-separated, e.g. "color,adjust"
    const char* icon;           // Optional web picker glyph — a Line Awesome
                                // class, e.g. "la-bolt" (nullptr => none). Part
                                // of the metadata block so positional inits read
                                // { 2, id, name, desc, cat, kw, icon, LIFECYCLE… }.

    // Type-level: run once per effect type before any instance is created.
    // KEEP THIS CHEAP + SYNCHRONOUS (schema, PSO registration). It re-runs on
    // every FRESH host — and the arrangement builds a fresh host each time a clip
    // is re-entered — so heavy work here (decode a multi-MB atlas, build a big
    // LUT) re-pays as a playback hitch on every re-entry. Move that to the
    // cooperative warm lifecycle below.
    void  (*module_init)();

    // RESERVED (design only — not yet wired; a post-V1 growth point). The
    // cooperative WARM lifecycle for heavy, TYPE-shared resources. See
    // EFFECTS_STYLE_GUIDE.md §"Heavy one-time resources — the cooperative
    // warm lifecycle". Name-keyed registration means wiring this later is
    // non-breaking.
    //   void module_warm();     // async, idempotent, type-level: acquire heavy
    //                           // SHARED resources (atlas/LUT/data) into module-
    //                           // static storage. Host calls ONCE per type during
    //                           // warmup/precache, OFF the playback path, and keeps
    //                           // the result resident across instance churn — so a
    //                           // clip re-entry pays nothing.
    //   void module_release();  // optional + cooperative: host MAY call under
    //                           // memory pressure to free what module_warm got;
    //                           // the effect re-acquires lazily on next use.
    // The effect declares WHAT is heavy + HOW to free it; the host owns WHEN.
    // (The GPU-compile half — shaders/PSOs — is already cached engine-side by
    // content and shared across instances; effects need do nothing for that.)

    // Instance lifecycle.
    void* (*create)();                  // construct + return per-instance state
    void  (*destroy)(void* self);       // release per-instance state
    void  (*init)(void* self);          // per-instance constructor tail
    void  (*tick)(void* self, double dt);
    void  (*render)(void* self, int vp_w, int vp_h);
    void  (*on_state_patched)(void* self, int n, const char* pb,
                              const int* off, const int* len, const int* ops);

    // Optional: pure passthrough predicate. Returns nonzero when the
    // effect, with its CURRENT applied state, is an identity (output ==
    // primary input) this frame — lets the executor skip the effect's
    // dispatch entirely and alias input→output (zero GPU work for non-
    // final stages; the final stage's result is just the input handle).
    // Contract:
    //   - side-effect free (a pure function of current param state),
    //   - only ever returns nonzero for STATELESS configs. An effect
    //     with per-frame state (particles, feedback, accumulators) must
    //     NOT report identity, since skipping a frame freezes/desyncs
    //     its simulation.
    // Trailing + optional: aggregate-init omits it (=> nullptr) for the
    // many effects that don't supply one, and nullptr means "never
    // skippable".
    int32_t (*is_identity)(void* self);

    // Optional: called when the host toggles this effect's "device" on/off
    // (Resolume "bypass" / Live "on light"). `active` is 1 when the device
    // is turned ON, 0 when turned OFF. Fired only on a transition, so the
    // effect can release/reacquire heavy resources, reset simulations, or
    // mute side-channels. While OFF the effect receives NO other calls
    // (no tick/render/state) and the host aliases its input→output.
    // Trailing + optional: nullptr means "don't care".
    void (*on_active)(void* self, int32_t active);

    // Optional: drive a STATEFUL effect to an arbitrary point in time without
    // ticking every intervening frame. The effect should prefill its internal
    // state (accumulators, feedback buffers, particle pools, …) as if it had
    // been running from `from_seconds` to `to_seconds`, so the next render()
    // produces the frame at `to_seconds`. May be SLOW (a long prefill). The
    // host only calls this for effects that declare the `seekable_prefill`
    // capability (see Capability in host.h). Trailing + optional: nullptr means
    // "not seekable via prefill" (the conservative default — the host must
    // replay frame-by-frame, or skip seeking, per the effect's other temporal
    // capabilities). RESERVED: declared as ABI; no effect implements it and
    // no executor calls it yet — an intended post-V1 growth point (kept, not
    // deleted, because the whole seek path — effrt_seek → doSeek → this — is
    // already plumbed end to end).
    void (*seek)(void* self, double from_seconds, double to_seconds);

    // Optional: STATIC (self-less) inspector-visibility evaluator. A pure
    // function of state: given a candidate state (marshaled like
    // on_state_patched — full set of replace ops, one per authored field), the
    // effect calls state::setFieldHidden(...) for exactly the fields its current
    // mode hides. No `self` — it touches only the type-shared schema, never
    // instance state, so the host can resolve field visibility for a clip whose
    // instance is NOT executing (off-playhead / multi-select) WITHOUT standing
    // up a live instance. Declaring this is the opt-in signal that an effect's
    // visibility is derivable purely from state; effects that omit it are
    // assumed to have no dynamic visibility (or to require a live run). The
    // host calls it off the render path and reads back the resulting hidden set.
    // Native barrels never call it (no inspector); web/editor only.
    // Trailing + optional: nullptr means "no static visibility evaluator".
    void (*eval_visibility)(int n, const char* pb,
                            const int* off, const int* len, const int* ops);

    // Optional picker glyph (web frontends only; native barrels ignore it). An
    // effect may declare EITHER an `icon` (in the metadata block above) OR a
    // `thumbnail`; the picker prefers the thumbnail. This one sits at the TAIL so
    // the 100+ positional `registerEffect({ 2, id, name, ... })` inits that don't
    // ship a thumbnail stay valid — omitting it value-initializes to nullptr.
    //   thumbnail — a small (≈32×32) PNG, base64-encoded (bare, no data: prefix).
    //               The web UI wraps it in a data: URI, length-capped.
    // Crosses the boundary as an ordinary name-keyed metadata string, so it needs
    // no ABI version bump (absent name == not provided).
    const char* thumbnail;
};

/// Register an effect with the host. On WASM this emits the name-keyed builder
/// protocol (the descriptor struct is just a local staging buffer and never
/// crosses the boundary); on native it hands the struct straight to the
/// in-process runtime.
inline void registerEffect(const EffectDesc_v2& d) {
#if defined(__wasm__)
    const int32_t h = nano_register_effect_begin();
    auto str = [&](const char* key, const char* val) {
        if (val) nano_register_effect_str(h, key, __builtin_strlen(key),
                                          val, __builtin_strlen(val));
    };
    auto fn = [&](const char* key, const void* f) {
        if (f) nano_register_effect_fn(h, key, __builtin_strlen(key),
                                       const_cast<void*>(f));
    };
    str("id", d.id);
    str("name", d.name);
    str("description", d.description);
    str("category", d.category);
    str("keywords", d.keywords);
    str("icon", d.icon);            // optional web picker glyph (Line Awesome class)
    str("thumbnail", d.thumbnail);  // optional web picker glyph (base64 PNG)
    fn("module_init",      reinterpret_cast<void*>(d.module_init));
    fn("create",           reinterpret_cast<void*>(d.create));
    fn("destroy",          reinterpret_cast<void*>(d.destroy));
    fn("init",             reinterpret_cast<void*>(d.init));
    fn("tick",             reinterpret_cast<void*>(d.tick));
    fn("render",           reinterpret_cast<void*>(d.render));
    fn("on_state_patched", reinterpret_cast<void*>(d.on_state_patched));
    fn("is_identity",      reinterpret_cast<void*>(d.is_identity));
    fn("on_active",        reinterpret_cast<void*>(d.on_active));
    fn("seek",             reinterpret_cast<void*>(d.seek));
    fn("eval_visibility",  reinterpret_cast<void*>(d.eval_visibility));
    nano_register_effect_end(h);
#else
    nano_register_effect(&d);
#endif
}

/// Fluent "new style" registration. Equivalent to filling an EffectDesc_v2 and
/// calling registerEffect(), but reads as named per-callback registration at
/// the call site and only mentions the hooks an effect actually provides:
///
///   nano::EffectBuilder("com.nano.foo")
///       .name("Foo").category("Video").keywords("a,b")
///       .moduleInit(&foo::module_init)
///       .create(&foo::create).destroy(&foo::destroy).init(&foo::init)
///       .tick(&foo::tick).render(&foo::render)
///       .onStatePatched(&foo::on_state_patched)
///       .isIdentity(&foo::is_identity)   // optional: omit to not register it
///       .register_();
class EffectBuilder {
public:
    explicit EffectBuilder(const char* id) { d_.struct_version = 2; d_.id = id; }

    EffectBuilder& name(const char* v)        { d_.name = v; return *this; }
    EffectBuilder& description(const char* v)  { d_.description = v; return *this; }
    EffectBuilder& category(const char* v)     { d_.category = v; return *this; }
    EffectBuilder& keywords(const char* v)     { d_.keywords = v; return *this; }
    // Optional web picker glyph — an `icon` (Line Awesome class, e.g. "la-bolt")
    // OR a `thumbnail` (base64 PNG). The picker prefers the thumbnail.
    EffectBuilder& icon(const char* v)         { d_.icon = v; return *this; }
    EffectBuilder& thumbnail(const char* v)    { d_.thumbnail = v; return *this; }

    EffectBuilder& moduleInit(void (*f)())             { d_.module_init = f; return *this; }
    EffectBuilder& create(void* (*f)())                { d_.create = f; return *this; }
    EffectBuilder& destroy(void (*f)(void*))           { d_.destroy = f; return *this; }
    EffectBuilder& init(void (*f)(void*))              { d_.init = f; return *this; }
    EffectBuilder& tick(void (*f)(void*, double))      { d_.tick = f; return *this; }
    EffectBuilder& render(void (*f)(void*, int, int))  { d_.render = f; return *this; }
    EffectBuilder& onStatePatched(
        void (*f)(void*, int, const char*, const int*, const int*, const int*)) {
        d_.on_state_patched = f; return *this;
    }
    EffectBuilder& isIdentity(int32_t (*f)(void*))     { d_.is_identity = f; return *this; }
    EffectBuilder& onActive(void (*f)(void*, int32_t)) { d_.on_active = f; return *this; }
    EffectBuilder& seek(void (*f)(void*, double, double)) { d_.seek = f; return *this; }
    EffectBuilder& evalVisibility(
        void (*f)(int, const char*, const int*, const int*, const int*)) {
        d_.eval_visibility = f; return *this;
    }

    void register_() const { registerEffect(d_); }

private:
    EffectDesc_v2 d_{};
};

} // namespace nano

// Lifecycle fields for an effect using the class-like instance ABI
// (module_init/create/destroy + self-taking callbacks). Use inside
// nano_module_main:
//
//   nano::registerEffect({ 2, "id","Name","desc","cat","kw","la-icon",
//                          NANO_INSTANCE_LIFECYCLE(my_effect) });
// (the icon slot is nullable — pass nullptr for no picker glyph.)
#define NANO_INSTANCE_LIFECYCLE(ns)                                           \
    ns::module_init, ns::create, ns::destroy, ns::init,                       \
    ns::tick, ns::render, ns::on_state_patched

// Forward-declare an effect namespace's entry points for the class-like
// instance ABI (paired with NANO_INSTANCE_LIFECYCLE).
#define NANO_DECLARE_INSTANCE_EFFECT(ns)                                      \
  namespace ns {                                                              \
    void  module_init();                                                      \
    void* create();                                                           \
    void  destroy(void* self);                                                \
    void  init(void* self);                                                   \
    void  tick(void* self, double dt);                                        \
    void  render(void* self, int vp_w, int vp_h);                             \
    void  on_state_patched(void* self, int n, const char* pb, const int* off,\
                           const int* len, const int* ops);                   \
    /* Optional static visibility evaluator (EffectDesc_v2.eval_visibility):  \
       declared for every effect, defined only by those that opt in. */       \
    void  eval_visibility(int n, const char* pb, const int* off,             \
                          const int* len, const int* ops);                    \
  }
