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
  auto* server = static_cast<BridgeServer*>(h);
  server->release();
}

double bridge_get_param(BridgeHandle h, int64_t param_id) {
  if (!h) return 0.0;
  auto* server = static_cast<BridgeServer*>(h);
  return server->param_cache().get(param_id);
}

void bridge_set_param(BridgeHandle h, int64_t param_id, double value) {
  if (!h) return;
  auto* server = static_cast<BridgeServer*>(h);
  server->param_cache().set(param_id, value);
  server->param_cache().queue_write(param_id, value);
}

void bridge_tick(BridgeHandle h) {
  if (!h) return;
  auto* server = static_cast<BridgeServer*>(h);
  server->tick();
}

int32_t bridge_load_wasm(BridgeHandle h, const uint8_t* bytecode, uint32_t len) {
  if (!h) return -1;
  auto* server = static_cast<BridgeServer*>(h);
  return server->load_wasm(bytecode, len);
}

void bridge_unload_wasm(BridgeHandle h, int32_t module_id) {
  if (!h) return;
  auto* server = static_cast<BridgeServer*>(h);
  server->unload_wasm(module_id);
}

int32_t bridge_call_wasm(BridgeHandle h, int32_t module_id, const char* func_name) {
  if (!h) return -1;
  auto* server = static_cast<BridgeServer*>(h);
  return server->call_wasm(module_id, func_name);
}

} // extern "C"
