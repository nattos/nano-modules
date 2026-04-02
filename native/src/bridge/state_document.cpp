#include "bridge/state_document.h"

using json = nlohmann::json;

namespace bridge {

StateDocument::StateDocument() {
  doc_ = {
    {"global", {{"plugins", json::array()}}},
    {"plugins", json::object()},
  };
}

void StateDocument::emit(const std::string& op, const std::string& path,
                          const json& value) {
  json_patch::PatchOp p;
  p.op = op;
  p.path = path;
  p.value = value;
  pending_.push_back(std::move(p));
}

std::string StateDocument::register_plugin(int32_t module_id, const PluginMetadata& meta) {
  std::lock_guard lock(mutex_);

  std::string key = "module_" + std::to_string(module_id);

  // Add to global plugin listing
  json entry = {
    {"key", key},
    {"metadata", {
      {"id", meta.id},
      {"version", {{"major", meta.major}, {"minor", meta.minor}, {"patch", meta.patch}}},
    }},
  };
  doc_["global"]["plugins"].push_back(entry);
  emit("add", "/global/plugins/-", entry);

  // Create plugin instance state
  doc_["plugins"][key] = {
    {"console", json::array()},
    {"state", json::object()},
  };
  emit("add", "/plugins/" + key, doc_["plugins"][key]);

  return key;
}

void StateDocument::unregister_plugin(const std::string& key) {
  std::lock_guard lock(mutex_);

  // Remove from global listing
  auto& plugins = doc_["global"]["plugins"];
  for (size_t i = 0; i < plugins.size(); i++) {
    if (plugins[i]["key"] == key) {
      plugins.erase(i);
      emit("remove", "/global/plugins/" + std::to_string(i));
      break;
    }
  }

  // Remove plugin instance
  if (doc_["plugins"].contains(key)) {
    doc_["plugins"].erase(key);
    emit("remove", "/plugins/" + key);
  }
}

void StateDocument::log(const std::string& plugin_key, const ConsoleEntry& entry) {
  std::lock_guard lock(mutex_);

  auto* plugin = json_patch::resolve_pointer(doc_, "/plugins/" + plugin_key);
  if (!plugin || !plugin->contains("console")) return;

  auto& console = (*plugin)["console"];

  json log_entry = {
    {"ts", entry.timestamp},
    {"level", entry.level},
    {"data", entry.data},
  };

  console.push_back(log_entry);
  emit("add", "/plugins/" + plugin_key + "/console/-", log_entry);

  // Cap at MAX_CONSOLE_ENTRIES
  while (console.size() > MAX_CONSOLE_ENTRIES) {
    console.erase(0);
    emit("remove", "/plugins/" + plugin_key + "/console/0");
  }
}

json StateDocument::get_plugin_state(const std::string& key) const {
  std::lock_guard lock(mutex_);
  auto* state = json_patch::resolve_pointer(doc_, "/plugins/" + key + "/state");
  if (!state) return json::object();
  return *state;
}

void StateDocument::set_plugin_state(const std::string& key, const json& state) {
  std::lock_guard lock(mutex_);
  std::string path = "/plugins/" + key + "/state";
  auto* target = json_patch::resolve_pointer(doc_, path);
  if (!target) return;

  // Diff the old and new state to produce fine-grained patches
  auto ops = json_patch::diff(*target, state);
  for (auto& op : ops) {
    op.path = path + op.path;
    pending_.push_back(op);
  }

  *target = state;
}

std::vector<json_patch::PatchOp> StateDocument::apply_client_patch(
    const std::string& plugin_key,
    const std::vector<json_patch::PatchOp>& ops) {
  std::lock_guard lock(mutex_);

  std::string state_path = "/plugins/" + plugin_key + "/state";
  auto* state = json_patch::resolve_pointer(doc_, state_path);
  if (!state) return {};

  std::vector<json_patch::PatchOp> effective;
  for (const auto& op : ops) {
    json_patch::PatchOp full_op = op;
    // Apply patch relative to the plugin's state subtree
    if (json_patch::apply_op(*state, op)) {
      // Record with full path for redistribution
      full_op.path = state_path + op.path;
      effective.push_back(full_op);
      pending_.push_back(full_op);
    }
  }

  return effective;
}

json StateDocument::document() const {
  std::lock_guard lock(mutex_);
  return doc_;
}

json StateDocument::get_at(const std::string& path) const {
  std::lock_guard lock(mutex_);
  const auto* val = json_patch::resolve_pointer(doc_, path);
  return val ? *val : json();
}

std::vector<json_patch::PatchOp> StateDocument::drain_patches() {
  std::lock_guard lock(mutex_);
  std::vector<json_patch::PatchOp> result;
  result.swap(pending_);
  return result;
}

} // namespace bridge
