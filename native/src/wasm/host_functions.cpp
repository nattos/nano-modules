#include "wasm/host_functions.h"
#include "wasm/wasm_host.h"
#include "wasm/wasm_context.h"
#include "bridge/param_cache.h"
#include "bridge/state_document.h"
#include "canvas/draw_list.h"
#include "gpu/gpu_backend.h"
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

static void resolume_subscribe_query(wasm_exec_env_t env,
    int32_t query_ptr, int32_t query_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, query_ptr, query_len)) return;
  char* q = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, query_ptr));
  if (!q) return;

  std::string query(q, query_len);
  // Store subscription queries on the context for the host to match against
  // "/*" or "*" subscribes to everything
  ctx->subscribe_queries.push_back(query);
}

static int32_t resolume_get_param_path(wasm_exec_env_t env,
    int64_t param_id, int32_t buf_ptr, int32_t buf_len) {
  // TODO: look up path from composition cache or param_paths_ map
  // For now, return a placeholder path based on the ID
  auto* ctx = get_ctx(env);
  if (!ctx) return 0;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) return 0;
  char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
  if (!buf) return 0;

  std::string path = "param/" + std::to_string(param_id);
  int32_t copy_len = std::min((int32_t)path.size(), buf_len);
  memcpy(buf, path.data(), copy_len);
  return copy_len;
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
    {"subscribe_query", reinterpret_cast<void*>(resolume_subscribe_query), "(ii)", nullptr},
    {"get_param_path", reinterpret_cast<void*>(resolume_get_param_path), "(Iii)i", nullptr},
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

static void state_set_schema(wasm_exec_env_t env,
    int32_t id_ptr, int32_t id_len, int32_t version_packed,
    int32_t schema_ptr, int32_t schema_len) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, id_ptr, id_len)) return;
  if (!wasm_runtime_validate_app_addr(inst, schema_ptr, schema_len)) return;
  char* id_str = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, id_ptr));
  char* schema_str = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, schema_ptr));
  if (!id_str || !schema_str) return;

  bridge::PluginMetadata meta;
  meta.id = std::string(id_str, id_len);
  meta.major = (version_packed >> 16) & 0xFF;
  meta.minor = (version_packed >> 8) & 0xFF;
  meta.patch = version_packed & 0xFF;

  std::string schema_json(schema_str, schema_len);
  ctx->plugin_key = ctx->state_doc->register_plugin_with_schema(meta, schema_json);
}

static void state_declare_param(wasm_exec_env_t env,
    int32_t index, int32_t name_ptr, int32_t name_len,
    int32_t type, float default_value) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, name_ptr, name_len)) return;
  char* name = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, name_ptr));
  if (!name) return;

  bridge::ParamDecl param;
  param.index = index;
  param.name = std::string(name, name_len);
  param.type = static_cast<bridge::ParamType>(type);
  param.default_value = default_value;

  ctx->state_doc->declare_param(ctx->plugin_key, param);
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
    {"set_schema", reinterpret_cast<void*>(state_set_schema), "(iiiii)", nullptr},
    {"declare_param", reinterpret_cast<void*>(state_declare_param), "(iiiif)", nullptr},
    {"get_key", reinterpret_cast<void*>(state_get_key), "(ii)i", nullptr},
    {"console_log", reinterpret_cast<void*>(state_console_log), "(iii)", nullptr},
    {"console_log_structured", reinterpret_cast<void*>(state_console_log_structured), "(iiiii)", nullptr},
    {"set", reinterpret_cast<void*>(state_set), "(iiii)", nullptr},
    {"read", reinterpret_cast<void*>(state_read), "(iiiiii)i", nullptr},
    {"get_patch", reinterpret_cast<void*>(+[](wasm_exec_env_t env, int32_t index) -> int32_t {
      auto* ctx = get_ctx(env);
      if (!ctx || index < 0 || index >= static_cast<int32_t>(ctx->pending_patches.size())) return 0;
      return ctx->alloc_val(ctx->pending_patches[index]);
    }), "(i)i", nullptr},
};

// ========================================================================
// Module "io" — I/O port declarations
// ========================================================================

static void io_declare_texture_input(wasm_exec_env_t env, int index,
    const char* name, int name_len, int role) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return;
  bridge::IODecl decl;
  decl.index = index;
  decl.name = std::string(name, name_len);
  decl.kind = bridge::IO_TEXTURE_INPUT;
  decl.role = static_cast<bridge::IORole>(role);
  ctx->state_doc->declare_io(ctx->plugin_key, decl);
}

