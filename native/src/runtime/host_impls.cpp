// host_impls.cpp — extern-C implementations of every host import the
// effects' main.cpp files reference via <host.h>. Effects compiled for
// native (not WASM) see plain extern declarations and link against
// these symbols. Each impl routes to the currently-active EffectInstance
// owned by the singleton runtime — see effect_runtime.h.
//
// Coverage strategy: implement the subset that soft_glow + motion_blur
// actually use; everything else gets a no-op or "log + ignore" stub.
// As we add more effects to the native bundle, more stubs become real
// implementations.

#include "runtime/effect_runtime.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>
#include <nlohmann/json.hpp>

using effect_runtime::EffectInstance;
using effect_runtime::EffectRuntime;
using effect_runtime::currentRuntime;

namespace {

EffectInstance* active() {
  auto* rt = currentRuntime();
  return rt ? rt->active() : nullptr;
}

// --- val_* handle table (process-wide) ---
// Effect code calls val::get / val::asNumber etc. via these. Backed by
// a flat vector of nlohmann::json values; handles are 1-based indices.
// 0 = null handle.
std::vector<nlohmann::json> g_vals;
std::vector<std::string> g_val_strings;  // string lifetime for asString

int val_alloc(nlohmann::json v) {
  g_vals.push_back(std::move(v));
  return static_cast<int>(g_vals.size());
}

nlohmann::json* val_lookup(int h) {
  if (h <= 0 || h > (int)g_vals.size()) return nullptr;
  return &g_vals[h - 1];
}

}  // namespace

// ============================================================================
// state.* imports
// ============================================================================
extern "C" {

void state_set_metadata(const char* id, int id_len, int version_packed) {
  auto* inst = active();
  if (!inst) return;
  int major = (version_packed >> 16) & 0xFF;
  int minor = (version_packed >> 8) & 0xFF;
  int patch = version_packed & 0xFF;
  std::string version = std::to_string(major) + "." +
                        std::to_string(minor) + "." +
                        std::to_string(patch);
  inst->hostSetMetadata(std::string(id, id_len), std::move(version));
}

void state_set_schema(const char* id, int id_len, int version_packed,
                       const char* schema_json, int schema_json_len) {
  auto* inst = active();
  if (!inst) return;
  // Modern effects (post-state::init refactor) only call set_schema —
  // mirror the web host's behavior and stash metadata id/version here
  // too. The web host's set_schema impl (web/src/wasm-host.ts:495)
  // does the same.
  int major = (version_packed >> 16) & 0xFF;
  int minor = (version_packed >> 8) & 0xFF;
  int patch = version_packed & 0xFF;
  std::string version = std::to_string(major) + "." +
                        std::to_string(minor) + "." +
                        std::to_string(patch);
  inst->hostSetMetadata(std::string(id, id_len), std::move(version));
  inst->hostSetSchema(std::string(schema_json, schema_json_len));
}

void state_declare_param(int, const char*, int, int, float) { /* legacy no-op */ }

int  state_get_key(char* /*buf*/, int /*buf_len*/) { return 0; }

void state_console_log(int /*level*/, const char* msg, int msg_len) {
  auto* rt = currentRuntime();
  if (rt) rt->log("log", std::string_view(msg, msg_len));
}
void state_console_log_structured(int /*level*/, const char* msg, int msg_len,
                                   const char* /*json*/, int /*json_len*/) {
  auto* rt = currentRuntime();
  if (rt) rt->log("log", std::string_view(msg, msg_len));
}

void state_set(const char* /*path*/, int /*path_len*/,
                const char* /*json*/, int /*json_len*/) { /* legacy no-op */ }
void state_set_val(const char* /*path*/, int /*path_len*/, int /*val_h*/) {}

void state_mark_gpu_dirty(const char* /*path*/, int /*path_len*/) {}
void state_set_gpu_buffer(const char* path, int path_len, int buffer_handle) {
  auto* inst = active();
  if (!inst) return;
  inst->setBufferField(std::string(path, path_len), buffer_handle);
}
void state_set_gpu_texture(const char* path, int path_len, int texture_handle) {
  auto* inst = active();
  if (!inst) return;
  inst->setTextureField(std::string(path, path_len), texture_handle);
}
void state_set_field_hidden(const char* /*path*/, int /*path_len*/, int /*hidden*/) {}

int state_is_field_connected(const char* path, int path_len, int direction) {
  auto* inst = active();
  if (!inst) return 0;
  std::string p(path, path_len);
  return (direction == 0 ? inst->isInputConnected(p)
                          : inst->isOutputConnected(p)) ? 1 : 0;
}

int state_will_render() {
  auto* inst = active();
  return (inst && inst->willRender()) ? 1 : 0;
}

void state_set_on_state_ready(void (*fn)(void* self)) {
  auto* inst = active();
  if (!inst) return;
  inst->hostSetOnStateReady(fn);
}

void state_register_shader_spv(const char* name, int name_len,
                                const unsigned char* spv, int spv_len,
                                const char* format, int format_len,
                                const char* access, int access_len) {
  auto* inst = active();
  if (!inst) return;
  inst->hostRegisterShaderSpv(std::string_view(name, name_len),
                              spv, spv_len,
                              std::string_view(format, format_len),
                              std::string_view(access, access_len));
}

void state_register_fusion(int kind,
                            const char* /*frag_wgsl*/, int /*frag_wgsl_len*/,
                            const char* /*frag_msl*/, int /*frag_msl_len*/,
                            int uniform_buf_handle, int uniform_size_bytes,
                            void(*prepare)(void*, int, int)) {
  // Older variant — the explicit-source form isn't what the modern
  // effects use, but we still wire it to the same path with no
  // fragment name. The native executor's fusion planner skips groups
  // whose fragmentName is empty.
  if (auto* inst = active()) {
    effect_runtime::EffectInstance::FusionInfo info;
    info.kind = kind;
    info.uniformBufferHandle = uniform_buf_handle;
    info.uniformSizeBytes = uniform_size_bytes;
    info.prepare = prepare;
    inst->setFusionInfo(std::move(info));
  }
}
void state_register_fusion_by_name(int kind,
                                    const char* fragment_name, int fragment_name_len,
                                    int uniform_buf_handle, int uniform_size_bytes,
                                    void(*prepare)(void*, int, int)) {
  if (auto* inst = active()) {
    effect_runtime::EffectInstance::FusionInfo info;
    info.kind = kind;
    if (fragment_name && fragment_name_len > 0) {
      info.fragmentName.assign(fragment_name, (size_t)fragment_name_len);
    }
    info.uniformBufferHandle = uniform_buf_handle;
    info.uniformSizeBytes = uniform_size_bytes;
    info.prepare = prepare;
    inst->setFusionInfo(std::move(info));
  }
}

int state_read(const char*, int, const char*,
                char*, int, char*) { return 0; }

// Patch reading — runtime sets up the patch as a JSON object {op, path,
// value} in the instance's val table during firePatched. state_get_patch
// returns a global val handle pointing at that object.
int state_get_patch(int index) {
  auto* inst = active();
  if (!inst) return 0;
  // The instance stashed each patch's JSON blob in val_blobs_; allocate
  // a global val handle from it so val::get / val::asNumber can walk.
  std::string blob = inst->val_to_json(index + 1);   // 1-based
  auto parsed = nlohmann::json::parse(blob, nullptr, false);
  if (parsed.is_discarded()) return 0;
  return val_alloc(std::move(parsed));
}

}  // extern "C" — state

