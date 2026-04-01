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

  // Messages with a "type" field
  if (j.contains("type")) {
    auto type = j["type"].get<std::string>();
    if (type == "parameter_subscribed") {
      ParameterSubscribed ps;
      ps.id = j["id"].get<int64_t>();
      ps.valuetype = j["valuetype"].get<std::string>();
      ps.value = j["value"];
      ps.path = j["path"].get<std::string>();
      if (j.contains("min")) ps.min = j["min"].get<double>();
      if (j.contains("max")) ps.max = j["max"].get<double>();
      return ps;
    }
    if (type == "parameter_update") {
      ParameterUpdate pu;
      pu.id = j["id"].get<int64_t>();
      pu.valuetype = j["valuetype"].get<std::string>();
      pu.value = j["value"];
      pu.path = j["path"].get<std::string>();
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
