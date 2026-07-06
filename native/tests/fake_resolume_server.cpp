#include "fake_resolume_server.h"

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketServer.h>

#include "plugin/nano_barrel/barrel_codec.h"
#include "plugin/nano_barrel/channel_marker_codec.h"

namespace bridge {

using json = nlohmann::json;

namespace {

// Recursively collect every param-like node (object with a numeric "id" and a
// "value") into an id -> {value, valuetype, path} index, so subscribe-by-id can
// answer with the real value.
void collect_params(const json& node, const std::string& path,
                    std::map<int64_t, std::tuple<json, std::string, std::string>>& out) {
  if (node.is_array()) {
    for (size_t i = 0; i < node.size(); i++)
      collect_params(node[i], path + "/" + std::to_string(i), out);
    return;
  }
  if (!node.is_object()) return;
  auto id_it = node.find("id");
  auto val_it = node.find("value");
  if (id_it != node.end() && id_it->is_number_integer() && val_it != node.end()) {
    int64_t id = id_it->get<int64_t>();
    std::string vt = node.value("valuetype", std::string());
    out[id] = {*val_it, vt, path};
  }
  for (auto& [k, v] : node.items()) collect_params(v, path + "/" + k, out);
}

json make_name(const std::string& v) {
  return {{"valuetype", "ParamString"}, {"value", v}};
}

}  // namespace

FakeResolumeServer::FakeResolumeServer() { composition_ = json::object(); }
FakeResolumeServer::~FakeResolumeServer() { stop(); }

void FakeResolumeServer::set_composition(const json& composition) {
  std::lock_guard lock(mu_);
  composition_ = composition;
  composition_str_ = composition.dump();
  params_by_id_.clear();
  std::map<int64_t, std::tuple<json, std::string, std::string>> collected;
  collect_params(composition_, "", collected);
  for (auto& [id, tup] : collected) {
    params_by_id_[id] = ParamInfo{std::get<0>(tup), std::get<1>(tup), std::get<2>(tup)};
  }
}

bool FakeResolumeServer::start(int port) {
  if (running_) return true;
  ix::initNetSystem();
  server_ = std::make_unique<ix::WebSocketServer>(port, "0.0.0.0");
  server_->disablePerMessageDeflate();

  server_->setOnClientMessageCallback(
      [this](std::shared_ptr<ix::ConnectionState> /*state*/, ix::WebSocket& ws,
             const ix::WebSocketMessagePtr& msg) {
        if (msg->type == ix::WebSocketMessageType::Open) {
          // Resolume pushes the full composition on connect.
          std::string comp;
          {
            std::lock_guard lock(mu_);
            comp = composition_str_;
          }
          if (!comp.empty()) ws.send(comp);
          return;
        }
        if (msg->type == ix::WebSocketMessageType::Message) {
          handle_message(ws, msg->str);
        }
      });

  auto res = server_->listen();
  if (!res.first) return false;
  server_->start();
  port_ = port;
  running_ = true;
  return true;
}

void FakeResolumeServer::stop() {
  if (!running_) return;
  if (server_) {
    server_->stop();
    server_.reset();
  }
  running_ = false;
}

void FakeResolumeServer::handle_message(ix::WebSocket& ws, const std::string& msg) {
  json j = json::parse(msg, nullptr, false);
  if (j.is_discarded() || !j.is_object()) return;
  std::string action = j.value("action", std::string());
  std::string parameter = j.value("parameter", std::string());

  if (action == "subscribe") {
    // parameter == "/parameter/by-id/<id>"
    const std::string prefix = "/parameter/by-id/";
    if (parameter.rfind(prefix, 0) != 0) return;
    int64_t id = 0;
    try {
      id = std::stoll(parameter.substr(prefix.size()));
    } catch (...) {
      return;
    }
    ParamInfo info;
    {
      std::lock_guard lock(mu_);
      auto it = params_by_id_.find(id);
      if (it == params_by_id_.end()) return;
      info = it->second;
    }
    json reply = {
      {"type", "parameter_subscribed"},
      {"id", id},
      {"valuetype", info.valuetype},
      {"value", info.value},
      {"path", info.path},
    };
    ws.send(reply.dump());
    return;
  }

  if (action == "set") {
    int64_t id = j.value("id", (int64_t)0);
    json value = j.contains("value") ? j["value"] : json();
    std::string comp_snapshot;
    {
      std::lock_guard lock(mu_);
      sets_.push_back(SetRecord{id, parameter, value});
      // Apply the write to the live composition at the param's location and
      // rebuild the by-id index, so a subsequent broadcast reflects it — this
      // is how a real Resolume closes the loop after a param set.
      auto it = params_by_id_.find(id);
      if (it != params_by_id_.end() && !it->second.path.empty()) {
        json::json_pointer ptr(it->second.path);
        if (composition_.contains(ptr) && composition_[ptr].is_object()) {
          composition_[ptr]["value"] = value;
          composition_str_ = composition_.dump();
          params_by_id_.clear();
          std::map<int64_t, std::tuple<json, std::string, std::string>> collected;
          collect_params(composition_, "", collected);
          for (auto& [cid, tup] : collected)
            params_by_id_[cid] = ParamInfo{std::get<0>(tup), std::get<1>(tup),
                                           std::get<2>(tup)};
          comp_snapshot = composition_str_;
        }
      }
    }
    // Rebroadcast the updated composition to every connected client (mirrors
    // Resolume pushing a fresh CompositionState after a change). Sent outside
    // the lock; ws.send is thread-safe.
    if (!comp_snapshot.empty() && server_) {
      for (auto& client : server_->getClients()) client->send(comp_snapshot);
    }
    return;
  }

  if (action == "trigger") {
    std::lock_guard lock(mu_);
    triggers_.push_back(parameter);
    return;
  }
}

std::vector<FakeResolumeServer::SetRecord> FakeResolumeServer::recorded_sets() const {
  std::lock_guard lock(mu_);
  return sets_;
}

std::vector<std::string> FakeResolumeServer::recorded_triggers() const {
  std::lock_guard lock(mu_);
  return triggers_;
}

json FakeResolumeServer::make_default_composition(const std::vector<std::string>& uuids) {
  json comp;
  comp["name"] = make_name("Fake Comp");
  comp["video"] = {{"width", 1920}, {"height", 1080}, {"effects", json::array()}};
  comp["layers"] = json::array();

  int64_t next_id = 100000;
  for (size_t i = 0; i < uuids.size(); i++) {
    json env = {{"sketch", {{"chain", json::array()}}}, {"uuid", uuids[i]}};
    std::string blob = barrel_codec::wrap_config(env.dump());
    int64_t config_id = next_id++;
    json barrel = {
      {"id", next_id++},
      {"name", "NanoBarrel"},
      {"display_name", "NanoBarrel"},
      {"bypassed", {{"valuetype", "ParamBoolean"}, {"id", next_id++}, {"value", false}}},
      {"params", {
        {"Opacity", {{"id", next_id++}, {"valuetype", "ParamRange"}, {"value", 1}}},
        {"config", {{"id", config_id}, {"valuetype", "ParamFile"}, {"value", blob}}},
        {"macro_00", {{"id", next_id++}, {"valuetype", "ParamRange"}, {"value", 0}}},
      }},
    };
    json clip;
    clip["id"] = next_id++;
    clip["name"] = make_name("NanoBarrel");
    clip["connected"] = {{"valuetype", "ParamState"}, {"value", "Disconnected"}, {"id", next_id++}};
    clip["video"] = {{"effects", json::array({barrel})}};
    json layer;
    layer["id"] = next_id++;
    layer["name"] = make_name("Layer #");
    layer["clips"] = json::array({clip});
    comp["layers"].push_back(layer);
  }
  return comp;
}

json FakeResolumeServer::make_marker_effect(const MarkerSpec& spec, int64_t& next_id) {
  // The FF_TYPE_TEXT fix bakes the identity into the config param's value so
  // Resolume broadcasts it inline; empty_config models the pre-fix empty blob.
  const std::string blob =
      spec.empty_config ? std::string()
                        : channel_marker::wrap_config(spec.uuid, spec.channel,
                                                      spec.name);
  json eff = {
    {"id", next_id++},
    {"name", "NanoLooper Ch"},
    {"display_name", "NanoLooper Ch"},
    {"bypassed", {{"valuetype", "ParamBoolean"}, {"id", next_id++}, {"value", false}}},
  };
  json params;
  params["Opacity"] = {{"id", next_id++}, {"valuetype", "ParamRange"},
                       {"min", 0.0}, {"max", 1.0}, {"value", 1.0}};
  params["config"] = {{"id", next_id++}, {"valuetype", "ParamString"}, {"value", blob}};
  params["Channel"] = {{"id", next_id++}, {"valuetype", "ParamRange"},
                       {"min", 0.0}, {"max", 1.0},
                       {"value", channel_marker::channel_to_norm(spec.channel)}};
  params["Name"] = {{"id", next_id++}, {"valuetype", "ParamString"}, {"value", spec.name}};
  eff["params"] = std::move(params);
  return eff;
}

json FakeResolumeServer::make_thumbnail(int64_t& next_id, bool is_default) {
  const int64_t id = next_id++;
  return {
    {"id", id},
    {"size", 394},
    {"last_update", "0"},
    {"is_default", is_default},
    {"path", is_default ? std::string("/api/v1/composition/thumbnail/dummy")
                        : ("/api/v1/composition/thumbnail/" + std::to_string(id))},
  };
}

json FakeResolumeServer::make_marker_composition(const std::vector<MarkerSpec>& markers) {
  json comp;
  comp["name"] = make_name("Fake Marker Comp");
  comp["video"] = {{"width", 1920}, {"height", 1080}, {"effects", json::array()}};
  comp["layers"] = json::array();

  int64_t next_id = 200000;
  for (const auto& m : markers) {
    json clip;
    clip["id"] = next_id++;
    clip["name"] = make_name("Solid Color");
    clip["connected"] = {{"valuetype", "ParamState"}, {"value", m.connected},
                         {"id", next_id++}};
    clip["thumbnail"] = make_thumbnail(next_id, /*is_default=*/true);
    clip["video"] = {{"effects", json::array({make_marker_effect(m, next_id)})}};
    json layer;
    layer["id"] = next_id++;
    layer["name"] = make_name("Layer #");
    layer["clips"] = json::array({clip});
    comp["layers"].push_back(layer);
  }
  return comp;
}

}  // namespace bridge
