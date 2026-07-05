// executor_host.cpp — registers the "effrt" WAMR host functions that let the
// unified executor.wasm drive effect instances against the NATIVE EffectRuntime.
//
// These are thin WAMR wrappers (every native symbol receives wasm_exec_env_t
// first; pointer args are wasm offsets needing translation) over the effrt_*
// core in effrt_impls.cpp — the SAME core the in-process native executor calls.
// So both the native and wasm executors share one runtime binding (g_rt, set by
// effrtSetRuntime). The host calls registerEffrtHostFunctions() once after WAMR
// init (it's process-global) and effrtSetRuntime(rt) before driving a frame.
//
// The "gpu" imports the executor needs are registered separately (the standard
// gpu_symbols table in host_functions.cpp already covers them, incl. the
// executor-only set_surface/get_texture_format/submit-batch added there).

#include "wasm/wasm_host.h"  // WAMR: wasm_exec_env_t, NativeSymbol, wasm_runtime_*

#include "sketch/effrt.h"
#include "sketch/executor_host.h"

namespace sketch_executor {
namespace {

// Validate + translate a (offset,len) wasm buffer to a native pointer.
char* appBuf(wasm_exec_env_t env, int32_t off, int32_t bytes) {
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (bytes < 0 || !wasm_runtime_validate_app_addr(inst, (uint64_t)off, (uint64_t)bytes))
    return nullptr;
  return static_cast<char*>(wasm_runtime_addr_app_to_native(inst, (uint64_t)off));
}

// --- pointer-taking wrappers (translate, then call the effrt_* core) ---
int32_t w_instance_for(wasm_exec_env_t env, int32_t mt, int32_t mt_len,
                       int32_t key, int32_t key_len) {
  char* m = appBuf(env, mt, mt_len);
  char* k = appBuf(env, key, key_len);
  return (m && k) ? effrt_instance_for(m, mt_len, k, key_len) : -1;
}
void w_set_param_float(wasm_exec_env_t env, int32_t h, int32_t p, int32_t pl, float v) {
  if (char* path = appBuf(env, p, pl)) effrt_set_param_float(h, path, pl, v);
}
void w_set_param_json(wasm_exec_env_t env, int32_t h, int32_t p, int32_t pl,
                      int32_t j, int32_t jl) {
  char* path = appBuf(env, p, pl);
  char* json = appBuf(env, j, jl);
  if (path && json) effrt_set_param_json(h, path, pl, json, jl);
}
void w_set_param_array(wasm_exec_env_t env, int32_t h, int32_t p, int32_t pl,
                       int32_t comps, int32_t n) {
  char* path = appBuf(env, p, pl);
  char* c = appBuf(env, comps, n * (int32_t)sizeof(float));
  if (path && c) effrt_set_param_array(h, path, pl,
                                       reinterpret_cast<const float*>(c), n);
}
void w_set_texture_field(wasm_exec_env_t env, int32_t h, int32_t p, int32_t pl, int32_t tex) {
  if (char* path = appBuf(env, p, pl)) effrt_set_texture_field(h, path, pl, tex);
}
int32_t w_texture_field(wasm_exec_env_t env, int32_t h, int32_t p, int32_t pl) {
  char* path = appBuf(env, p, pl);
  return path ? effrt_texture_field(h, path, pl) : -1;
}
void w_set_buffer_field(wasm_exec_env_t env, int32_t h, int32_t p, int32_t pl, int32_t buf) {
  if (char* path = appBuf(env, p, pl)) effrt_set_buffer_field(h, path, pl, buf);
}
int32_t w_buffer_field(wasm_exec_env_t env, int32_t h, int32_t p, int32_t pl) {
  char* path = appBuf(env, p, pl);
  return path ? effrt_buffer_field(h, path, pl) : 0;
}
void w_set_input_texture_slots(wasm_exec_env_t env, int32_t h, int32_t handles, int32_t n) {
  if (char* hs = appBuf(env, handles, n * (int32_t)sizeof(int32_t)))
    effrt_set_input_texture_slots(h, reinterpret_cast<const int32_t*>(hs), n);
}
void w_set_field_connected(wasm_exec_env_t env, int32_t h, int32_t p, int32_t pl,
                           int32_t in, int32_t out) {
  if (char* path = appBuf(env, p, pl)) effrt_set_field_connected(h, path, pl, in, out);
}
int32_t w_fusion_fragment_name(wasm_exec_env_t env, int32_t h, int32_t out, int32_t cap) {
  char* o = appBuf(env, out, cap);
  return effrt_fusion_fragment_name(h, o, o ? cap : 0);
}
int32_t w_build_fused_source(wasm_exec_env_t env, int32_t insts, int32_t count,
                             int32_t out, int32_t cap, int32_t out_fmt) {
  char* ins = appBuf(env, insts, count * (int32_t)sizeof(int32_t));
  char* o = appBuf(env, out, cap);
  if (!ins) return 0;
  return effrt_build_fused_source(reinterpret_cast<const int32_t*>(ins), count,
                                  o, o ? cap : 0, out_fmt);
}

// --- non-pointer wrappers (just drop env, forward the ints/double) ---
void    w_set_will_render(wasm_exec_env_t, int32_t h, int32_t v) { effrt_set_will_render(h, v); }
void    w_tick(wasm_exec_env_t, int32_t h, double dt)            { effrt_tick(h, dt); }
void    w_render(wasm_exec_env_t, int32_t h, int32_t w, int32_t hh)  { effrt_render(h, w, hh); }
void    w_prepare(wasm_exec_env_t, int32_t h, int32_t w, int32_t hh) { effrt_prepare(h, w, hh); }
void    w_set_active(wasm_exec_env_t, int32_t h, int32_t a)     { effrt_set_active(h, a); }
void    w_seek(wasm_exec_env_t, int32_t h, double from, double to) { effrt_seek(h, from, to); }
int32_t w_is_identity(wasm_exec_env_t, int32_t h)              { return effrt_is_identity(h); }
int32_t w_fusion_kind(wasm_exec_env_t, int32_t h)             { return effrt_fusion_kind(h); }
int32_t w_fusion_has_prepare(wasm_exec_env_t, int32_t h)      { return effrt_fusion_has_prepare(h); }
int32_t w_fusion_uniform_buffer(wasm_exec_env_t, int32_t h)   { return effrt_fusion_uniform_buffer(h); }

// --- "trace" namespace: editor-preview hooks. No-op on native — the barrel's
// wasm-executor path doesn't drive previews (the in-process executor's
// std::function hooks do); these just resolve the imports so the executor's
// hook calls don't trap. ---
void    w_trace_chain_entry(wasm_exec_env_t, int32_t, int32_t, int32_t, int32_t,
                            int32_t, int32_t) {}
void    w_trace_sketch_output(wasm_exec_env_t, int32_t, int32_t, int32_t) {}
int32_t w_trace_is_barrier(wasm_exec_env_t, int32_t, int32_t) { return 0; }

NativeSymbol g_trace_symbols[] = {
    {"chain_entry", reinterpret_cast<void*>(w_trace_chain_entry), "(iiiiii)", nullptr},
    {"sketch_output", reinterpret_cast<void*>(w_trace_sketch_output), "(iii)", nullptr},
    {"is_barrier", reinterpret_cast<void*>(w_trace_is_barrier), "(ii)i", nullptr},
};

NativeSymbol g_effrt_symbols[] = {
    {"instance_for", reinterpret_cast<void*>(w_instance_for), "(iiii)i", nullptr},
    {"set_param_float", reinterpret_cast<void*>(w_set_param_float), "(iiif)", nullptr},
    {"set_param_json", reinterpret_cast<void*>(w_set_param_json), "(iiiii)", nullptr},
    {"set_param_array", reinterpret_cast<void*>(w_set_param_array), "(iiiii)", nullptr},
    {"set_texture_field", reinterpret_cast<void*>(w_set_texture_field), "(iiii)", nullptr},
    {"texture_field", reinterpret_cast<void*>(w_texture_field), "(iii)i", nullptr},
    {"set_buffer_field", reinterpret_cast<void*>(w_set_buffer_field), "(iiii)", nullptr},
    {"buffer_field", reinterpret_cast<void*>(w_buffer_field), "(iii)i", nullptr},
    {"set_input_texture_slots", reinterpret_cast<void*>(w_set_input_texture_slots), "(iii)", nullptr},
    {"set_field_connected", reinterpret_cast<void*>(w_set_field_connected), "(iiiii)", nullptr},
    {"set_will_render", reinterpret_cast<void*>(w_set_will_render), "(ii)", nullptr},
    {"tick", reinterpret_cast<void*>(w_tick), "(iF)", nullptr},
    {"render", reinterpret_cast<void*>(w_render), "(iii)", nullptr},
    {"prepare", reinterpret_cast<void*>(w_prepare), "(iii)", nullptr},
    {"set_active", reinterpret_cast<void*>(w_set_active), "(ii)", nullptr},
    {"seek", reinterpret_cast<void*>(w_seek), "(iFF)", nullptr},
    {"is_identity", reinterpret_cast<void*>(w_is_identity), "(i)i", nullptr},
    {"fusion_kind", reinterpret_cast<void*>(w_fusion_kind), "(i)i", nullptr},
    {"fusion_has_prepare", reinterpret_cast<void*>(w_fusion_has_prepare), "(i)i", nullptr},
    {"fusion_uniform_buffer", reinterpret_cast<void*>(w_fusion_uniform_buffer), "(i)i", nullptr},
    {"fusion_fragment_name", reinterpret_cast<void*>(w_fusion_fragment_name), "(iii)i", nullptr},
    {"build_fused_source", reinterpret_cast<void*>(w_build_fused_source), "(iiiii)i", nullptr},
};

}  // namespace

bool registerEffrtHostFunctions() {
  bool ok = wasm_runtime_register_natives(
      "effrt", g_effrt_symbols,
      sizeof(g_effrt_symbols) / sizeof(NativeSymbol));
  ok = wasm_runtime_register_natives(
           "trace", g_trace_symbols,
           sizeof(g_trace_symbols) / sizeof(NativeSymbol)) && ok;
  return ok;
}

}  // namespace sketch_executor
