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
