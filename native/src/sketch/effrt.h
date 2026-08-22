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
// GPU storage-buffer leaves of a struct rail. The producer publishes a handle
// via state::setGpuBuffer (→ setBufferField); the executor reads it off the
// producer and binds it onto the consumer's input field, which the consumer
// effect resolves via gpu::bufferForField. Persistent (producer-owned) buffers,
// so no per-frame copy — just the handle flows.
EFFRT_IMPORT("set_buffer_field")
void effrt_set_buffer_field(int32_t inst, const char* path, int32_t path_len, int32_t buf);
EFFRT_IMPORT("buffer_field")
int32_t effrt_buffer_field(int32_t inst, const char* path, int32_t path_len);
EFFRT_IMPORT("set_input_texture_slots")
void effrt_set_input_texture_slots(int32_t inst, const int32_t* handles, int32_t n);
EFFRT_IMPORT("set_field_connected")
void effrt_set_field_connected(int32_t inst, const char* path, int32_t path_len,
                               int32_t input, int32_t output);
EFFRT_IMPORT("set_will_render")
void effrt_set_will_render(int32_t inst, int32_t v);

// Numeric fast path: ONE published scalar, no JSON. Returns 1 and writes
// `*out` when the field has a published number/bool; 0 otherwise. This is the
// per-frame wire path (captureWriteTaps, comp output folds) — keep it
// string-free.
EFFRT_IMPORT("published_scalar")
int32_t effrt_published_scalar(int32_t inst, const char* field, int32_t field_len,
                               double* out);

// Publish ONE scalar into the instance's published state ON THE EFFECT'S
// BEHALF — the same map state::setVal writes from inside an effect, and what
// the IDE's output-trace charts read. For host-sourced OUTPUT values that
// never pass through the effect at all: the barrel's Resolume macro knobs and
// control.artnet's live DMX channels arrive as injected scalars (outside the
// doc, by design), and an identity card is alias-skipped before it would ever
// tick, so nothing else would ever publish them. Wires don't need this — they
// read injectedScalars_ directly — telemetry does.
EFFRT_IMPORT("publish_scalar")
void effrt_publish_scalar(int32_t inst, const char* field, int32_t field_len,
                          double v);

// Numeric trigger-ring read: copies up to `cap` events from the instance's
// published "triggers" ring into out[], oldest-first, 5 doubles per event:
//   [0] seq   [1] on (0/1)   [2] channel (NaN when unpublished — consumers
//   skip the event but still advance their seq watermark)   [3] velocity
//   (default 1)   [4] deadline_ms (0 = precision "any"; >0 = strict with that
//   deadline; mode "strict" with no deadline folds to 100 host-side).
// Returns the event count, or -1 when the instance has published NO trigger
// ring (not a trigger source / hasn't ticked yet). The distinction matters:
// an EXISTING-but-empty ring (count 0) lets callers baseline their seq
// watermark at 0 before the first event, while -1 defers first-sight
// baselining until the ring appears. Read-only: seq dedup / first-sight
// baseline / reset-resync stay caller-side. Ring caps are small (≤16 across
// trigger_beat / trigger_out / nanolooper).
EFFRT_IMPORT("read_triggers")
int32_t effrt_read_triggers(int32_t inst, double* out, int32_t cap);

// --- Lifecycle drive ---
EFFRT_IMPORT("tick")       void effrt_tick(int32_t inst, double dt);
EFFRT_IMPORT("render")     void effrt_render(int32_t inst, int32_t w, int32_t h);
EFFRT_IMPORT("prepare")    void effrt_prepare(int32_t inst, int32_t w, int32_t h);
EFFRT_IMPORT("set_active") void effrt_set_active(int32_t inst, int32_t active);
EFFRT_IMPORT("is_identity") int32_t effrt_is_identity(int32_t inst);
// Seek/prefill a stateful effect to a target time (see EffectInstance::doSeek /
// EffectDesc_v2::seek). Declared ABI — no executor caller yet, and no effect
// implements the underlying export.
EFFRT_IMPORT("seek") void effrt_seek(int32_t inst, double from, double to);

// --- Fusion introspection (reads EffectInstance::fusionInfo()) ---
EFFRT_IMPORT("fusion_kind")           int32_t effrt_fusion_kind(int32_t inst);
EFFRT_IMPORT("fusion_has_prepare")    int32_t effrt_fusion_has_prepare(int32_t inst);
EFFRT_IMPORT("fusion_uniform_buffer") int32_t effrt_fusion_uniform_buffer(int32_t inst);
// Writes the fusion fragment (shader-module) name into out[0..cap); returns its
// full length (may exceed cap → truncated). Empty (len 0) when not fusable.
EFFRT_IMPORT("fusion_fragment_name")
int32_t effrt_fusion_fragment_name(int32_t inst, char* out, int32_t cap);

// Assemble the platform fused-chain compute shader SOURCE for the given ordered
// non-identity stage handles, and write it into out[0..cap). Returns the full
// source length (may exceed cap → caller grows + retries); 0 if the host can't
// build it (a fragment's MSL/WGSL isn't registered). This is the one piece of
// fusion that is platform-specific — the host resolves each stage's registered
// fragment and runs the MSL (native) / WGSL (web) fused codegen. The executor
// keeps the PSO cache + lifetime and builds the PSO from this source via the
// gpu ABI. `out_fmt` is the TextureFormat code of the group's output texture
// (the sketch's working format): the web WGSL codegen bakes it into the
// generated storage declaration; the native MSL codegen ignores it.
EFFRT_IMPORT("build_fused_source")
int32_t effrt_build_fused_source(const int32_t* insts, int32_t count,
                                 char* out, int32_t cap, int32_t out_fmt);

}  // extern "C"

#if !defined(__wasm__)
#include <functional>
#include <string>
namespace effect_runtime { class EffectInstance; }
namespace sketch_executor {
/**
 * Native published-state provider (default: none → absent). TEST SEAM: when
 * set, effrt_published_scalar and effrt_read_triggers answer from this JSON
 * object string instead of the instance's structured store (cold path — a
 * test can synthesize values without driving a real effect). Returns the
 * instance's plugin state as a JSON object string, or empty for "nothing
 * published".
 */
void effrtSetPublishedStateProvider(
    std::function<std::string(effect_runtime::EffectInstance*)> fn);
}  // namespace sketch_executor
#endif
