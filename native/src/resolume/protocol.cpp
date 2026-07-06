#include "resolume/protocol.h"

namespace resolume {

// --- Serialization ---

nlohmann::json to_json(const SubscribeMessage& msg) {
  return {{"action", "subscribe"}, {"parameter", msg.parameter}};
}

nlohmann::json to_json(const SetMessage& msg) {
  return {
      {"action", "set"},
      {"parameter", msg.parameter},
      {"id", msg.id},
      {"value", msg.value},
  };
}

nlohmann::json to_json(const TriggerMessage& msg) {
  return {
      {"action", "trigger"},
      {"parameter", msg.parameter},
      {"value", msg.value},
  };
}

nlohmann::json to_json(const OutgoingMessage& msg) {
  return std::visit([](const auto& m) { return to_json(m); }, msg);
}

// --- Parsing ---

IncomingMessage parse_incoming(const nlohmann::json& j) {
  // Error messages
  if (j.contains("error")) {
    ErrorMessage err;
    err.error = j["error"].get<std::string>();
    if (j.contains("path") && j["path"].is_string()) {
      err.path = j["path"].get<std::string>();
    }
    return err;
  }

  // Messages with a "type" field. Be TOLERANT of missing fields: real Resolume's
  // parameter_update for a subscribed param may omit "path"/"valuetype" (unlike
  // the parameter_subscribed reply). A hard .get() there throws and the ws_client
  // silently drops the whole frame — which would swallow every clip connected-
  // state push and leave the ClipLauncher blind (→ oscillation).
  if (j.contains("type") && j["type"].is_string()) {
    auto type = j["type"].get<std::string>();
    if (type == "parameter_subscribed" || type == "parameter_update") {
      int64_t id = (j.contains("id") && j["id"].is_number_integer())
                       ? j["id"].get<int64_t>() : 0;
      std::string valuetype = j.value("valuetype", std::string());
      nlohmann::json value = j.contains("value") ? j["value"] : nlohmann::json();
      std::string path = j.value("path", std::string());
      if (type == "parameter_subscribed") {
        ParameterSubscribed ps;
        ps.id = id; ps.valuetype = valuetype; ps.value = value; ps.path = path;
        if (j.contains("min") && j["min"].is_number()) ps.min = j["min"].get<double>();
        if (j.contains("max") && j["max"].is_number()) ps.max = j["max"].get<double>();
        return ps;
      }
      ParameterUpdate pu;
      pu.id = id; pu.valuetype = valuetype; pu.value = value; pu.path = path;
      return pu;
    }
  }

  // No type field and no error -> initial composition state
  if (j.contains("layers") || j.contains("decks")) {
    return CompositionState{j};
  }

  // Unknown message -- treat as error
  return ErrorMessage{"Unknown message format", std::nullopt};
}

} // namespace resolume
