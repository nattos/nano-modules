#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

#include "bridge/param_cache.h"

namespace resolume {
class WsClient;
}

namespace wasm {
class WasmHost;
}

namespace bridge {

class WsServer;

/// Process-wide singleton bridge server.
/// Owns all subsystems: Resolume WS client, WS server, WASM host, param cache.
class BridgeServer {
public:
  static BridgeServer& instance();

  /// Increment reference count. Initializes subsystems on first call.
  void acquire();

  /// Decrement reference count. Shuts down when it reaches zero.
  void release();

  ParamCache& param_cache() { return param_cache_; }

  /// Poll WS inbox, tick WASM, flush outbox. Mutex-guarded.
  void tick();

  // WASM module management
  int32_t load_wasm(const uint8_t* bytecode, uint32_t len);
  void unload_wasm(int32_t module_id);
  int32_t call_wasm(int32_t module_id, const char* func_name);

private:
  BridgeServer();
  ~BridgeServer();
  BridgeServer(const BridgeServer&) = delete;
  BridgeServer& operator=(const BridgeServer&) = delete;

  void init_subsystems();
  void shutdown_subsystems();
  void process_resolume_messages();
  void flush_outbox();

  ParamCache param_cache_;
  std::atomic<int> ref_count_{0};
  std::mutex tick_mutex_;
  bool subsystems_initialized_ = false;

  std::unique_ptr<resolume::WsClient> resolume_client_;
  std::unique_ptr<WsServer> ws_server_;
  std::unique_ptr<wasm::WasmHost> wasm_host_;

  // Maps param ID -> canonical path (for sending writes back to Resolume)
  std::unordered_map<int64_t, std::string> param_paths_;
};

} // namespace bridge
