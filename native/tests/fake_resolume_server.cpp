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
  build_clip_runtime();
}

void FakeResolumeServer::build_clip_runtime() {
  // Called under mu_. Walk layers[].clips[] and index per-clip runtime state by
  // the clip's 1-based connect action path (the trigger target).
  clip_rt_.clear();
  if (!composition_.contains("layers") || !composition_["layers"].is_array()) return;
  const auto& layers = composition_["layers"];
  for (size_t li = 0; li < layers.size(); ++li) {
    if (!layers[li].contains("clips") || !layers[li]["clips"].is_array()) continue;
    const auto& clips = layers[li]["clips"];
    for (size_t ci = 0; ci < clips.size(); ++ci) {
      const auto& clip = clips[ci];
      ClipRuntime rt;
      rt.layer = static_cast<int>(li);
      if (clip.contains("connected") && clip["connected"].is_object()) {
        const auto& conn = clip["connected"];
        rt.connected = conn.value("value", std::string("Disconnected"));
        rt.connected_id = conn.value("id", (int64_t)0);
      }
      rt.has_content = (rt.connected != "Empty");
      if (clip.contains("triggerstyle") && clip["triggerstyle"].is_object())
        rt.style = clip["triggerstyle"].value("value", std::string());
      std::string path = "/composition/layers/" + std::to_string(li + 1) +
                         "/clips/" + std::to_string(ci + 1) + "/connect";
      clip_rt_[path] = rt;
    }
  }
}

void FakeResolumeServer::set_connected(
    ClipRuntime& c, const std::string& value,
    std::vector<std::pair<int64_t, std::string>>& out_changes) {
  // Under mu_. Update the modelled state + the by-id param value (so a later
  // subscribe reply is correct) and queue the parameter_update to broadcast.
  if (c.connected == value) return;
  c.connected = value;
  auto it = params_by_id_.find(c.connected_id);
  if (it != params_by_id_.end()) {
    it->second.value = value;
    if (!it->second.path.empty()) {
      json::json_pointer ptr(it->second.path);
      if (composition_.contains(ptr) && composition_[ptr].is_object())
        composition_[ptr]["value"] = value;
    }
  }
  out_changes.push_back({c.connected_id, value});
}

void FakeResolumeServer::broadcast_param_update(int64_t id, const std::string& value) {
  if (!server_) return;
  json upd = {
    {"type", "parameter_update"},
    {"id", id},
    {"valuetype", "ParamState"},
    {"value", value},
    {"path", "/parameter/by-id/" + std::to_string(id)},
  };
  const std::string s = upd.dump();
  for (auto& client : server_->getClients()) client->send(s);
}

void FakeResolumeServer::seed_stuck(const std::string& connect_path,
                                    bool stuck_on, bool stuck_off) {
  std::vector<std::pair<int64_t, std::string>> changes;
  {
    std::lock_guard lock(mu_);
    auto it = clip_rt_.find(connect_path);
    if (it == clip_rt_.end()) return;
    ClipRuntime& c = it->second;
    c.stuck_on = stuck_on;
    c.stuck_off = stuck_off;
    if (stuck_on) set_connected(c, "Connected", changes);  // stuck-on ⇒ on-screen
  }
  for (auto& [id, val] : changes) broadcast_param_update(id, val);
}

std::string FakeResolumeServer::clip_connected(const std::string& connect_path) const {
  std::lock_guard lock(mu_);
  auto it = clip_rt_.find(connect_path);
  return it == clip_rt_.end() ? std::string() : it->second.connected;
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
    std::vector<std::pair<int64_t, std::string>> changes;
    {
      std::lock_guard lock(mu_);
      triggers_.push_back(parameter);
      auto it = clip_rt_.find(parameter);
      if (it != clip_rt_.end()) {
        ClipRuntime& c = it->second;
        const bool value = j.value("value", true);
        if (value) {
          // CONNECT. Resolume's layer holds one active clip: connecting evicts
          // whatever else is playing on the layer. An evicted Normal clip drops
          // into stuck_off (a later plain connect is ignored until re-armed).
          for (auto& [p, o] : clip_rt_) {
            if (&o == &c) continue;
            if (o.layer == c.layer && o.connected == "Connected") {
              set_connected(o, "Disconnected", changes);
              if (!o.is_piano() && o.has_content) o.stuck_off = true;
            }
          }
          if (!c.has_content) {
            // An empty clip is a pure evictor — it doesn't become "Connected".
          } else if (!c.is_piano() && c.stuck_off) {
            // Normal stuck-off: this connect is DROPPED (ignored) until re-armed.
          } else {
            c.stuck_on = false;   // a connect re-arms the disconnect path
            c.stuck_off = false;  // ...and clears its own stuck-off
            set_connected(c, "Connected", changes);
          }
        } else {
          // DISCONNECT (connect:false).
          if (!c.is_piano()) {
            // Normal clips ignore connect:false on their connected state — but it
            // RE-ARMS them (clears a stuck-off latch), matching the live
            // "false then true" recovery.
            c.stuck_off = false;
          } else if (c.stuck_on) {
            // Stuck-on piano clip ignores bare disconnects.
          } else if (c.connected == "Connected") {
            set_connected(c, "Disconnected", changes);
          }
        }
        composition_str_ = composition_.dump();
      }
    }
    for (auto& [id, val] : changes) broadcast_param_update(id, val);
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

json FakeResolumeServer::make_trigger_test_composition() {
  int64_t next_id = 300000;
  auto make_clip = [&](const std::string& name, const std::string& style,
                       const std::string& connected, int channel,
                       bool empty) -> json {
    json clip;
    clip["id"] = next_id++;
    clip["name"] = make_name(name);
    clip["connected"] = {{"valuetype", "ParamState"}, {"value", connected},
                         {"id", next_id++}};
    clip["triggerstyle"] = {
      {"valuetype", "ParamChoice"},
      {"options", json::array({"Composition Determined", "Normal", "Piano",
                               "Toggle"})},
      {"value", style}};
    if (!empty) {
      MarkerSpec m;
      m.uuid = "U-" + name;
      m.channel = channel;
      m.name = name;
      clip["video"] = {{"effects", json::array({make_marker_effect(m, next_id)})}};
    }
    return clip;
  };
  auto make_layer = [&](json content_clip) -> json {
    json layer;
    layer["id"] = next_id++;
    layer["name"] = make_name("Layer #");
    // content clip at index 0, an EMPTY clip at index 1 (the eviction target).
    json empty_clip = make_clip("", "Normal", "Empty", 0, /*empty=*/true);
    layer["clips"] = json::array({std::move(content_clip), std::move(empty_clip)});
    return layer;
  };
  json comp;
  comp["name"] = make_name("Trigger Test Comp");
  comp["video"] = {{"width", 1920}, {"height", 1080}, {"effects", json::array()}};
  comp["layers"] = json::array({
    make_layer(make_clip("Red", "Normal", "Disconnected", 1, /*empty=*/false)),
    make_layer(make_clip("Blue", "Piano", "Disconnected", 2, /*empty=*/false)),
  });
  return comp;
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