static void io_declare_texture_output(wasm_exec_env_t env, int index,
    const char* name, int name_len, int role) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return;
  bridge::IODecl decl;
  decl.index = index;
  decl.name = std::string(name, name_len);
  decl.kind = bridge::IO_TEXTURE_OUTPUT;
  decl.role = static_cast<bridge::IORole>(role);
  ctx->state_doc->declare_io(ctx->plugin_key, decl);
}

static void io_declare_data_output(wasm_exec_env_t env, int index,
    const char* name, int name_len, int role) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return;
  bridge::IODecl decl;
  decl.index = index;
  decl.name = std::string(name, name_len);
  decl.kind = bridge::IO_DATA_OUTPUT;
  decl.role = static_cast<bridge::IORole>(role);
  ctx->state_doc->declare_io(ctx->plugin_key, decl);
}

static NativeSymbol io_symbols[] = {
    {"declare_texture_input", reinterpret_cast<void*>(io_declare_texture_input), "(iiii)", nullptr},
    {"declare_texture_output", reinterpret_cast<void*>(io_declare_texture_output), "(iiii)", nullptr},
    {"declare_data_output", reinterpret_cast<void*>(io_declare_data_output), "(iiii)", nullptr},
};

// ========================================================================
// Module "val" — Handle-based JSON value container
// ========================================================================

static int32_t val_null(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->alloc_val(nlohmann::json(nullptr)) : 0;
}
static int32_t val_bool(wasm_exec_env_t env, int32_t v) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->alloc_val(v != 0) : 0;
}
static int32_t val_number(wasm_exec_env_t env, double v) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->alloc_val(v) : 0;
}
static int32_t val_string(wasm_exec_env_t env, int32_t str_ptr, int32_t str_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, str_ptr, str_len)) return 0;
  char* s = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, str_ptr));
  return s ? ctx->alloc_val(std::string(s, str_len)) : 0;
}
static int32_t val_array(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->alloc_val(nlohmann::json::array()) : 0;
}
static int32_t val_object(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->alloc_val(nlohmann::json::object()) : 0;
}

static int32_t val_type_of(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  if (!v) return 0;
  if (v->is_null()) return 0;
  if (v->is_boolean()) return 1;
  if (v->is_number()) return 2;
  if (v->is_string()) return 3;
  if (v->is_array()) return 4;
  if (v->is_object()) return 5;
  return 0;
}
static double val_as_number(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  return (v && v->is_number()) ? v->get<double>() : 0.0;
}
static int32_t val_as_bool(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  return (v && v->is_boolean() && v->get<bool>()) ? 1 : 0;
}
static int32_t val_as_string(wasm_exec_env_t env, int32_t h, int32_t buf_ptr, int32_t buf_len) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  if (!v || !v->is_string()) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) return 0;
  char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
  auto& s = v->get_ref<const std::string&>();
  int len = std::min(static_cast<int>(s.size()), buf_len);
  if (buf && len > 0) std::memcpy(buf, s.data(), len);
  return len;
}

static int32_t val_get(wasm_exec_env_t env, int32_t obj_h, int32_t key_ptr, int32_t key_len) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(obj_h) : nullptr;
  if (!v || !v->is_object()) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, key_ptr, key_len)) return 0;
  char* key = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, key_ptr));
  std::string k(key, key_len);
  if (!v->contains(k)) return 0;
  return ctx->alloc_val((*v)[k]);
}
static void val_set(wasm_exec_env_t env, int32_t obj_h, int32_t key_ptr, int32_t key_len, int32_t value_h) {
  auto* ctx = get_ctx(env);
  auto* obj = ctx ? ctx->get_val(obj_h) : nullptr;
  auto* val = ctx ? ctx->get_val(value_h) : nullptr;
  if (!obj || !obj->is_object() || !val) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, key_ptr, key_len)) return;
  char* key = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, key_ptr));
  (*obj)[std::string(key, key_len)] = *val;
}
static int32_t val_keys_count(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  return (v && v->is_object()) ? static_cast<int32_t>(v->size()) : 0;
}
static int32_t val_key_at(wasm_exec_env_t env, int32_t h, int32_t index, int32_t buf_ptr, int32_t buf_len) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  if (!v || !v->is_object() || index < 0 || index >= static_cast<int32_t>(v->size())) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) return 0;
  char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
  auto it = v->begin();
  std::advance(it, index);
  const auto& key = it.key();
  int len = std::min(static_cast<int>(key.size()), buf_len);
  if (buf && len > 0) std::memcpy(buf, key.data(), len);
  return len;
}

