#include "wasm/host_functions.h"
#include "wasm/wasm_host.h"
#include "wasm/wasm_context.h"
#include "bridge/param_cache.h"
#include "canvas/draw_list.h"

#include <cmath>
#include <cstring>

namespace wasm {

// --- Context access helpers ---

static WasmContext* get_ctx(wasm_exec_env_t env) {
  return static_cast<WasmContext*>(wasm_runtime_get_user_data(env));
}

static WasmHost* get_host(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->host : nullptr;
}

static canvas::DrawList* get_draw_list(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->draw_list : nullptr;
}

static FrameState* get_frame(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->frame_state : nullptr;
}

// ========================================================================
// Module "env" — legacy/backward-compatible functions
// ========================================================================

static double env_resolume_get_param(wasm_exec_env_t env, int64_t param_id) {
  auto* host = get_host(env);
  if (!host) return 0.0;
  return host->param_cache().get(param_id);
}

static void env_resolume_set_param(wasm_exec_env_t env, int64_t param_id, double value) {
  auto* host = get_host(env);
  if (!host) return;
  host->param_cache().set(param_id, value);
  host->param_cache().queue_write(param_id, value);
}

static void env_log(wasm_exec_env_t env, int32_t msg_ptr, int32_t msg_len) {
  auto* host = get_host(env);
  if (!host) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, msg_ptr, msg_len)) return;
  char* native_ptr = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, msg_ptr));
  if (!native_ptr) return;
  host->log(std::string(native_ptr, msg_len));
}

// Math builtins — WASM clang may emit these as imports
static double env_fmod(wasm_exec_env_t env, double a, double b) {
  return fmod(a, b);
}

static float env_fmodf(wasm_exec_env_t env, float a, float b) {
  return fmodf(a, b);
}

static float env_sinf(wasm_exec_env_t env, float a) {
  return sinf(a);
}

static double env_floor(wasm_exec_env_t env, double a) {
  return floor(a);
}

static double env_fabs(wasm_exec_env_t env, double a) {
  return fabs(a);
}

static int32_t env_strlen(wasm_exec_env_t env, int32_t ptr) {
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  // Find the null terminator
  int32_t len = 0;
  while (true) {
    if (!wasm_runtime_validate_app_addr(inst, ptr + len, 1)) break;
    char* p = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, ptr + len));
    if (!p || *p == '\0') break;
    len++;
  }
  return len;
}

static NativeSymbol env_symbols[] = {
    {"resolume_get_param", reinterpret_cast<void*>(env_resolume_get_param), "(I)F", nullptr},
    {"resolume_set_param", reinterpret_cast<void*>(env_resolume_set_param), "(IF)", nullptr},
    {"log", reinterpret_cast<void*>(env_log), "(ii)", nullptr},
    {"fmod", reinterpret_cast<void*>(env_fmod), "(FF)F", nullptr},
    {"fmodf", reinterpret_cast<void*>(env_fmodf), "(ff)f", nullptr},
    {"sinf", reinterpret_cast<void*>(env_sinf), "(f)f", nullptr},
    {"floor", reinterpret_cast<void*>(env_floor), "(F)F", nullptr},
    {"fabs", reinterpret_cast<void*>(env_fabs), "(F)F", nullptr},
    {"strlen", reinterpret_cast<void*>(env_strlen), "(i)i", nullptr},
};

// ========================================================================
// Module "canvas" — drawing primitives
// ========================================================================

static void canvas_fill_rect(wasm_exec_env_t env,
    float x, float y, float w, float h,
    float r, float g, float b, float a) {
  auto* dl = get_draw_list(env);
  if (dl) dl->fill_rect(x, y, w, h, r, g, b, a);
}

static void canvas_draw_image(wasm_exec_env_t env,
    int32_t tex_id, float x, float y, float w, float h) {
  auto* dl = get_draw_list(env);
  if (dl) dl->draw_image(tex_id, x, y, w, h);
}

static void canvas_draw_text(wasm_exec_env_t env,
    int32_t text_ptr, int32_t text_len,
    float x, float y, float size,
    float r, float g, float b, float a) {
  auto* dl = get_draw_list(env);
  if (!dl) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, text_ptr, text_len)) return;
  char* native_ptr = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, text_ptr));
  if (!native_ptr) return;
  dl->draw_text(std::string(native_ptr, text_len), x, y, size, r, g, b, a);
}

static NativeSymbol canvas_symbols[] = {
    {"fill_rect", reinterpret_cast<void*>(canvas_fill_rect), "(ffffffff)", nullptr},
    {"draw_image", reinterpret_cast<void*>(canvas_draw_image), "(iffff)", nullptr},
    {"draw_text", reinterpret_cast<void*>(canvas_draw_text), "(iifffffff)", nullptr},
};

// ========================================================================
// Module "host" — timing, parameters, audio
// ========================================================================

static double host_get_time(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->elapsed_time : 0.0;
}

static double host_get_delta_time(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->delta_time : 0.0;
}

static double host_get_bar_phase(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->bar_phase : 0.0;
}

static double host_get_bpm(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->bpm : 120.0;
}

static double host_get_param(wasm_exec_env_t env, int32_t index) {
  auto* f = get_frame(env);
  if (!f || index < 0 || index >= FrameState::MAX_PARAMS) return 0.0;
  return f->ffgl_params[index];
}

