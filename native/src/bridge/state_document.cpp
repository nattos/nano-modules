#include "bridge/state_document.h"

#include <algorithm>
#include <functional>

using json = nlohmann::json;

namespace bridge {

StateDocument::StateDocument() {
  doc_ = {
    {"global", {{"plugins", json::array()}}},
    {"plugins", json::object()},
    {"sketches", json::object()},
    {"sketch_state", json::object()},
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

json StateDocument::build_initial_state(const json& fields) {
  json out = json::object();
  if (!fields.is_object()) return out;
  for (auto& [name, def] : fields.items()) {
    if (!def.is_object()) continue;
    std::string type = def.value("type", "");
    if (type == "float")        out[name] = def.value("default", 0.0);
    else if (type == "int")     out[name] = def.value("default", 0);
    else if (type == "bool")    out[name] = def.value("default", false);
    else if (type == "string")  out[name] = def.value("default", "");
    else if (type == "texture") out[name] = 0;
    else if (type == "event")   out[name] = 0.0;
    else if (type == "object") {
      out[name] = build_initial_state(def.value("fields", json::object()));
    } else if (type == "array") {
      if (def.value("gpu", false)) {
        // GPU arrays hold only an integer handle; 0 = unassigned.
        out[name] = 0;
      } else {
        out[name] = def.value("default", json::array());
      }
    }
  }
  return out;
}

void StateDocument::collect_legacy_params(const json& fields, json& params_out) {
  // Legacy params are only derived from top-level scalar leaves.
  if (!fields.is_object()) return;

  struct FieldEntry { std::string name; json def; int order; };
  std::vector<FieldEntry> sorted_fields;
  for (auto& [name, def] : fields.items()) {
    if (!def.is_object()) continue;
    int order = def.value("order", 1000);
    sorted_fields.push_back({name, def, order});
  }
  std::sort(sorted_fields.begin(), sorted_fields.end(), [](const FieldEntry& a, const FieldEntry& b) {
    if (a.order != b.order) return a.order < b.order;
    return a.name < b.name;
  });

  int param_index = 0;
  for (auto& f : sorted_fields) {
    std::string type = f.def.value("type", "");
    int io_flags = f.def.value("io", 0);
    // Skip non-scalar types (textures, objects, arrays — including GPU arrays).
    if (type == "texture" || type == "object" || type == "array") continue;

    int param_type = 10;
    if (type == "bool") param_type = 0;
    else if (type == "event") param_type = 1;
    else if (type == "int") param_type = 13;
    else if (type == "string") param_type = 100;

    json p = {
      {"index", param_index},
      {"name", f.name},
      {"type", param_type},
      {"default", f.def.value("default", 0.0)},
      {"min", f.def.value("min", 0.0)},
      {"max", f.def.value("max", 1.0)},
      {"io", io_flags},
    };
    params_out.push_back(p);
    param_index++;
  }
}

json StateDocument::strip_gpu_fields(const json& state, const json& schema_fields) const {
  if (!schema_fields.is_object() || !state.is_object()) return state;
  json out = state;
  for (auto& [name, def] : schema_fields.items()) {
    if (!def.is_object() || !out.contains(name)) continue;
    std::string type = def.value("type", "");
    if (type == "array" && def.value("gpu", false)) {
      // Serialize GPU arrays as 0 (unassigned); real handles only live in-process.
      out[name] = 0;
    } else if (type == "object") {
      out[name] = strip_gpu_fields(out[name], def.value("fields", json::object()));
    }
  }
  return out;
}

std::string StateDocument::register_plugin_with_schema(const PluginMetadata& meta, const std::string& schema_json) {
  platform::LockGuard<platform::Mutex> lock(mutex_);

  int instance = next_instance_[meta.id]++;
  std::string key = meta.id + "@" + std::to_string(instance);

  // Parse the schema
  auto schema = json::parse(schema_json, nullptr, false);
  if (schema.is_discarded()) schema = json::object();
  json fields = schema.contains("fields") && schema["fields"].is_object()
                  ? schema["fields"]
                  : json::object();

  // Remember the schema so we can strip GPU leaves during serialization.
  plugin_schemas_[key] = fields;

  // Build initial state recursively from schema defaults.
  json initial_state = build_initial_state(fields);

  // Add to global plugin listing with schema
  json entry = {
    {"key", key},
    {"metadata", {
      {"id", meta.id},
      {"version", {{"major", meta.major}, {"minor", meta.minor}, {"patch", meta.patch}}},
    }},
    {"schema", fields},
    {"params", json::array()},
  };

  // Derive legacy params array from top-level scalar fields.
  collect_legacy_params(fields, entry["params"]);

  doc_["global"]["plugins"].push_back(entry);
  emit("add", "/global/plugins/-", entry);

  // Create plugin instance state with defaults from schema
  doc_["plugins"][key] = {
    {"console", json::array()},
    {"state", initial_state},
  };
  emit("add", "/plugins/" + key, doc_["plugins"][key]);

  return key;
}

void StateDocument::declare_param(const std::string& plugin_key, const ParamDecl& param) {
  platform::LockGuard<platform::Mutex> lock(mutex_);

  // Determine min/max from type
  float min_val = 0.0f, max_val = 1.0f;
  switch (param.type) {
    case PARAM_INTEGER: min_val = 0; max_val = 100; break;
    default: min_val = 0; max_val = 1; break;
  }

  // Find the plugin in the global listing
  auto& plugins = doc_["global"]["plugins"];
  for (size_t i = 0; i < plugins.size(); i++) {
    if (plugins[i]["key"] == plugin_key) {
      json p = {
        {"index", param.index},
        {"name", param.name},
        {"type", param.type},
        {"default", param.default_value},
        {"min", min_val},
        {"max", max_val},
      };
      plugins[i]["params"].push_back(p);
      emit("add", "/global/plugins/" + std::to_string(i) + "/params/-", p);

      // Also initialize the default value in instance state
      std::string state_path = "/plugins/" + plugin_key + "/state";
      auto* state = json_patch::resolve_pointer(doc_, state_path);
      if (state) {
        std::string param_key = std::to_string(param.index);
        if (!state->contains("params")) {
          (*state)["params"] = json::object();
          emit("add", state_path + "/params", json::object());
        }
        (*state)["params"][param_key] = param.default_value;
        emit("add", state_path + "/params/" + param_key, param.default_value);
      }
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

  plugin_schemas_.erase(key);
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
  auto schema_it = plugin_schemas_.find(key);
  if (schema_it == plugin_schemas_.end()) return *state;
  return strip_gpu_fields(*state, schema_it->second);
}

void StateDocument::set_plugin_state(const std::string& key, const json& state) {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  std::string path = "/plugins/" + key + "/state";
  auto* target = json_patch::resolve_pointer(doc_, path);
  if (!target) return;

  // Strip GPU-array leaves from both sides before diffing, so that
  // transient handle changes don't produce spurious patches.
  auto schema_it = plugin_schemas_.find(key);
  json before = schema_it != plugin_schemas_.end()
                  ? strip_gpu_fields(*target, schema_it->second)
                  : *target;
  json after  = schema_it != plugin_schemas_.end()
                  ? strip_gpu_fields(state, schema_it->second)
                  : state;

  auto ops = json_patch::diff(before, after);
  for (auto& op : ops) {
    op.path = path + op.path;
    pending_.push_back(op);
  }

  // Commit: preserve GPU handles currently live in the document so a
  // client-driven "replace state" doesn't wipe them.
  if (schema_it != plugin_schemas_.end()) {
    json merged = state;
    // Copy GPU handles from *target into merged at the same paths.
    std::function<void(json&, const json&, const json&)> restore_gpu =
      [&](json& dst, const json& src, const json& fields) {
        if (!fields.is_object() || !src.is_object() || !dst.is_object()) return;
        for (auto& [name, def] : fields.items()) {
          if (!def.is_object()) continue;
          std::string type = def.value("type", "");
          if (type == "array" && def.value("gpu", false)) {
            if (src.contains(name)) dst[name] = src[name];
          } else if (type == "object" && src.contains(name) && dst.contains(name)) {
            restore_gpu(dst[name], src[name], def.value("fields", json::object()));
          }
        }
      };
    restore_gpu(merged, *target, schema_it->second);
    *target = merged;
  } else {
    *target = state;
  }
}

void StateDocument::mark_dirty(const std::string& path) {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  // "dirty" is a no-op with respect to the document, but observers receive
  // it in the patch stream and can do lazy work.
  emit("dirty", path, json::object());
}

void StateDocument::set_gpu_buffer(const std::string& path, int handle) {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  auto* target = json_patch::resolve_pointer(doc_, path);
  if (!target) {
    // Path doesn't exist yet — create it as a scalar.
    json_patch::PatchOp add_op;
    add_op.op = "add";
    add_op.path = path;
    add_op.value = handle;
    json_patch::apply_op(doc_, add_op);
    // Emit only a dirty notification — we don't want the scalar value
    // to be observed as a meaningful state transition.
    emit("dirty", path, json::object());
    return;
  }
  bool changed = !target->is_number_integer() || target->get<int>() != handle;
  *target = handle;
  if (changed) {
    // Handle genuinely changed (buffer reallocated): emit as dirty too —
    // readers should re-resolve, but not interpret this as a value-change
    // in user space.
    emit("dirty", path, json::object());
  }
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

void StateDocument::set_at(const std::string& path, const json& value) {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  if (path.empty() || path == "/") {
    // Can't replace root
    return;
  }

  // Find or create the parent path
  auto* target = json_patch::resolve_pointer(doc_, path);
  if (target) {
    // Path exists — diff and emit patches
    auto ops = json_patch::diff(*target, value);
    for (auto& op : ops) {
      op.path = path + op.path;
      pending_.push_back(op);
    }
    *target = value;
  } else {
    // Path doesn't exist — create via add
    // Split into parent + key
    auto last_slash = path.rfind('/');
    if (last_slash == std::string::npos) return;
    std::string parent_path = path.substr(0, last_slash);
    std::string key = path.substr(last_slash + 1);

    // Ensure parent exists (create as objects)
    auto* parent = json_patch::resolve_pointer(doc_, parent_path);
    if (!parent) {
      // Create parent chain — walk from root
      auto tokens = parent_path;
      // Simple: set the entire path with a single add
      // This works because json_patch::apply_op handles nested creation
      json_patch::PatchOp add_op;
      add_op.op = "add";
      add_op.path = path;
      add_op.value = value;
      json_patch::apply_op(doc_, add_op);
      pending_.push_back(add_op);
      return;
    }

    (*parent)[key] = value;
    emit("add", path, value);
  }
}

std::vector<json_patch::PatchOp> StateDocument::drain_patches() {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  std::vector<json_patch::PatchOp> result;
  result.swap(pending_);
  return result;
}

} // namespace bridge
