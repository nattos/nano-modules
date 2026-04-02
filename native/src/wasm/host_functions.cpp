#include "wasm/host_functions.h"
#include "wasm/wasm_host.h"
#include "wasm/wasm_context.h"
#include "bridge/param_cache.h"
#include "bridge/state_document.h"
#include "canvas/draw_list.h"
#include "json/json_doc.h"

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
// Module "state" — plugin metadata, logging, state access
// ========================================================================

static void state_set_metadata(wasm_exec_env_t env,
    int32_t id_ptr, int32_t id_len, int32_t version_packed) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, id_ptr, id_len)) return;
  char* id_str = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, id_ptr));
  if (!id_str) return;

  bridge::PluginMetadata meta;
  meta.id = std::string(id_str, id_len);
  meta.major = (version_packed >> 16) & 0xFF;
  meta.minor = (version_packed >> 8) & 0xFF;
  meta.patch = version_packed & 0xFF;

  ctx->plugin_key = ctx->state_doc->register_plugin(meta);
}

static int32_t state_get_key(wasm_exec_env_t env, int32_t buf_ptr, int32_t buf_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return 0;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) return 0;
  char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
  if (!buf) return 0;

  const auto& key = ctx->plugin_key;
  int32_t copy_len = std::min((int32_t)key.size(), buf_len);
  memcpy(buf, key.data(), copy_len);
  return copy_len;
}

static void state_console_log(wasm_exec_env_t env,
    int32_t level, int32_t msg_ptr, int32_t msg_len) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, msg_ptr, msg_len)) return;
  char* msg = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, msg_ptr));
  if (!msg) return;

  const char* levels[] = {"log", "warn", "error"};
  std::string lvl = (level >= 0 && level < 3) ? levels[level] : "log";

  auto* frame = ctx->frame_state;
  double ts = frame ? frame->elapsed_time : 0.0;

  ctx->state_doc->log(ctx->plugin_key,
      {ts, lvl, std::string(msg, msg_len)});
}

static void state_set(wasm_exec_env_t env,
    int32_t path_ptr, int32_t path_len,
    int32_t json_ptr, int32_t json_len) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, path_ptr, path_len)) return;
  if (!wasm_runtime_validate_app_addr(inst, json_ptr, json_len)) return;

  char* path = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, path_ptr));
  char* json_str = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, json_ptr));
  if (!path || !json_str) return;

  std::string path_s(path, path_len);
  std::string json_s(json_str, json_len);

  try {
    auto val = nlohmann::json::parse(json_s);
    // Apply as a replace patch on the plugin's state
    std::vector<json_patch::PatchOp> ops = {{"replace", path_s, val, {}}};
    ctx->state_doc->apply_client_patch(ctx->plugin_key, ops);
  } catch (...) {
    // Invalid JSON, ignore
  }
}

static int32_t state_read(wasm_exec_env_t env,
    int32_t layout_ptr, int32_t field_count,
    int32_t paths_ptr, int32_t output_ptr,
    int32_t output_size, int32_t results_ptr) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return -1;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  int32_t layout_bytes = field_count * sizeof(json_doc::Field);
  int32_t results_bytes = field_count * sizeof(json_doc::FieldResult);

  if (!wasm_runtime_validate_app_addr(inst, layout_ptr, layout_bytes)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, output_ptr, output_size)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, results_ptr, results_bytes)) return -1;

  auto* layout = static_cast<json_doc::Field*>(
      wasm_runtime_addr_app_to_native(inst, layout_ptr));
  auto* output = static_cast<uint8_t*>(
      wasm_runtime_addr_app_to_native(inst, output_ptr));
  auto* results = static_cast<json_doc::FieldResult*>(
      wasm_runtime_addr_app_to_native(inst, results_ptr));

  // paths_ptr validation: we need to find the max extent
  // For now, validate a generous range
  if (!wasm_runtime_validate_app_addr(inst, paths_ptr, 1)) return -1;
  auto* paths = static_cast<const char*>(
      wasm_runtime_addr_app_to_native(inst, paths_ptr));

  if (!layout || !output || !results || !paths) return -1;

  auto state = ctx->state_doc->get_plugin_state(ctx->plugin_key);
  return json_doc::read(state, layout, field_count, paths,
                        output, output_size, results);
}

static void state_console_log_structured(wasm_exec_env_t env,
    int32_t level, int32_t msg_ptr, int32_t msg_len,
    int32_t json_ptr, int32_t json_len) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, msg_ptr, msg_len)) return;
  if (!wasm_runtime_validate_app_addr(inst, json_ptr, json_len)) return;

  char* msg = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, msg_ptr));
  char* json_str = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, json_ptr));
  if (!msg || !json_str) return;

  const char* levels[] = {"log", "warn", "error"};
  std::string lvl = (level >= 0 && level < 3) ? levels[level] : "log";
  auto* frame = ctx->frame_state;
  double ts = frame ? frame->elapsed_time : 0.0;

  nlohmann::json data;
  try {
    data = nlohmann::json::parse(std::string(json_str, json_len));
  } catch (...) {
    data = std::string(json_str, json_len);
  }

  // Create entry with both message and structured data
  bridge::ConsoleEntry entry;
  entry.timestamp = ts;
  entry.level = lvl;
  entry.data = nlohmann::json{{"message", std::string(msg, msg_len)}, {"data", data}};
  ctx->state_doc->log(ctx->plugin_key, entry);
}

static NativeSymbol state_symbols[] = {
    {"set_metadata", reinterpret_cast<void*>(state_set_metadata), "(iii)", nullptr},
    {"get_key", reinterpret_cast<void*>(state_get_key), "(ii)i", nullptr},
    {"console_log", reinterpret_cast<void*>(state_console_log), "(iii)", nullptr},
    {"console_log_structured", reinterpret_cast<void*>(state_console_log_structured), "(iiiii)", nullptr},
    {"set", reinterpret_cast<void*>(state_set), "(iiii)", nullptr},
    {"read", reinterpret_cast<void*>(state_read), "(iiiiii)i", nullptr},
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

  ok = ok && wasm_runtime_register_natives(
      "state", state_symbols,
      sizeof(state_symbols) / sizeof(NativeSymbol));

  return ok;
}

} // namespace wasm