static int32_t host_get_viewport_w(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->viewport_w : 0;
}

static int32_t host_get_viewport_h(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->viewport_h : 0;
}

static void host_log_fn(wasm_exec_env_t env, int32_t msg_ptr, int32_t msg_len) {
  env_log(env, msg_ptr, msg_len); // reuse env.log implementation
}

static void host_trigger_audio(wasm_exec_env_t env, int32_t channel) {
  auto* ctx = get_ctx(env);
  if (ctx && ctx->audio_callback) {
    ctx->audio_callback(channel, ctx->audio_userdata);
  }
}

static NativeSymbol host_symbols[] = {
    {"get_time", reinterpret_cast<void*>(host_get_time), "()F", nullptr},
    {"get_delta_time", reinterpret_cast<void*>(host_get_delta_time), "()F", nullptr},
    {"get_bar_phase", reinterpret_cast<void*>(host_get_bar_phase), "()F", nullptr},
    {"get_bpm", reinterpret_cast<void*>(host_get_bpm), "()F", nullptr},
    {"get_param", reinterpret_cast<void*>(host_get_param), "(i)F", nullptr},
    {"get_viewport_w", reinterpret_cast<void*>(host_get_viewport_w), "()i", nullptr},
    {"get_viewport_h", reinterpret_cast<void*>(host_get_viewport_h), "()i", nullptr},
    {"log", reinterpret_cast<void*>(host_log_fn), "(ii)", nullptr},
    {"trigger_audio", reinterpret_cast<void*>(host_trigger_audio), "(i)", nullptr},
};

// ========================================================================
// Module "resolume" — composition queries
// ========================================================================

static double resolume_get_param(wasm_exec_env_t env, int64_t param_id) {
  auto* host = get_host(env);
  if (!host) return 0.0;
  return host->param_cache().get(param_id);
}

static void resolume_set_param(wasm_exec_env_t env, int64_t param_id, double value) {
  auto* host = get_host(env);
  if (!host) return;
  host->param_cache().set(param_id, value);
  host->param_cache().queue_write(param_id, value);
}

static void resolume_trigger_clip(wasm_exec_env_t env, int64_t clip_id, int32_t on) {
  // TODO: forward to bridge server's Resolume WS client
  (void)clip_id;
  (void)on;
}

static void resolume_subscribe_param(wasm_exec_env_t env, int64_t param_id) {
  // TODO: forward to bridge server's Resolume WS client
  (void)param_id;
}

static int32_t resolume_get_clip_count(wasm_exec_env_t env) {
  // TODO: read from CompositionCache
  return 0;
}

static int64_t resolume_get_clip_id(wasm_exec_env_t env, int32_t index) {
  // TODO: read from CompositionCache
  (void)index;
  return 0;
}

static int32_t resolume_get_clip_channel(wasm_exec_env_t env, int32_t index) {
  // TODO: read from CompositionCache
  (void)index;
  return -1;
}

static int32_t resolume_get_clip_name(wasm_exec_env_t env, int32_t index,
                                       int32_t buf_ptr, int32_t buf_len) {
  // TODO: read from CompositionCache
  (void)index; (void)buf_ptr; (void)buf_len;
  return 0;
}

static int32_t resolume_get_clip_connected(wasm_exec_env_t env, int32_t index) {
  // TODO: read from CompositionCache
  (void)index;
  return 0;
}

static double resolume_get_bpm(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->bpm : 120.0;
}

static int32_t resolume_load_thumbnail(wasm_exec_env_t env, int32_t clip_index) {
  // TODO: forward to bridge server image loader
  (void)clip_index;
  return -1;
}

static NativeSymbol resolume_symbols[] = {
    {"get_param", reinterpret_cast<void*>(resolume_get_param), "(I)F", nullptr},
    {"set_param", reinterpret_cast<void*>(resolume_set_param), "(IF)", nullptr},
    {"trigger_clip", reinterpret_cast<void*>(resolume_trigger_clip), "(Ii)", nullptr},
    {"subscribe_param", reinterpret_cast<void*>(resolume_subscribe_param), "(I)", nullptr},
    {"get_clip_count", reinterpret_cast<void*>(resolume_get_clip_count), "()i", nullptr},
    {"get_clip_id", reinterpret_cast<void*>(resolume_get_clip_id), "(i)I", nullptr},
    {"get_clip_channel", reinterpret_cast<void*>(resolume_get_clip_channel), "(i)i", nullptr},
    {"get_clip_name", reinterpret_cast<void*>(resolume_get_clip_name), "(iii)i", nullptr},
    {"get_clip_connected", reinterpret_cast<void*>(resolume_get_clip_connected), "(i)i", nullptr},
    {"get_bpm", reinterpret_cast<void*>(resolume_get_bpm), "()F", nullptr},
    {"load_thumbnail", reinterpret_cast<void*>(resolume_load_thumbnail), "(i)i", nullptr},
};

// ========================================================================
// Registration
// ========================================================================

bool register_host_functions() {
  bool ok = true;

  ok = ok && wasm_runtime_register_natives(
      "env", env_symbols,
      sizeof(env_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "canvas", canvas_symbols,
      sizeof(canvas_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "host", host_symbols,
      sizeof(host_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "resolume", resolume_symbols,
      sizeof(resolume_symbols) / sizeof(NativeSymbol));

  return ok;
}

} // namespace wasm
