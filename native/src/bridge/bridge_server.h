#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

#include "bridge/bridge_core.h"
#include "canvas/draw_list.h"
#include "wasm/wasm_context.h"

namespace resolume {
class WsClient;
}

namespace wasm {
class WasmHost;
}

namespace bridge {

class WsServer;

class BridgeServer {
public:
  static BridgeServer& instance();

  void acquire();
  void release();

  BridgeCore& core() { return core_; }
  ParamCache& param_cache() { return core_.param_cache(); }
  CompositionCache& composition_cache() { return core_.composition_cache(); }
  StateDocument& state_document() { return core_.state_document(); }

  void tick();

  int32_t load_wasm(const uint8_t* bytecode, uint32_t len);
  void unload_wasm(int32_t module_id);
  int32_t call_wasm(int32_t module_id, const char* func_name);

  void set_frame_state(int32_t module_id,
      double elapsed, double dt, double bar_phase, double bpm,
      int vp_w, int vp_h);
  void set_ffgl_param(int32_t module_id, int index, double value);

  canvas::DrawList* render(int32_t module_id, int vp_w, int vp_h);
  int32_t call_tick(int32_t module_id, double dt);
  int32_t call_on_param(int32_t module_id, int index, double value);

  void set_audio_callback(int32_t module_id, wasm::AudioTriggerCallback cb, void* userdata);

private:
  BridgeServer();
  ~BridgeServer();
  BridgeServer(const BridgeServer&) = delete;
  BridgeServer& operator=(const BridgeServer&) = delete;

  void init_subsystems();
  void shutdown_subsystems();
  void process_resolume_messages();
  void flush_outbox();

  BridgeCore core_;

  std::atomic<int> ref_count_{0};
  std::mutex tick_mutex_;
  bool subsystems_initialized_ = false;

  std::unique_ptr<resolume::WsClient> resolume_client_;
  std::unique_ptr<WsServer> ws_server_;
  std::unique_ptr<wasm::WasmHost> wasm_host_;

  std::unordered_map<int32_t, canvas::DrawList> draw_lists_;
  std::unordered_map<int32_t, wasm::FrameState> frame_states_;
};

} // namespace bridge
