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
 *   - `init/tick/render/on_state_patched/on_resolume_param(self, ...)` —
 *                        per-instance lifecycle; all take `self` first.
 *
 * There is no backward-compat v1 path — the old free-function ABI is gone.
 */

#include <cstdint>

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
    const char* id;             // Module identifier, e.g. "com.nattos.brightness_contrast"
    const char* name;           // Display name, e.g. "Brightness/Contrast"
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

    // Optional callbacks (nullptr if not supported)
    void  (*on_resolume_param)(void* self, long long param_id, double value);
};

/// Register an effect with the host.
inline void registerEffect(const EffectDesc_v2& desc) {
    nano_register_effect(&desc);
}

} // namespace nano

// Legacy-effect adapter: expands to the 8 EffectDesc_v2 lifecycle fields
// for an effect that still uses the old free-function ABI
// (init()/tick(double)/render(int,int)/on_state_patched(...)). On WASM
// each chain entry is its own module instance, so file-static state is
// already per-instance — the adapter just forwards the self-threaded
// callbacks to the legacy free functions (ignoring self). module_init is
// null (the legacy init() does all setup), create returns a non-null
// sentinel so the host has a self handle. Use inside nano_module_main:
//
//   nano::registerEffect({ 2, "id","Name","desc","cat","kw",
//                          NANO_LEGACY_LIFECYCLE(my_effect) });
//
// Effects that genuinely need per-instance state in the native barrel
// (fusion effects, or any used multiple times in one native chain) are
// converted to the real instance API instead of using this.
#define NANO_LEGACY_LIFECYCLE(ns)                                             \
    /* module_init */ nullptr,                                                \
    /* create      */ []() -> void* { return (void*)1; },                     \
    /* destroy     */ [](void*) {},                                           \
    /* init        */ [](void* self) { (void)self; ns::init(); },             \
    /* tick        */ [](void* self, double dt) { (void)self; ns::tick(dt); },\
    /* render      */ [](void* self, int w, int h) { (void)self; ns::render(w, h); }, \
    /* on_patched  */ [](void* self, int n, const char* pb, const int* o,     \
                         const int* l, const int* op) {                       \
                        (void)self; ns::on_state_patched(n, pb, o, l, op);    \
                      },                                                       \
    /* on_resolume */ nullptr

// Lifecycle fields for an effect that has been converted to the real
// class-like instance ABI (module_init/create/destroy + self-taking
// callbacks). Use inside nano_module_main:
//
//   nano::registerEffect({ 2, "id","Name","desc","cat","kw",
//                          NANO_INSTANCE_LIFECYCLE(my_effect) });
#define NANO_INSTANCE_LIFECYCLE(ns)                                           \
    ns::module_init, ns::create, ns::destroy, ns::init,                       \
    ns::tick, ns::render, ns::on_state_patched, ns::on_resolume_param

// Forward-declare an effect namespace's entry points. Two variants:
//   _LEGACY  — old free-function ABI (paired with NANO_LEGACY_LIFECYCLE)
//   _INSTANCE — new class-like ABI (paired with NANO_INSTANCE_LIFECYCLE)
#define NANO_DECLARE_LEGACY_EFFECT(ns)                                        \
  namespace ns {                                                              \
    void init();                                                              \
    void tick(double dt);                                                     \
    void render(int vp_w, int vp_h);                                          \
    void on_state_patched(int n, const char* pb, const int* off,             \
                          const int* len, const int* ops);                    \
  }
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
    void  on_resolume_param(void* self, long long param_id, double value);    \
  }
