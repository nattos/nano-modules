#include "bridge/bridge_core_api.h"
#include "bridge/bridge_core.h"

#include <algorithm>
#include <cstring>
#include <deque>
#include <string>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

using namespace bridge;

static const char* LEVELS[] = {"log", "warn", "error"};

/// Internal wrapper that owns a BridgeCore and manages virtual clients
/// with outgoing message queues.
struct BridgeCoreInstance {
  BridgeCore core;
  int next_client_id = 1;
  std::unordered_map<int, std::deque<std::string>> outbox;

  // Val handle store (shared across all plugins using this bridge core)
  std::unordered_map<int32_t, nlohmann::json> val_handles;
  int32_t next_val_handle = 1;

  int32_t alloc_val(nlohmann::json v) {
    int32_t h = next_val_handle++;
    val_handles[h] = std::move(v);
    return h;
  }
  nlohmann::json* get_val(int32_t h) {
    auto it = val_handles.find(h);
    return it != val_handles.end() ? &it->second : nullptr;
  }
  void release_val(int32_t h) { val_handles.erase(h); }

  BridgeCoreInstance() {
    core.set_send_callback([this](int client_id, const std::string& msg) {
      outbox[client_id].push_back(msg);
    });
  }
};

static BridgeCoreInstance* as(BridgeCoreHandle h) {
  return static_cast<BridgeCoreInstance*>(h);
}

static int write_to_buf(const std::string& src, char* buf, int buf_len) {
  int len = std::min(static_cast<int>(src.size()), buf_len);
  if (len > 0) std::memcpy(buf, src.data(), len);
  return len;
}

// --- Lifecycle ---

BridgeCoreHandle bridge_core_create(void) {
  return new BridgeCoreInstance();
}

void bridge_core_destroy(BridgeCoreHandle h) {
  delete as(h);
}

// --- Tick ---

void bridge_core_tick(BridgeCoreHandle h) {
  as(h)->core.tick();
}

// --- Client management ---

int bridge_core_connect_client(BridgeCoreHandle h) {
  auto* inst = as(h);
  int id = inst->next_client_id++;
  inst->outbox[id]; // create empty queue
  return id;
}

void bridge_core_disconnect_client(BridgeCoreHandle h, int client_id) {
  auto* inst = as(h);
  inst->core.remove_client(client_id);
  inst->outbox.erase(client_id);
}

// --- Loopback transport ---

void bridge_core_receive_message(BridgeCoreHandle h, int client_id,
                                  const char* msg, int msg_len) {
  as(h)->core.handle_message(client_id, std::string(msg, msg_len));
}

int bridge_core_poll_outgoing(BridgeCoreHandle h, int client_id,
                               char* buf, int buf_len) {
  auto* inst = as(h);
  auto it = inst->outbox.find(client_id);
  if (it == inst->outbox.end() || it->second.empty()) return 0;

  auto& msg = it->second.front();
  int len = write_to_buf(msg, buf, buf_len);
  it->second.pop_front();
  return len;
}

// --- Plugin registration ---

int bridge_core_register_plugin(BridgeCoreHandle h,
                                 const char* id, int id_len,
                                 int ver_major, int ver_minor, int ver_patch,
                                 char* key_buf, int key_buf_len) {
  PluginMetadata meta;
  meta.id = std::string(id, id_len);
  meta.major = ver_major;
  meta.minor = ver_minor;
  meta.patch = ver_patch;

  std::string key = as(h)->core.state_document().register_plugin(meta);
  return write_to_buf(key, key_buf, key_buf_len);
}

int bridge_core_register_with_schema(BridgeCoreHandle h,
                                      const char* id, int id_len,
                                      int ver_major, int ver_minor, int ver_patch,
                                      const char* schema_json, int schema_json_len,
                                      char* key_buf, int key_buf_len) {
  PluginMetadata meta;
  meta.id = std::string(id, id_len);
  meta.major = ver_major;
  meta.minor = ver_minor;
  meta.patch = ver_patch;

  std::string key = as(h)->core.state_document().register_plugin_with_schema(
      meta, std::string(schema_json, schema_json_len));
  return write_to_buf(key, key_buf, key_buf_len);
}