static int32_t val_get_index(wasm_exec_env_t env, int32_t arr_h, int32_t index) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(arr_h) : nullptr;
  if (!v || !v->is_array() || index < 0 || index >= static_cast<int32_t>(v->size())) return 0;
  return ctx->alloc_val((*v)[index]);
}
static void val_push(wasm_exec_env_t env, int32_t arr_h, int32_t value_h) {
  auto* ctx = get_ctx(env);
  auto* arr = ctx ? ctx->get_val(arr_h) : nullptr;
  auto* val = ctx ? ctx->get_val(value_h) : nullptr;
  if (!arr || !arr->is_array() || !val) return;
  arr->push_back(*val);
}
static int32_t val_length(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  return (v && v->is_array()) ? static_cast<int32_t>(v->size()) : 0;
}

static void val_release(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  if (ctx) ctx->release_val(h);
}

static int32_t val_to_json(wasm_exec_env_t env, int32_t h, int32_t buf_ptr, int32_t buf_len) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  if (!v) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) return 0;
  char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
  std::string json = v->dump();
  int len = std::min(static_cast<int>(json.size()), buf_len);
  if (buf && len > 0) std::memcpy(buf, json.data(), len);
  return len;
}

static NativeSymbol val_symbols[] = {
    {"null", reinterpret_cast<void*>(val_null), "()i", nullptr},
    {"bool", reinterpret_cast<void*>(val_bool), "(i)i", nullptr},
    {"number", reinterpret_cast<void*>(val_number), "(F)i", nullptr},
    {"string", reinterpret_cast<void*>(val_string), "(ii)i", nullptr},
    {"array", reinterpret_cast<void*>(val_array), "()i", nullptr},
    {"object", reinterpret_cast<void*>(val_object), "()i", nullptr},
    {"type_of", reinterpret_cast<void*>(val_type_of), "(i)i", nullptr},
    {"as_number", reinterpret_cast<void*>(val_as_number), "(i)F", nullptr},
    {"as_bool", reinterpret_cast<void*>(val_as_bool), "(i)i", nullptr},
    {"as_string", reinterpret_cast<void*>(val_as_string), "(iii)i", nullptr},
    {"get", reinterpret_cast<void*>(val_get), "(iii)i", nullptr},
    {"set", reinterpret_cast<void*>(val_set), "(iiii)", nullptr},
    {"keys_count", reinterpret_cast<void*>(val_keys_count), "(i)i", nullptr},
    {"key_at", reinterpret_cast<void*>(val_key_at), "(iiii)i", nullptr},
    {"get_index", reinterpret_cast<void*>(val_get_index), "(ii)i", nullptr},
    {"push", reinterpret_cast<void*>(val_push), "(ii)", nullptr},
    {"length", reinterpret_cast<void*>(val_length), "(i)i", nullptr},
    {"release", reinterpret_cast<void*>(val_release), "(i)", nullptr},
    {"to_json", reinterpret_cast<void*>(val_to_json), "(iii)i", nullptr},
};

// ========================================================================
// Module "gpu" — GPU compute and rendering
// ========================================================================

static gpu::GPUBackend* get_gpu(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->gpu_backend : nullptr;
}

static int32_t gpu_get_backend(wasm_exec_env_t env) {
  auto* g = get_gpu(env);
  return g ? g->getBackend() : -1;
}

static int32_t gpu_create_shader_module(wasm_exec_env_t env, int32_t src_ptr, int32_t src_len) {
  auto* g = get_gpu(env);
  if (!g) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, src_ptr, src_len)) return -1;
  char* src = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, src_ptr));
  return src ? g->createShaderModule(std::string(src, src_len)) : -1;
}

static int32_t gpu_create_buffer(wasm_exec_env_t env, int32_t size, int32_t usage) {
  auto* g = get_gpu(env);
  return g ? g->createBuffer(size, usage) : -1;
}

static int32_t gpu_create_texture(wasm_exec_env_t env, int32_t w, int32_t h, int32_t fmt) {
  auto* g = get_gpu(env);
  return g ? g->createTexture(w, h, fmt) : -1;
}

