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
// signatures), which effect exports the host drives, and the EffectDesc_v2
// trailing-field set. This is DISTINCT from:
//   - EffectDesc_v2::struct_version — the descriptor STRUCT identity (still 2);
//   - a Schema's effectVersion / moduleVersion — per-effect/module SEMANTICS.
// Bump it on ANY change to the contract (a new/renamed host import, a new
// effect export, an added descriptor field) so the executor can detect an
// older-ABI bundle and shim it (synthesize a missing export's default, skip a
// descriptor field that didn't exist, adapt a changed import). A bundle built
// before this existed exports no `nano_abi_version()`; the host reads that
// absence as version 0 (legacy / pre-versioning).
//
//   1 — first versioned contract: EffectDesc_v2 carries the trailing `seek`
//       field; effrt + state/gpu/host/canvas/resolume/text/module/io/val import
//       surface as of 2026-06.
#define NANO_ABI_VERSION 1

// Emit the exported `nano_abi_version()` accessor. Each bundle's aggregator
// TU (the one that defines nano_module_main) invokes this ONCE at file scope.
// `used` + `export_name` keep it from being dead-stripped and fix the export
// name regardless of C++ mangling — no per-bundle linker flag needed.
#define NANO_EXPORT_ABI_VERSION()                                              \
  extern "C" __attribute__((used, export_name("nano_abi_version")))           \
  int32_t nano_abi_version(void) { return NANO_ABI_VERSION; }

// The host provides this callback as an import.
extern "C" {
__attribute__((import_module("module"), import_name("register_effect")))
void nano_register_effect(const void* desc_ptr);
}

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

    // Type-level: run once per effect type before any instance is created.
    void  (*module_init)();

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
    // capabilities). NOTE: declared as ABI; no effect implements it yet.
    void (*seek)(void* self, double from_seconds, double to_seconds);
};

/// Register an effect with the host.
inline void registerEffect(const EffectDesc_v2& desc) {
    nano_register_effect(&desc);
}

} // namespace nano

// Lifecycle fields for an effect using the class-like instance ABI
// (module_init/create/destroy + self-taking callbacks). Use inside
// nano_module_main:
//
//   nano::registerEffect({ 2, "id","Name","desc","cat","kw",
//                          NANO_INSTANCE_LIFECYCLE(my_effect) });
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
  }