void bridge_core_declare_param(BridgeCoreHandle h,
                                const char* plugin_key, int plugin_key_len,
                                int index,
                                const char* name, int name_len,
                                int type, float default_value) {
  ParamDecl param;
  param.index = index;
  param.name = std::string(name, name_len);
  param.type = static_cast<ParamType>(type);
  param.default_value = default_value;

  as(h)->core.state_document().declare_param(
      std::string(plugin_key, plugin_key_len), param);
}

void bridge_core_log(BridgeCoreHandle h,
                      const char* plugin_key, int plugin_key_len,
                      double timestamp, int level,
                      const char* msg, int msg_len) {
  ConsoleEntry entry;
  entry.timestamp = timestamp;
  entry.level = (level >= 0 && level < 3) ? LEVELS[level] : "log";
  entry.data = std::string(msg, msg_len);

  as(h)->core.state_document().log(
      std::string(plugin_key, plugin_key_len), entry);
}

void bridge_core_log_structured(BridgeCoreHandle h,
                                 const char* plugin_key, int plugin_key_len,
                                 double timestamp, int level,
                                 const char* msg, int msg_len,
                                 const char* json_data, int json_len) {
  ConsoleEntry entry;
  entry.timestamp = timestamp;
  entry.level = (level >= 0 && level < 3) ? LEVELS[level] : "log";
  auto parsed = nlohmann::json::parse(std::string(json_data, json_len), nullptr, false);
  if (!parsed.is_discarded()) {
    entry.data = nlohmann::json{
      {"message", std::string(msg, msg_len)},
      {"data", parsed},
    };
  } else {
    entry.data = std::string(msg, msg_len);
  }

  as(h)->core.state_document().log(
      std::string(plugin_key, plugin_key_len), entry);
}

// --- Plugin state ---

void bridge_core_set_plugin_state(BridgeCoreHandle h,
                                   const char* plugin_key, int plugin_key_len,
                                   const char* json_state, int json_len) {
  auto state = nlohmann::json::parse(std::string(json_state, json_len), nullptr, false);
  if (!state.is_discarded()) {
    as(h)->core.state_document().set_plugin_state(
        std::string(plugin_key, plugin_key_len), state);
  }
}

int bridge_core_get_plugin_state(BridgeCoreHandle h,
                                  const char* plugin_key, int plugin_key_len,
                                  char* buf, int buf_len) {
  auto state = as(h)->core.state_document().get_plugin_state(
      std::string(plugin_key, plugin_key_len));
  std::string json = state.dump();
  return write_to_buf(json, buf, buf_len);
}

void bridge_core_apply_client_patch(BridgeCoreHandle h,
                                     const char* plugin_key, int plugin_key_len,
                                     const char* patch_json, int patch_len) {
  auto j = nlohmann::json::parse(std::string(patch_json, patch_len), nullptr, false);
  if (!j.is_discarded()) {
    auto ops = json_patch::parse_patch(j);
    as(h)->core.state_document().apply_client_patch(
        std::string(plugin_key, plugin_key_len), ops);
  }
}

// --- I/O port declarations ---

void bridge_core_declare_io(BridgeCoreHandle h,
                             const char* plugin_key, int plugin_key_len,
                             int index,
                             const char* name, int name_len,
                             int kind, int role) {
  bridge::IODecl decl;
  decl.index = index;
  decl.name = std::string(name, name_len);
  decl.kind = static_cast<bridge::IOKind>(kind);
  decl.role = static_cast<bridge::IORole>(role);

  as(h)->core.state_document().declare_io(
      std::string(plugin_key, plugin_key_len), decl);
}

// --- Resolume param cache ---

double bridge_core_get_param(BridgeCoreHandle h, int64_t param_id) {
  return as(h)->core.param_cache().get(param_id);
}

