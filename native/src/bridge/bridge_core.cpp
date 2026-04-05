#include "bridge/bridge_core.h"
#include "json/json_patch.h"

#include <nlohmann/json.hpp>

namespace bridge {

BridgeCore::BridgeCore() = default;

void BridgeCore::handle_message(int client_id, const std::string& msg) {
  auto j = nlohmann::json::parse(msg, nullptr, false);
  if (j.is_discarded()) return;

  if (!j.contains("action") || !j["action"].is_string()) return;
  std::string action = j["action"].get<std::string>();

  if (action == "observe") {
    if (!j.contains("path") || !j["path"].is_string()) return;
    observers_.observe(client_id, j["path"].get<std::string>());
  }
  else if (action == "unobserve") {
    if (!j.contains("path") || !j["path"].is_string()) return;
    observers_.unobserve(client_id, j["path"].get<std::string>());
  }
  else if (action == "get") {
    std::string path = j.contains("path") ? j["path"].get<std::string>() : "";
    nlohmann::json data = state_doc_.get_at(path);
    auto response = nlohmann::json{
      {"type", "snapshot"},
      {"path", path},
      {"data", data},
    };
    if (send_cb_) send_cb_(client_id, response.dump());
  }
  else if (action == "patch") {
    if (!j.contains("target") || !j.contains("ops")) return;
    std::string target = j["target"].get<std::string>();
    auto ops = json_patch::parse_patch(j["ops"]);

    // Target must be like "/plugins/<key>/state"
    if (target.find("/plugins/") != 0) return;
    auto slash1 = target.find('/', 9);
    if (slash1 == std::string::npos) return;
    std::string plugin_key = target.substr(9, slash1 - 9);
    std::string suffix = target.substr(slash1);
    if (suffix != "/state") return;

    state_doc_.apply_client_patch(plugin_key, ops);
  }
}

void BridgeCore::remove_client(int client_id) {
  observers_.remove_client(client_id);
}

void BridgeCore::broadcast_state_patches() {
  auto patches = state_doc_.drain_patches();
  if (patches.empty() || !send_cb_) return;

  auto filtered = observers_.filter_patches(patches);
  for (auto& [client_id, client_patches] : filtered) {
    auto msg = nlohmann::json{
      {"type", "patch"},
      {"ops", json_patch::serialize_patch(client_patches)},
    };
    send_cb_(client_id, msg.dump());
  }
}

void BridgeCore::tick() {
  broadcast_state_patches();
}

void BridgeCore::set_param_path(int64_t param_id, const std::string& path) {
  param_paths_[param_id] = path;
}

std::string BridgeCore::get_param_path(int64_t param_id) const {
  auto it = param_paths_.find(param_id);
  return it != param_paths_.end() ? it->second : "";
}

} // namespace bridge