// ============================================================================
// host.* imports — timing + viewport + audio
// ============================================================================
extern "C" {
// These currently feed off process-wide globals settable by the test
// runner / FFGL plugin shell. None of the lights-bundle effects rely
// on these directly (they read dt via tick()), so default-zero is OK.
static double g_host_time = 0.0;
static double g_host_dt = 0.0;
static double g_host_bar_phase = 0.0;
static double g_host_bpm = 120.0;
static int    g_host_vp_w = 0;
static int    g_host_vp_h = 0;

double host_get_time(void)        { return g_host_time; }
double host_get_delta_time(void)  { return g_host_dt; }
double host_get_bar_phase(void)   { return g_host_bar_phase; }
double host_get_bpm(void)         { return g_host_bpm; }
double host_get_param(int)        { return 0.0; }
int    host_get_viewport_w(void)  { return g_host_vp_w; }
int    host_get_viewport_h(void)  { return g_host_vp_h; }
void   host_trigger_audio(int)    {}

// Test-runner / plugin shell setter helpers (non-extern-C — only used
// internally by the runtime user).
}  // extern "C" — host

namespace effect_runtime {
void setHostTime(double t)       { g_host_time = t; }
void setHostDeltaTime(double dt) { g_host_dt = dt; }
void setHostBarPhase(double p)   { g_host_bar_phase = p; }
void setHostBpm(double bpm)      { g_host_bpm = bpm; }
void setHostViewport(int w, int h) { g_host_vp_w = w; g_host_vp_h = h; }
}  // namespace effect_runtime

// ============================================================================
// canvas.* imports — UI canvas (not used by lights effects)
// ============================================================================
extern "C" {
void canvas_fill_rect(float, float, float, float, float, float, float, float) {}
void canvas_draw_image(int, float, float, float, float) {}
void canvas_draw_text(const char*, int, float, float, float, float, float, float, float) {}
}