void bridge_core_set_param(BridgeCoreHandle h, int64_t param_id, double value) {
  as(h)->core.param_cache().set(param_id, value);
}

void bridge_core_queue_param_write(BridgeCoreHandle h, int64_t param_id, double value) {
  as(h)->core.param_cache().queue_write(param_id, value);
}

// --- Param path registry ---

void bridge_core_set_param_path(BridgeCoreHandle h, int64_t param_id,
                                 const char* path, int path_len) {
  as(h)->core.set_param_path(param_id, std::string(path, path_len));
}

int bridge_core_get_param_path(BridgeCoreHandle h, int64_t param_id,
                                char* buf, int buf_len) {
  std::string path = as(h)->core.get_param_path(param_id);
  return write_to_buf(path, buf, buf_len);
}

// --- State document queries ---

void bridge_core_set_at(BridgeCoreHandle h,
                         const char* path, int path_len,
                         const char* json_value, int json_len) {
  auto value = nlohmann::json::parse(std::string(json_value, json_len), nullptr, false);
  if (!value.is_discarded()) {
    as(h)->core.state_document().set_at(std::string(path, path_len), value);
  }
}

int bridge_core_get_at(BridgeCoreHandle h,
                        const char* path, int path_len,
                        char* buf, int buf_len) {
  auto data = as(h)->core.state_document().get_at(std::string(path, path_len));
  if (data.is_null()) return 0;
  std::string json = data.dump();
  return write_to_buf(json, buf, buf_len);
}

int bridge_core_get_plugin_key(BridgeCoreHandle h,
                                const char* id, int id_len,
                                char* key_buf, int key_buf_len) {
  // Search the global plugin listing for the given ID
  std::string target_id(id, id_len);
  auto doc = as(h)->core.state_document().document();
  if (!doc.contains("global") || !doc["global"].contains("plugins")) return 0;

  for (auto& entry : doc["global"]["plugins"]) {
    if (entry.contains("metadata") && entry["metadata"].contains("id") &&
        entry["metadata"]["id"].get<std::string>() == target_id) {
      std::string key = entry["key"].get<std::string>();
      return write_to_buf(key, key_buf, key_buf_len);
    }
  }
  return 0;
}

// --- Val handle store ---

int bridge_core_val_null(BridgeCoreHandle h) {
  return as(h)->alloc_val(nullptr);
}

int bridge_core_val_bool(BridgeCoreHandle h, int v) {
  return as(h)->alloc_val(v != 0);
}

int bridge_core_val_number(BridgeCoreHandle h, double v) {
  return as(h)->alloc_val(v);
}

int bridge_core_val_string(BridgeCoreHandle h, const char* s, int len) {
  return as(h)->alloc_val(std::string(s, len));
}

int bridge_core_val_array(BridgeCoreHandle h) {
  return as(h)->alloc_val(nlohmann::json::array());
}

int bridge_core_val_object(BridgeCoreHandle h) {
  return as(h)->alloc_val(nlohmann::json::object());
}

int bridge_core_val_type_of(BridgeCoreHandle h, int val_h) {
  auto* v = as(h)->get_val(val_h);
  if (!v || v->is_null()) return 0;
  if (v->is_boolean()) return 1;
  if (v->is_number()) return 2;
  if (v->is_string()) return 3;
  if (v->is_array()) return 4;
  if (v->is_object()) return 5;
  return 0;
}

double bridge_core_val_as_number(BridgeCoreHandle h, int val_h) {
  auto* v = as(h)->get_val(val_h);
  return (v && v->is_number()) ? v->get<double>() : 0.0;
}

int bridge_core_val_as_bool(BridgeCoreHandle h, int val_h) {
  auto* v = as(h)->get_val(val_h);
  if (!v) return 0;
  if (v->is_boolean()) return v->get<bool>() ? 1 : 0;
  if (v->is_number()) return v->get<double>() != 0.0 ? 1 : 0;
  return 0;
}

