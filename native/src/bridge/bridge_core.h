#pragma once

#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

#include "bridge/param_cache.h"
#include "bridge/composition_cache.h"
#include "bridge/state_document.h"
#include "bridge/observer_registry.h"
#include "bridge/platform/mutex.h"

namespace bridge {

/// Platform-agnostic protocol engine for the bridge server.
/// Manages state document, observer registry, param cache, and the
/// JSON message protocol. Does not own any transport or WASM runtime —
/// those are injected via callbacks.
class BridgeCore {
public:
  /// Callback to send a message to a specific client.
  using SendCallback = std::function<void(int client_id, const std::string& msg)>;

  BridgeCore();

  ParamCache& param_cache() { return param_cache_; }
  CompositionCache& composition_cache() { return composition_cache_; }
  StateDocument& state_document() { return state_doc_; }
  ObserverRegistry& observers() { return observers_; }

  /// Set the callback used to send messages to clients.
  void set_send_callback(SendCallback cb) { send_cb_ = std::move(cb); }

  /// Process an incoming JSON message from a client.
  void handle_message(int client_id, const std::string& msg);

  /// Remove a client and all its subscriptions.
  void remove_client(int client_id);

  /// Drain pending state patches and broadcast to subscribed clients.
  void broadcast_state_patches();

  /// Convenience: calls broadcast_state_patches.
  void tick();

  // --- Resolume param helpers ---
  void set_param_path(int64_t param_id, const std::string& path);
  std::string get_param_path(int64_t param_id) const;

private:
  ParamCache param_cache_;
  CompositionCache composition_cache_;
  StateDocument state_doc_;
  ObserverRegistry observers_;

  SendCallback send_cb_;
  std::unordered_map<int64_t, std::string> param_paths_;
};

} // namespace bridge
