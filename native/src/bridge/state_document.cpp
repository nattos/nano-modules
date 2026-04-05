#include "bridge/state_document.h"

using json = nlohmann::json;

namespace bridge {

StateDocument::StateDocument() {
  doc_ = {
    {"global", {{"plugins", json::array()}}},
    {"plugins", json::object()},
    {"sketches", json::object()},
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

std::string StateDocument::register_plugin(const PluginMetadata& meta) {
  platform::LockGuard<platform::Mutex> lock(mutex_);

  int instance = next_instance_[meta.id]++;
  std::string key = meta.id + "@" + std::to_string(instance);

  // Add to global plugin listing
  json entry = {
    {"key", key},
    {"metadata", {
      {"id", meta.id},
      {"version", {{"major", meta.major}, {"minor", meta.minor}, {"patch", meta.patch}}},
    }},
    {"params", json::array()},
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

void StateDocument::declare_param(const std::string& plugin_key, const ParamDecl& param) {
  platform::LockGuard<platform::Mutex> lock(mutex_);

  // Find the plugin in the global listing
  auto& plugins = doc_["global"]["plugins"];
  for (size_t i = 0; i < plugins.size(); i++) {
    if (plugins[i]["key"] == plugin_key) {
      json p = {
        {"index", param.index},
        {"name", param.name},
        {"type", param.type},
        {"default", param.default_value},
      };
      plugins[i]["params"].push_back(p);
      emit("add", "/global/plugins/" + std::to_string(i) + "/params/-", p);
      return;
    }
  }
}

void StateDocument::declare_io(const std::string& plugin_key, const IODecl& io) {
  platform::LockGuard<platform::Mutex> lock(mutex_);

  auto& plugins = doc_["global"]["plugins"];
  for (size_t i = 0; i < plugins.size(); i++) {
    if (plugins[i]["key"] == plugin_key) {
      if (!plugins[i].contains("io")) {
        plugins[i]["io"] = json::array();
        emit("add", "/global/plugins/" + std::to_string(i) + "/io", json::array());
      }
      json decl = {
        {"index", io.index},
        {"name", io.name},
        {"kind", io.kind},
        {"role", io.role},
      };
      plugins[i]["io"].push_back(decl);
      emit("add", "/global/plugins/" + std::to_string(i) + "/io/-", decl);
      return;
    }
  }
}

void StateDocument::unregister_plugin(const std::string& key) {
  platform::LockGuard<platform::Mutex> lock(mutex_);

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
  platform::LockGuard<platform::Mutex> lock(mutex_);

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
  platform::LockGuard<platform::Mutex> lock(mutex_);
  auto* state = json_patch::resolve_pointer(doc_, "/plugins/" + key + "/state");
  if (!state) return json::object();
  return *state;
}

void StateDocument::set_plugin_state(const std::string& key, const json& state) {
  platform::LockGuard<platform::Mutex> lock(mutex_);
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
  platform::LockGuard<platform::Mutex> lock(mutex_);

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
  platform::LockGuard<platform::Mutex> lock(mutex_);
  return doc_;
}

json StateDocument::get_at(const std::string& path) const {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  // Treat "/" as root (same as "")
  std::string resolved = (path == "/") ? "" : path;
  const auto* val = json_patch::resolve_pointer(doc_, resolved);
  return val ? *val : json();
}

std::vector<json_patch::PatchOp> StateDocument::drain_patches() {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  std::vector<json_patch::PatchOp> result;
  result.swap(pending_);
  return result;
}

} // namespace bridge