int bridge_core_val_as_string(BridgeCoreHandle h, int val_h, char* buf, int buf_len) {
  auto* v = as(h)->get_val(val_h);
  if (!v || !v->is_string()) return 0;
  return write_to_buf(v->get<std::string>(), buf, buf_len);
}

int bridge_core_val_get(BridgeCoreHandle h, int obj_h, const char* key, int key_len) {
  auto* obj = as(h)->get_val(obj_h);
  if (!obj || !obj->is_object()) return 0;
  std::string k(key, key_len);
  if (!obj->contains(k)) return 0;
  return as(h)->alloc_val((*obj)[k]);
}

void bridge_core_val_set(BridgeCoreHandle h, int obj_h, const char* key, int key_len, int val_h) {
  auto* obj = as(h)->get_val(obj_h);
  auto* val = as(h)->get_val(val_h);
  if (!obj || !obj->is_object() || !val) return;
  (*obj)[std::string(key, key_len)] = *val;
}

int bridge_core_val_keys_count(BridgeCoreHandle h, int obj_h) {
  auto* v = as(h)->get_val(obj_h);
  return (v && v->is_object()) ? static_cast<int>(v->size()) : 0;
}

int bridge_core_val_key_at(BridgeCoreHandle h, int obj_h, int index, char* buf, int buf_len) {
  auto* v = as(h)->get_val(obj_h);
  if (!v || !v->is_object() || index < 0 || index >= static_cast<int>(v->size())) return 0;
  auto it = v->begin();
  std::advance(it, index);
  return write_to_buf(it.key(), buf, buf_len);
}

int bridge_core_val_get_index(BridgeCoreHandle h, int arr_h, int index) {
  auto* arr = as(h)->get_val(arr_h);
  if (!arr || !arr->is_array() || index < 0 || index >= static_cast<int>(arr->size())) return 0;
  return as(h)->alloc_val((*arr)[index]);
}

void bridge_core_val_push(BridgeCoreHandle h, int arr_h, int val_h) {
  auto* arr = as(h)->get_val(arr_h);
  auto* val = as(h)->get_val(val_h);
  if (!arr || !arr->is_array() || !val) return;
  arr->push_back(*val);
}

int bridge_core_val_length(BridgeCoreHandle h, int arr_h) {
  auto* v = as(h)->get_val(arr_h);
  return (v && v->is_array()) ? static_cast<int>(v->size()) : 0;
}

void bridge_core_val_release(BridgeCoreHandle h, int val_h) {
  as(h)->release_val(val_h);
}

int bridge_core_val_to_json(BridgeCoreHandle h, int val_h, char* buf, int buf_len) {
  auto* v = as(h)->get_val(val_h);
  if (!v) return 0;
  std::string json = v->dump();
  return write_to_buf(json, buf, buf_len);
}

// --- Direct state commit ---

void bridge_core_commit_val(BridgeCoreHandle h,
                             const char* plugin_key, int plugin_key_len,
                             const char* path, int path_len,
                             int val_h) {
  auto* inst = as(h);
  auto* val = inst->get_val(val_h);
  if (!val) return;

  std::string key(plugin_key, plugin_key_len);

  if (path_len == 0) {
    // Replace entire plugin state
    inst->core.state_document().set_plugin_state(key, *val);
  } else {
    // Set a field within plugin state
    std::string p(path, path_len);
    auto state = inst->core.state_document().get_plugin_state(key);
    // Navigate path (split on '/') and set the value
    auto* target = &state;
    std::string token;
    size_t start = 0;
    while (start < p.size()) {
      auto pos = p.find('/', start);
      if (pos == std::string::npos) {
        token = p.substr(start);
        start = p.size();
      } else {
        token = p.substr(start, pos - start);
        start = pos + 1;
      }
      if (token.empty()) continue;
      // Navigate into the object, creating intermediates as needed
      if (!target->is_object()) *target = nlohmann::json::object();
      target = &(*target)[token];
    }
    *target = *val;
    inst->core.state_document().set_plugin_state(key, state);
  }
}
