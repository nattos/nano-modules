#pragma once
/*
 * module_api.h — Module registration API.
 *
 * Each WASM module exports a single entry point `nano_module_main()`.
 * It calls the imported `register_effect()` once per effect it provides.
 * The descriptor struct's first field is a version number for forward compat.
 */

#include <cstdint>

// The host provides this callback as an import.
extern "C" {
__attribute__((import_module("module"), import_name("register_effect")))
void nano_register_effect(const void* desc_ptr);
}

namespace nano {

/// Version 1 of the effect registration descriptor.
/// All char pointers are to null-terminated strings in WASM linear memory.
/// Function pointers are WASM indirect-function-table indices.
struct EffectDesc_v1 {
    int32_t struct_version;     // Must be 1

    // Metadata
    const char* id;             // Module identifier, e.g. "com.nattos.brightness_contrast"
    const char* name;           // Display name, e.g. "Brightness/Contrast"
    const char* description;    // Human-readable description
    const char* category;       // e.g. "Video", "Source", "Data"
    const char* keywords;       // Comma-separated, e.g. "color,adjust"

    // Required callbacks
    void (*init)();
    void (*tick)(double dt);
    void (*render)(int vp_w, int vp_h);
    void (*on_state_patched)(int n, const char* pb, const int* off, const int* len, const int* ops);

    // Optional callbacks (nullptr if not supported)
    void (*on_resolume_param)(long long param_id, double value);
};

/// Register an effect with the host.
inline void registerEffect(const EffectDesc_v1& desc) {
    nano_register_effect(&desc);
}

} // namespace nano
