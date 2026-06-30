#pragma once

#include <functional>
#include <mutex>
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
  /// Fired right after a client patch has been applied to a plugin's
  /// state. Lets a host (e.g., an FFGL plugin) react to editor-driven
  /// state mutations — typically by marking the persisted config blob
  /// as dirty and regenerating it on a debounce timer.
  using ClientPatchCallback = std::function<void(const std::string& plugin_key)>;

  BridgeCore();

  ParamCache& param_cache() { return param_cache_; }
  CompositionCache& composition_cache() { return composition_cache_; }
  StateDocument& state_document() { return state_doc_; }
  ObserverRegistry& observers() { return observers_; }

  /// Set the callback used to send messages to clients.
  void set_send_callback(SendCallback cb) { send_cb_ = std::move(cb); }
  /// Set a hook invoked after a client patch is applied to plugin state.
  /// This is the single global hook (kept for back-compat with the looper).
  void set_client_patch_callback(ClientPatchCallback cb) { client_patch_cb_ = std::move(cb); }

  /// Register a per-key patch listener. When a client patch is applied to
  /// `/plugins/<key>/state`, the listener registered for that exact key (if
  /// any) is invoked in addition to the global hook. This is how multiple
  /// plugin instances multiplexed onto one BridgeCore each receive only
  /// their own editor-driven mutations.
  ///
  /// Thread-safety: the listener is invoked while the listener-registry
  /// mutex is held, and unregister_patch_listener also takes that mutex —
  /// so unregister cannot return while a listener is mid-flight. This
  /// closes the use-after-free window when an instance is torn down
  /// concurrently with an incoming patch. Listeners must therefore be
  /// cheap and non-reentrant (the barrel only flips atomics).
  void register_patch_listener(const std::string& key, ClientPatchCallback cb);
  void unregister_patch_listener(const std::string& key);

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
  ClientPatchCallback client_patch_cb_;
  std::unordered_map<int64_t, std::string> param_paths_;

  mutable std::mutex listeners_mu_;
  std::unordered_map<std::string, ClientPatchCallback> patch_listeners_;
};

} // namespace bridge
