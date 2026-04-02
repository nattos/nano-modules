#pragma once

#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "json/json_patch.h"

namespace bridge {

using ClientId = int;

/// Manages per-client path subscriptions for state change notifications.
/// A client observing a path receives patches for that path and all child paths.
class ObserverRegistry {
public:
  void observe(ClientId client, const std::string& path);
  void unobserve(ClientId client, const std::string& path);
  void remove_client(ClientId client);

  /// Given a list of patches, return which patches each observing client should receive.
  /// A client observing "/plugins/m0/state" receives patches whose path starts with
  /// "/plugins/m0/state" (exact match or child).
  std::unordered_map<ClientId, std::vector<json_patch::PatchOp>>
      filter_patches(const std::vector<json_patch::PatchOp>& patches) const;

  /// Check if a client is observing a specific path.
  bool is_observing(ClientId client, const std::string& path) const;

  /// Get all paths a client is observing.
  std::unordered_set<std::string> client_paths(ClientId client) const;

private:
  // client → set of observed paths
  std::unordered_map<ClientId, std::unordered_set<std::string>> subscriptions_;
};

} // namespace bridge
