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
