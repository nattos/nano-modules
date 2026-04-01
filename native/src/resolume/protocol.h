#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <variant>

#include <nlohmann/json.hpp>

namespace resolume {

// --- Outgoing messages (client -> server) ---

struct SubscribeMessage {
  std::string parameter; // e.g. "/parameter/by-id/12345"
};

struct SetMessage {
  std::string parameter; // e.g. "/composition/layers/1/video/opacity"
  int64_t id;
  nlohmann::json value;
};

struct TriggerMessage {
  std::string parameter; // e.g. "/composition/layers/1/clips/1/connect"
  bool value = true;
};

using OutgoingMessage = std::variant<SubscribeMessage, SetMessage, TriggerMessage>;

// Serialize outgoing messages to JSON
nlohmann::json to_json(const SubscribeMessage& msg);
nlohmann::json to_json(const SetMessage& msg);
nlohmann::json to_json(const TriggerMessage& msg);
nlohmann::json to_json(const OutgoingMessage& msg);

// --- Incoming messages (server -> client) ---

struct ParameterSubscribed {
  int64_t id;
  std::string valuetype;
  nlohmann::json value;
  std::string path;
  std::optional<double> min;
  std::optional<double> max;
};

struct ParameterUpdate {
  int64_t id;
  std::string valuetype;
  nlohmann::json value;
  std::string path;
};

struct ErrorMessage {
  std::string error;
  std::optional<std::string> path;
};

struct CompositionState {
  nlohmann::json data; // Full initial state JSON
};

using IncomingMessage =
    std::variant<CompositionState, ParameterSubscribed, ParameterUpdate, ErrorMessage>;

// Parse incoming JSON into an IncomingMessage
IncomingMessage parse_incoming(const nlohmann::json& j);

} // namespace resolume
