#pragma once

#include <atomic>
#include <cstddef>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <nlohmann/json_fwd.hpp>

#include "bridge/bridge_core.h"
#include "bridge/clip_launcher.h"
#include "bridge/instance_locator.h"
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

  // --- Multiplexed plugin instances (used by the FFGL barrel) ---
  // All JSON crosses as serialized UTF-8 strings; nlohmann::json objects
  // must never cross the dylib boundary.

  /// Register an instance; returns the key actually registered (may differ
  /// from `requested_key` on collision — see StateDocument::register_plugin).
  /// Pass an empty schema_json to register without a schema.
  std::string register_plugin(const std::string& id, int major, int minor, int patch,
                              const std::string& schema_json,
                              const std::string& requested_key);
  void unregister_plugin(const std::string& key);

  void register_patch_listener(const std::string& key, BridgeCore::ClientPatchCallback cb);
  void unregister_patch_listener(const std::string& key);

  void set_plugin_state(const std::string& key, const std::string& state_json);
  std::string get_plugin_state(const std::string& key);
  void set_at(const std::string& path, const std::string& value_json);
  std::string get_at(const std::string& path);

  void broadcast_binary(const void* data, size_t len);
  bool has_clients();
  /// True if any connected client observes `/plugins/<key>/state` (or an
  /// ancestor of it). Lets an instance skip per-frame telemetry/preview work
  /// when nobody is actually watching *that* instance.
  bool key_observed(const std::string& key);

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
  // Drain the trigger rail + reconcile Resolume clip launches (pump thread).
  void drive_clip_launches();
  // Publish channel → registered marker clips to /global/channels for the web
  // Instances tab (change-gated). Pump thread; after process_resolume_messages
  // so the composition cache is fresh.
  void publish_trigger_channels();
  void pump_loop();

  BridgeCore core_;

  std::atomic<int> ref_count_{0};
  std::mutex tick_mutex_;
  bool subsystems_initialized_ = false;

  // WS events are enqueued here (leaf lock only) by the ix callbacks and
  // drained by the pump thread. The ix callbacks must NOT take tick_mutex_
  // or call into core_ directly: the disconnect callback runs while holding
  // WsServer::clients_mutex_, and broadcasting from the pump briefly takes
  // clients_mutex_ while holding tick_mutex_ — doing core_ work from the ix
  // callback under tick_mutex_ closes that cycle into a deadlock.
  struct InboxEvent { int cid; bool is_message; std::string msg; };
  std::mutex inbox_mu_;
  std::vector<InboxEvent> inbox_;
  std::thread pump_thread_;
  std::atomic<bool> pump_stop_{false};

  std::unique_ptr<resolume::WsClient> resolume_client_;
  // Correlates NanoBarrel instances with their Resolume composition location
  // (drives per-instance default display names). Only touched from the pump
  // thread under tick_mutex_.
  InstanceLocator instance_locator_;
  // Turns trigger-rail events into Resolume clip launches with a reconcile loop
  // (the piano-trigger stuck-on fix). Only touched from the pump thread.
  ClipLauncher clip_launcher_;
  // Strict-precision trigger queue (precision.mode == "strict"). A strict event
  // waits here until the barrel render loop presents a frame reflecting it
  // (barrelPresentSeq advanced past `floor_present` → release + full reconcile),
  // or its `deadline_ms` elapses → the pipe is assumed borked and ALL queued
  // strict events flush, fully reconciling only the newest. The fold that
  // decides this is the pure `planStrict` (clip_launcher.h). Pump thread only.
  std::vector<StrictPending> pending_strict_;
  // FNV hash of the last /global/channels doc we published — skip the set_at
  // (and its patch broadcast) when the channel→clips map is unchanged.
  uint64_t trigger_channels_hash_ = 0;
  // shared_ptr (not unique): broadcast_binary copies the pointer under a brief
  // tick_mutex_ hold, then runs the (CPU-heavy) permessage-deflate + send on the
  // copy OUTSIDE the lock — so a preview frame's compression never stalls the
  // render thread, which needs tick_mutex_ each frame. The local copy keeps the
  // server alive across a concurrent shutdown reset().
  std::shared_ptr<WsServer> ws_server_;
  std::unique_ptr<wasm::WasmHost> wasm_host_;

  std::unordered_map<int32_t, canvas::DrawList> draw_lists_;
  std::unordered_map<int32_t, wasm::FrameState> frame_states_;
};

} // namespace bridge