static int32_t gpu_create_compute_pso(wasm_exec_env_t env, int32_t shader, int32_t entry_ptr, int32_t entry_len) {
  auto* g = get_gpu(env);
  if (!g) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, entry_ptr, entry_len)) return -1;
  char* e = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, entry_ptr));
  return e ? g->createComputePSO(shader, std::string(e, entry_len)) : -1;
}

static int32_t gpu_create_render_pso(wasm_exec_env_t env,
    int32_t vs_shader, int32_t vs_ptr, int32_t vs_len,
    int32_t fs_shader, int32_t fs_ptr, int32_t fs_len, int32_t fmt) {
  auto* g = get_gpu(env);
  if (!g) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, vs_ptr, vs_len)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, fs_ptr, fs_len)) return -1;
  char* vs = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, vs_ptr));
  char* fs = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, fs_ptr));
  if (!vs || !fs) return -1;
  return g->createRenderPSO(vs_shader, std::string(vs, vs_len),
                             fs_shader, std::string(fs, fs_len), fmt);
}

static void gpu_write_buffer(wasm_exec_env_t env, int32_t buf, int32_t offset, int32_t data_ptr, int32_t data_len) {
  auto* g = get_gpu(env);
  if (!g) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, data_ptr, data_len)) return;
  auto* data = static_cast<uint8_t*>(wasm_runtime_addr_app_to_native(inst, data_ptr));
  if (data) g->writeBuffer(buf, offset, data, data_len);
}

static int32_t gpu_begin_compute_pass(wasm_exec_env_t env) {
  auto* g = get_gpu(env); return g ? g->beginComputePass() : -1;
}
static void gpu_compute_set_pso(wasm_exec_env_t env, int32_t pass, int32_t pso) {
  auto* g = get_gpu(env); if (g) g->computeSetPSO(pass, pso);
}
static void gpu_compute_set_buffer(wasm_exec_env_t env, int32_t pass, int32_t buf, int32_t offset, int32_t slot) {
  auto* g = get_gpu(env); if (g) g->computeSetBuffer(pass, buf, offset, slot);
}
static void gpu_compute_set_texture(wasm_exec_env_t env, int32_t pass, int32_t tex, int32_t slot, int32_t access) {
  auto* g = get_gpu(env); if (g) g->computeSetTexture(pass, tex, slot, access);
}
static int32_t gpu_get_input_texture(wasm_exec_env_t env, int32_t index) {
  auto* ctx = get_ctx(env);
  if (!ctx || index < 0 || index >= static_cast<int32_t>(ctx->input_texture_handles.size())) return -1;
  return ctx->input_texture_handles[index];
}
static int32_t gpu_get_input_texture_count(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? static_cast<int32_t>(ctx->input_texture_handles.size()) : 0;
}
static int32_t gpu_texture_for_field(wasm_exec_env_t env, int32_t path_ptr, int32_t path_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, path_ptr, path_len)) return -1;
  char* path = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, path_ptr));
  if (!path) return -1;
  std::string field_path(path, path_len);
  auto it = ctx->texture_fields.find(field_path);
  return it != ctx->texture_fields.end() ? it->second : -1;
}
static void gpu_compute_dispatch(wasm_exec_env_t env, int32_t pass, int32_t x, int32_t y, int32_t z) {
  auto* g = get_gpu(env); if (g) g->computeDispatch(pass, x, y, z);
}
static void gpu_end_compute_pass(wasm_exec_env_t env, int32_t pass) {
  auto* g = get_gpu(env); if (g) g->endComputePass(pass);
}

static int32_t gpu_begin_render_pass(wasm_exec_env_t env, int32_t tex, float cr, float cg, float cb, float ca) {
  auto* g = get_gpu(env); return g ? g->beginRenderPass(tex, cr, cg, cb, ca) : -1;
}
static void gpu_render_set_pso(wasm_exec_env_t env, int32_t pass, int32_t pso) {
  auto* g = get_gpu(env); if (g) g->renderSetPSO(pass, pso);
}
static void gpu_render_set_vertex_buffer(wasm_exec_env_t env, int32_t pass, int32_t buf, int32_t offset, int32_t slot) {
  auto* g = get_gpu(env); if (g) g->renderSetVertexBuffer(pass, buf, offset, slot);
}
static void gpu_render_draw(wasm_exec_env_t env, int32_t pass, int32_t vc, int32_t ic) {
  auto* g = get_gpu(env); if (g) g->renderDraw(pass, vc, ic);
}
static void gpu_end_render_pass(wasm_exec_env_t env, int32_t pass) {
  auto* g = get_gpu(env); if (g) g->endRenderPass(pass);
}

