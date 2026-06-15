#pragma once
/*
 * effrt.h — the effect-orchestration host ABI the unified executor
 * (sketch_executor → executor.wasm) calls to drive effect instances. The
 * executor never touches an EffectInstance directly: it acquires an OPAQUE
 * int32 instance handle for a (module_type, instance_key) and drives the
 * instance's params / textures / lifecycle through these calls.
 *
 * Dual-impl like the effect headers and exec_gpu.h: under __wasm__ each
 * function is a host import from the "effrt" module; natively the attributes
 * drop and the linker binds to native/src/runtime/effrt_impls.cpp, which maps
 * handles to effect_runtime::EffectInstance* over the current EffectRuntime.
 *
 * String args are (ptr,len) pairs (no NUL assumption — the executor passes
 * std::string data). The host copies as needed; pointers are not retained.
 */

#include <cstdint>

#ifdef __wasm__
#define EFFRT_IMPORT(nm) __attribute__((import_module("effrt"), import_name(nm)))
#else
#define EFFRT_IMPORT(nm)
#endif

extern "C" {

// Acquire the (cached) instance handle for a chain entry. Stable across frames:
// the same (module_type, instance_key) returns the same handle. -1 if the host
// can't materialise it (unknown module, no runtime).
EFFRT_IMPORT("instance_for")
int32_t effrt_instance_for(const char* mt, int32_t mt_len,
                           const char* key, int32_t key_len);

// --- Params ---
EFFRT_IMPORT("set_param_float")
void effrt_set_param_float(int32_t inst, const char* path, int32_t path_len, float v);
EFFRT_IMPORT("set_param_json")
void effrt_set_param_json(int32_t inst, const char* path, int32_t path_len,
                          const char* json, int32_t json_len);
EFFRT_IMPORT("set_param_array")
void effrt_set_param_array(int32_t inst, const char* path, int32_t path_len,
                           const float* comps, int32_t n);

// --- Textures / connection flags ---
EFFRT_IMPORT("set_texture_field")
void effrt_set_texture_field(int32_t inst, const char* path, int32_t path_len, int32_t tex);
EFFRT_IMPORT("texture_field")
int32_t effrt_texture_field(int32_t inst, const char* path, int32_t path_len);
EFFRT_IMPORT("set_input_texture_slots")
void effrt_set_input_texture_slots(int32_t inst, const int32_t* handles, int32_t n);
EFFRT_IMPORT("set_field_connected")
void effrt_set_field_connected(int32_t inst, const char* path, int32_t path_len,
                               int32_t input, int32_t output);
EFFRT_IMPORT("set_will_render")
void effrt_set_will_render(int32_t inst, int32_t v);

// --- Lifecycle drive ---
EFFRT_IMPORT("tick")       void effrt_tick(int32_t inst, double dt);
EFFRT_IMPORT("render")     void effrt_render(int32_t inst, int32_t w, int32_t h);
EFFRT_IMPORT("prepare")    void effrt_prepare(int32_t inst, int32_t w, int32_t h);
EFFRT_IMPORT("set_active") void effrt_set_active(int32_t inst, int32_t active);
EFFRT_IMPORT("is_identity") int32_t effrt_is_identity(int32_t inst);

// --- Fusion introspection (reads EffectInstance::fusionInfo()) ---
EFFRT_IMPORT("fusion_kind")           int32_t effrt_fusion_kind(int32_t inst);
EFFRT_IMPORT("fusion_has_prepare")    int32_t effrt_fusion_has_prepare(int32_t inst);
EFFRT_IMPORT("fusion_uniform_buffer") int32_t effrt_fusion_uniform_buffer(int32_t inst);
// Writes the fusion fragment (shader-module) name into out[0..cap); returns its
// full length (may exceed cap → truncated). Empty (len 0) when not fusable.
EFFRT_IMPORT("fusion_fragment_name")
int32_t effrt_fusion_fragment_name(int32_t inst, char* out, int32_t cap);

}  // extern "C"
