#include "bridge/observer_registry.h"

namespace bridge {

void ObserverRegistry::observe(ClientId client, const std::string& path) {
  subscriptions_[client].insert(path);
}

void ObserverRegistry::unobserve(ClientId client, const std::string& path) {
  auto it = subscriptions_.find(client);
  if (it != subscriptions_.end()) {
    it->second.erase(path);
    if (it->second.empty()) subscriptions_.erase(it);
  }
}

void ObserverRegistry::remove_client(ClientId client) {
  subscriptions_.erase(client);
}

bool ObserverRegistry::is_observing(ClientId client, const std::string& path) const {
  auto it = subscriptions_.find(client);
  if (it == subscriptions_.end()) return false;
  return it->second.count(path) > 0;
}

std::unordered_set<std::string> ObserverRegistry::client_paths(ClientId client) const {
  auto it = subscriptions_.find(client);
  if (it == subscriptions_.end()) return {};
  return it->second;
}

// A patch at path P is relevant to a subscription at path S if:
// - P starts with S (the patch is at or under the observed path), OR
// - S starts with P (the patch replaces a parent of the observed path)
static bool path_matches(const std::string& patch_path, const std::string& sub_path) {
  // Exact match
  if (patch_path == sub_path) return true;

  // Patch is a child of subscription: "/a/b/c" starts with "/a/b"
  if (patch_path.size() > sub_path.size() &&
      patch_path.compare(0, sub_path.size(), sub_path) == 0 &&
      (sub_path.empty() || patch_path[sub_path.size()] == '/')) {
    return true;
  }

  // Patch is a parent of subscription: "/a" affects "/a/b/c"
  if (sub_path.size() > patch_path.size() &&
      sub_path.compare(0, patch_path.size(), patch_path) == 0 &&
      (patch_path.empty() || sub_path[patch_path.size()] == '/')) {
    return true;
  }

  return false;
}

std::unordered_map<ClientId, std::vector<json_patch::PatchOp>>
ObserverRegistry::filter_patches(const std::vector<json_patch::PatchOp>& patches) const {
  std::unordered_map<ClientId, std::vector<json_patch::PatchOp>> result;

  for (const auto& [client, paths] : subscriptions_) {
    for (const auto& patch : patches) {
      for (const auto& sub_path : paths) {
        if (path_matches(patch.path, sub_path)) {
          result[client].push_back(patch);
          break; // don't duplicate if multiple subscriptions match
        }
      }
    }
  }

  return result;
}

} // namespace bridge