static void gpu_submit(wasm_exec_env_t env) {
  auto* g = get_gpu(env); if (g) g->submit();
}
static int32_t gpu_get_render_target(wasm_exec_env_t env) {
  auto* g = get_gpu(env); return g ? g->getSurfaceTexture() : -1;
}
static int32_t gpu_get_render_target_width(wasm_exec_env_t env) {
  auto* g = get_gpu(env); return g ? g->getSurfaceWidth() : 0;
}
static int32_t gpu_get_render_target_height(wasm_exec_env_t env) {
  auto* g = get_gpu(env); return g ? g->getSurfaceHeight() : 0;
}
static void gpu_release(wasm_exec_env_t env, int32_t handle) {
  auto* g = get_gpu(env); if (g) g->release(handle);
}

static NativeSymbol gpu_symbols[] = {
    {"get_backend", reinterpret_cast<void*>(gpu_get_backend), "()i", nullptr},
    {"create_shader_module", reinterpret_cast<void*>(gpu_create_shader_module), "(ii)i", nullptr},
    {"create_buffer", reinterpret_cast<void*>(gpu_create_buffer), "(ii)i", nullptr},
    {"create_texture", reinterpret_cast<void*>(gpu_create_texture), "(iii)i", nullptr},
    {"create_compute_pso", reinterpret_cast<void*>(gpu_create_compute_pso), "(iii)i", nullptr},
    {"create_render_pso", reinterpret_cast<void*>(gpu_create_render_pso), "(iiiiiii)i", nullptr},
    {"write_buffer", reinterpret_cast<void*>(gpu_write_buffer), "(iiii)", nullptr},
    {"begin_compute_pass", reinterpret_cast<void*>(gpu_begin_compute_pass), "()i", nullptr},
    {"compute_set_pso", reinterpret_cast<void*>(gpu_compute_set_pso), "(ii)", nullptr},
    {"compute_set_buffer", reinterpret_cast<void*>(gpu_compute_set_buffer), "(iiii)", nullptr},
    {"compute_set_texture", reinterpret_cast<void*>(gpu_compute_set_texture), "(iiii)", nullptr},
    {"compute_dispatch", reinterpret_cast<void*>(gpu_compute_dispatch), "(iiii)", nullptr},
    {"end_compute_pass", reinterpret_cast<void*>(gpu_end_compute_pass), "(i)", nullptr},
    {"begin_render_pass", reinterpret_cast<void*>(gpu_begin_render_pass), "(iffff)i", nullptr},
    {"render_set_pso", reinterpret_cast<void*>(gpu_render_set_pso), "(ii)", nullptr},
    {"render_set_vertex_buffer", reinterpret_cast<void*>(gpu_render_set_vertex_buffer), "(iiii)", nullptr},
    {"render_draw", reinterpret_cast<void*>(gpu_render_draw), "(iii)", nullptr},
    {"end_render_pass", reinterpret_cast<void*>(gpu_end_render_pass), "(i)", nullptr},
    {"submit", reinterpret_cast<void*>(gpu_submit), "()", nullptr},
    {"get_render_target", reinterpret_cast<void*>(gpu_get_render_target), "()i", nullptr},
    {"get_render_target_width", reinterpret_cast<void*>(gpu_get_render_target_width), "()i", nullptr},
    {"get_render_target_height", reinterpret_cast<void*>(gpu_get_render_target_height), "()i", nullptr},
    {"release", reinterpret_cast<void*>(gpu_release), "(i)", nullptr},
    {"get_input_texture", reinterpret_cast<void*>(gpu_get_input_texture), "(i)i", nullptr},
    {"get_input_texture_count", reinterpret_cast<void*>(gpu_get_input_texture_count), "()i", nullptr},
    {"texture_for_field", reinterpret_cast<void*>(gpu_texture_for_field), "(ii)i", nullptr},
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

  ok = ok && wasm_runtime_register_natives(
      "io", io_symbols,
      sizeof(io_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "val", val_symbols,
      sizeof(val_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "gpu", gpu_symbols,
      sizeof(gpu_symbols) / sizeof(NativeSymbol));

  return ok;
}

} // namespace wasm
