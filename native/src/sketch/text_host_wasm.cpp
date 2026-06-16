// text_host_wasm.cpp — registers the "text" WAMR host functions so effect
// bundles loaded through WasmEffectBundles (text.wasm / richtext.wasm) can reach
// the native text.* service (FreeType + msdfgen layout + MSDF compositor) that
// the formerly-static text effects called directly.
//
// Thin wrappers over the extern-C text_* impls in runtime/host_impls_text.cpp:
// translate the wasm pointer args (spec/xform JSON, the metrics/glyphs output
// buffers) to native, forward the rest. The native impls resolve the GPU backend
// via currentRuntime() (set by the EffectRuntime), so these need no per-instance
// context. Mirrors executor_host.cpp's "effrt" registration.

#include "wasm/wasm_host.h"  // WAMR: wasm_exec_env_t, NativeSymbol, wasm_runtime_*

#include <cstdint>

namespace sketch_executor {

// The native text.* host service (runtime/host_impls_text.cpp, extern "C").
extern "C" {
int  text_layout(const char* spec_json, int spec_len);
int  text_measure(int layout_id, void* out_metrics);
void text_render(int layout_id, int target_tex, int bg_tex,
                 const char* xform_json, int xform_len);
int  text_atlas(int layout_id);
int  text_glyphs(int layout_id, void* out_quads, int out_bytes);
void text_release(int layout_id);
}

namespace {

// Validate + translate a (offset,len) wasm buffer to a native pointer.
char* appBuf(wasm_exec_env_t env, int32_t off, int32_t bytes) {
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (bytes < 0 || !wasm_runtime_validate_app_addr(inst, (uint64_t)off, (uint64_t)bytes))
    return nullptr;
  return static_cast<char*>(wasm_runtime_addr_app_to_native(inst, (uint64_t)off));
}

// sizeof(TextMetrics) — 8 × 4-byte fields; see TextMetrics in host.h. Validates
// the caller's output buffer before text_measure writes into it.
constexpr int32_t kTextMetricsBytes = 32;

int32_t w_layout(wasm_exec_env_t env, int32_t spec, int32_t len) {
  char* p = appBuf(env, spec, len);
  return p ? text_layout(p, len) : 0;
}
int32_t w_measure(wasm_exec_env_t env, int32_t id, int32_t out) {
  void* p = appBuf(env, out, kTextMetricsBytes);
  return p ? text_measure(id, p) : 0;
}
void w_render(wasm_exec_env_t env, int32_t id, int32_t target, int32_t bg,
              int32_t xform, int32_t len) {
  if (char* p = appBuf(env, xform, len)) text_render(id, target, bg, p, len);
}
int32_t w_atlas(wasm_exec_env_t, int32_t id) { return text_atlas(id); }
int32_t w_glyphs(wasm_exec_env_t env, int32_t id, int32_t out, int32_t bytes) {
  void* p = appBuf(env, out, bytes);
  return p ? text_glyphs(id, p, bytes) : 0;
}
void w_release(wasm_exec_env_t, int32_t id) { text_release(id); }

NativeSymbol g_text_symbols[] = {
    {"layout",  reinterpret_cast<void*>(w_layout),  "(ii)i",   nullptr},
    {"measure", reinterpret_cast<void*>(w_measure), "(ii)i",   nullptr},
    {"render",  reinterpret_cast<void*>(w_render),  "(iiiii)", nullptr},
    {"atlas",   reinterpret_cast<void*>(w_atlas),   "(i)i",    nullptr},
    {"glyphs",  reinterpret_cast<void*>(w_glyphs),  "(iii)i",  nullptr},
    {"release", reinterpret_cast<void*>(w_release), "(i)",     nullptr},
};

}  // namespace

// (Re)register the "text" namespace. Must run AFTER the WAMR runtime is up
// (wasm_runtime_register_natives allocates from it). The runtime is REFCOUNTED
// (WasmHost::init brings it up at refs 0→1, wasm_runtime_destroy at refs 1→0),
// and destroy FREES the whole native-symbol list — so a once-only registration
// is silently lost the first time every WasmHost shuts down. Instead this runs
// on every WasmEffectBundles::init() and is idempotent: unregister any stale
// node (a no-op if the list was already freed or never held one) before adding a
// fresh one, so at most one "text" node ever exists and it always tracks the
// current runtime. Mirrors how WasmHost re-runs register_host_functions() on
// each bring-up. Returns true on success.
bool registerTextHostFunctions() {
  wasm_runtime_unregister_natives("text", g_text_symbols);
  return wasm_runtime_register_natives(
      "text", g_text_symbols, sizeof(g_text_symbols) / sizeof(NativeSymbol));
}

}  // namespace sketch_executor
