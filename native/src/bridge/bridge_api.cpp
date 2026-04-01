#include "bridge/bridge_api.h"
#include "bridge/bridge_server.h"

using bridge::BridgeServer;

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

} // extern "C"
