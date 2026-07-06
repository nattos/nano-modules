#include "bridge/bridge_api.h"
#include "bridge/bridge_server.h"
#include "bridge/barrel_runtime.h"
#include "wasm/audio_bus.h"

#include <cstdlib>
#include <cstring>
#include <string>

using bridge::BridgeServer;

namespace {
// Heap-copy a std::string into a malloc'd, NUL-terminated C string the
// caller frees with bridge_free_string (same allocator, inside the dylib).
char* dup_string(const std::string& s) {
  char* out = static_cast<char*>(std::malloc(s.size() + 1));
  if (!out) return nullptr;
  std::memcpy(out, s.data(), s.size());
  out[s.size()] = '\0';
  return out;
}
} // namespace

extern "C" {

BridgeHandle bridge_init(void) {
  auto& server = BridgeServer::instance();
  server.acquire();
  return static_cast<BridgeHandle>(&server);
}

void bridge_release(BridgeHandle h) {
  if (!h) return;
  static_cast<BridgeServer*>(h)->release();
}

double bridge_get_param(BridgeHandle h, int64_t param_id) {
  if (!h) return 0.0;
  return static_cast<BridgeServer*>(h)->param_cache().get(param_id);
}

void bridge_set_param(BridgeHandle h, int64_t param_id, double value) {
  if (!h) return;
  auto* s = static_cast<BridgeServer*>(h);
  s->param_cache().set(param_id, value);
  s->param_cache().queue_write(param_id, value);
}

void bridge_tick(BridgeHandle h) {
  if (!h) return;
  static_cast<BridgeServer*>(h)->tick();
}

int32_t bridge_load_wasm(BridgeHandle h, const uint8_t* bytecode, uint32_t len) {
  if (!h) return -1;
  return static_cast<BridgeServer*>(h)->load_wasm(bytecode, len);
}

void bridge_unload_wasm(BridgeHandle h, int32_t module_id) {
  if (!h) return;
  static_cast<BridgeServer*>(h)->unload_wasm(module_id);
}

int32_t bridge_call_wasm(BridgeHandle h, int32_t module_id, const char* func_name) {
  if (!h) return -1;
  return static_cast<BridgeServer*>(h)->call_wasm(module_id, func_name);
}

void bridge_set_frame_state(BridgeHandle h, int32_t module_id,
    double elapsed, double dt, double bar_phase, double bpm,
    int vp_w, int vp_h) {
  if (!h) return;
  static_cast<BridgeServer*>(h)->set_frame_state(module_id, elapsed, dt, bar_phase, bpm, vp_w, vp_h);
}

void bridge_set_ffgl_param(BridgeHandle h, int32_t module_id, int index, double value) {
  if (!h) return;
  static_cast<BridgeServer*>(h)->set_ffgl_param(module_id, index, value);
}

void* bridge_render(BridgeHandle h, int32_t module_id, int vp_w, int vp_h) {
  if (!h) return nullptr;
  return static_cast<BridgeServer*>(h)->render(module_id, vp_w, vp_h);
}

int32_t bridge_call_tick(BridgeHandle h, int32_t module_id, double dt) {
  if (!h) return -1;
  return static_cast<BridgeServer*>(h)->call_tick(module_id, dt);
}

int32_t bridge_call_on_param(BridgeHandle h, int32_t module_id, int index, double value) {
  if (!h) return -1;
  return static_cast<BridgeServer*>(h)->call_on_param(module_id, index, value);
}

void bridge_set_audio_callback(BridgeHandle h, int32_t module_id,
    AudioTriggerCallback fn, void* userdata) {
  if (!h) return;
  static_cast<BridgeServer*>(h)->set_audio_callback(module_id, fn, userdata);
}

// Effect audio-trigger fan-out — process-global registry (audio_bus). The
// handle is unused (registry isn't tied to a server instance); accepted for ABI
// symmetry. AudioListenerFn and audio_bus::Listener are the same signature.
uint64_t bridge_add_audio_listener(BridgeHandle h, AudioListenerFn fn, void* userdata) {
  (void)h;
  return audio_bus::add(fn, userdata);
}

void bridge_remove_audio_listener(BridgeHandle h, uint64_t token) {
  (void)h;
  audio_bus::remove(token);
}

// --- Multiplexed plugin instances ---

int32_t bridge_register_plugin(BridgeHandle h, const char* id,
    int major, int minor, int patch,
    const char* schema_json, const char* requested_key,
    char* out_key, int32_t out_key_cap) {
  if (!h || !id) return 0;
  std::string key = static_cast<BridgeServer*>(h)->register_plugin(
      id, major, minor, patch,
      schema_json ? schema_json : "",
      requested_key ? requested_key : "");
  if (out_key && out_key_cap > 0) {
    int32_t n = static_cast<int32_t>(key.size());
    int32_t copy = n < out_key_cap - 1 ? n : out_key_cap - 1;
    std::memcpy(out_key, key.data(), copy);
    out_key[copy] = '\0';
  }
  return static_cast<int32_t>(key.size());
}

void bridge_unregister_plugin(BridgeHandle h, const char* key) {
  if (!h || !key) return;
  static_cast<BridgeServer*>(h)->unregister_plugin(key);
}

void bridge_register_patch_listener(BridgeHandle h, const char* key,
    BridgePatchListenerFn fn, void* userdata) {
  if (!h || !key || !fn) return;
  std::string k = key;
  static_cast<BridgeServer*>(h)->register_patch_listener(k,
      [fn, userdata](const std::string& pk) { fn(pk.c_str(), userdata); });
}

void bridge_unregister_patch_listener(BridgeHandle h, const char* key) {
  if (!h || !key) return;
  static_cast<BridgeServer*>(h)->unregister_patch_listener(key);
}

void bridge_set_plugin_state(BridgeHandle h, const char* key, const char* json) {
  if (!h || !key || !json) return;
  static_cast<BridgeServer*>(h)->set_plugin_state(key, json);
}

char* bridge_get_plugin_state(BridgeHandle h, const char* key) {
  if (!h || !key) return nullptr;
  return dup_string(static_cast<BridgeServer*>(h)->get_plugin_state(key));
}

void bridge_set_at(BridgeHandle h, const char* path, const char* json) {
  if (!h || !path || !json) return;
  static_cast<BridgeServer*>(h)->set_at(path, json);
}

char* bridge_get_at(BridgeHandle h, const char* path) {
  if (!h || !path) return nullptr;
  return dup_string(static_cast<BridgeServer*>(h)->get_at(path));
}

void bridge_free_string(char* s) {
  std::free(s);
}

void bridge_broadcast_binary(BridgeHandle h, const uint8_t* data, uint32_t len) {
  if (!h || !data || len == 0) return;
  static_cast<BridgeServer*>(h)->broadcast_binary(data, len);
}

int bridge_has_clients(BridgeHandle h) {
  if (!h) return 0;
  return static_cast<BridgeServer*>(h)->has_clients() ? 1 : 0;
}

int bridge_key_observed(BridgeHandle h, const char* key) {
  if (!h || !key) return 0;
  return static_cast<BridgeServer*>(h)->key_observed(key) ? 1 : 0;
}

// --- Shared effect runtime ---

int bridge_rt_acquire(BridgeHandle h, const char* wasm_dir, const char* font_path) {
  if (!h) return 0;
  return bridge::BarrelRuntime::instance().acquire(
      wasm_dir ? wasm_dir : "", font_path ? font_path : "") ? 1 : 0;
}

void bridge_rt_release(BridgeHandle h) {
  if (!h) return;
  bridge::BarrelRuntime::instance().release();
}

void* bridge_rt_metal_device(BridgeHandle h) {
  if (!h) return nullptr;
  return bridge::BarrelRuntime::instance().metalDevice();
}

char* bridge_rt_schemas(BridgeHandle h) {
  if (!h) return nullptr;
  return dup_string(bridge::BarrelRuntime::instance().schemasJson());
}

void bridge_executor_create(BridgeHandle h, const char* key) {
  if (!h || !key) return;
  bridge::BarrelRuntime::instance().createExecutor(key);
}

void bridge_executor_destroy(BridgeHandle h, const char* key) {
  if (!h || !key) return;
  bridge::BarrelRuntime::instance().destroyExecutor(key);
}

int bridge_executor_render(BridgeHandle h, const char* key,
    void* in_tex, void* out_tex, int w, int hgt, double dt, double elapsed,
    int dirty, const float* macros, int n_macros,
    double bar_phase, double bpm) {
  if (!h || !key) return 0;
  return bridge::BarrelRuntime::instance().render(key, in_tex, out_tex, w, hgt,
      dt, elapsed, dirty != 0, macros, n_macros, bar_phase, bpm) ? 1 : 0;
}

} // extern "C"