// ============================================================================
// resolume.* imports — Resolume host bindings (not used by lights)
// ============================================================================
extern "C" {
double resolume_get_param(int64_t)              { return 0.0; }
void   resolume_set_param(int64_t, double)      {}
void   resolume_subscribe_query(const char*, int) {}
int    resolume_get_param_path(int64_t, char*, int) { return 0; }
void   resolume_trigger_clip(int64_t, int)      {}
int    resolume_get_clip_count(void)            { return 0; }
int    resolume_get_clip_channel(int)           { return 0; }
int64_t resolume_get_clip_id(int)               { return 0; }
int    resolume_get_clip_connected(int)         { return 0; }
int    resolume_get_clip_name(int, char*, int)  { return 0; }
int    resolume_load_thumbnail(int)             { return 0; }
}

// ============================================================================
// val.* imports — JSON-handle table used by patch reading
// ============================================================================
extern "C" {

int val_null(void)         { return val_alloc(nullptr); }
int val_bool(int v)        { return val_alloc(v != 0); }
int val_number(double v)   { return val_alloc(v); }
int val_string(const char* s, int len) {
  return val_alloc(std::string(s, len));
}
int val_array(void)        { return val_alloc(nlohmann::json::array()); }
int val_object(void)       { return val_alloc(nlohmann::json::object()); }

int val_type_of(int h) {
  auto* v = val_lookup(h);
  if (!v) return 0;
  if (v->is_null())    return 0;
  if (v->is_boolean()) return 1;
  if (v->is_number())  return 2;
  if (v->is_string())  return 3;
  if (v->is_array())   return 4;
  if (v->is_object())  return 5;
  return 0;
}

double val_as_number(int h) {
  auto* v = val_lookup(h);
  if (!v || !v->is_number()) return 0.0;
  return v->get<double>();
}

int val_as_bool(int h) {
  auto* v = val_lookup(h);
  if (!v) return 0;
  if (v->is_boolean()) return v->get<bool>() ? 1 : 0;
  if (v->is_number()) return v->get<double>() != 0.0 ? 1 : 0;
  return 0;
}

int val_as_string(int h, char* buf, int buf_len) {
  auto* v = val_lookup(h);
  if (!v || !v->is_string()) return 0;   // non-string (incl. null/discarded) → empty;
                                          // NOT dump() — that turned a null value into the
                                          // literal text "null" when read by a string field.
                                          // Matches bridge_core_val_as_string.
  const std::string& s = v->get_ref<const std::string&>();
  int n = std::min((int)s.size(), buf_len);
  if (buf && n > 0) memcpy(buf, s.data(), n);
  return (int)s.size();
}

int val_get(int obj, const char* key, int key_len) {
  auto* v = val_lookup(obj);
  if (!v || !v->is_object()) return val_alloc(nullptr);
  std::string k(key, key_len);
  if (!v->contains(k)) return val_alloc(nullptr);
  return val_alloc((*v)[k]);
}

void val_set(int obj, const char* key, int key_len, int value) {
  auto* v = val_lookup(obj);
  if (!v || !v->is_object()) return;
  auto* val = val_lookup(value);
  if (!val) return;
  (*v)[std::string(key, key_len)] = *val;
}

int val_keys_count(int obj) {
  auto* v = val_lookup(obj);
  if (!v || !v->is_object()) return 0;
  return (int)v->size();
}

int val_key_at(int obj, int index, char* buf, int buf_len) {
  auto* v = val_lookup(obj);
  if (!v || !v->is_object()) return 0;
  int i = 0;
  for (auto it = v->begin(); it != v->end(); ++it, ++i) {
    if (i == index) {
      const std::string& k = it.key();
      int n = std::min((int)k.size(), buf_len);
      if (buf && n > 0) memcpy(buf, k.data(), n);
      return (int)k.size();
    }
  }
  return 0;
}

int val_get_index(int arr, int index) {
  auto* v = val_lookup(arr);
  if (!v || !v->is_array() || index < 0 || index >= (int)v->size())
    return val_alloc(nullptr);
  return val_alloc((*v)[index]);
}

void val_push(int arr, int value) {
  auto* v = val_lookup(arr);
  auto* val = val_lookup(value);
  if (!v || !val || !v->is_array()) return;
  v->push_back(*val);
}

int val_length(int arr) {
  auto* v = val_lookup(arr);
  if (!v) return 0;
  if (v->is_array() || v->is_string() || v->is_object()) return (int)v->size();
  return 0;
}

void val_release(int /*h*/) {
  // No-op: val handles for the current patch transaction are
  // implicitly freed when the next setParam* call clears the table.
  // True per-handle release would require a free-list; not needed yet.
}

int val_to_json(int h, char* buf, int buf_len) {
  auto* v = val_lookup(h);
  if (!v) return 0;
  std::string s = v->dump();
  int n = std::min((int)s.size(), buf_len);
  if (buf && n > 0) memcpy(buf, s.data(), n);
  return (int)s.size();
}

}  // extern "C" — val

// ============================================================================
// module.* imports — bundle registration
// ============================================================================
extern "C" {
void nano_register_effect(const void* desc_ptr) {
  auto* rt = currentRuntime();
  if (rt) rt->registerFromDesc(desc_ptr);
}
}  // extern "C"
