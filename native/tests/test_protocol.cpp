#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include "resolume/protocol.h"

using namespace resolume;

TEST_CASE("Serialize SubscribeMessage", "[protocol]") {
  SubscribeMessage msg{"/parameter/by-id/1763903991101"};
  auto j = to_json(msg);
  REQUIRE(j["action"] == "subscribe");
  REQUIRE(j["parameter"] == "/parameter/by-id/1763903991101");
}

TEST_CASE("Serialize SetMessage", "[protocol]") {
  SetMessage msg{"/composition/layers/1/video/opacity", 1763903991101, 0.25};
  auto j = to_json(msg);
  REQUIRE(j["action"] == "set");
  REQUIRE(j["parameter"] == "/composition/layers/1/video/opacity");
  REQUIRE(j["id"] == 1763903991101);
  REQUIRE(j["value"] == 0.25);
}

TEST_CASE("Serialize TriggerMessage", "[protocol]") {
  TriggerMessage msg{"/composition/layers/1/clips/1/connect", true};
  auto j = to_json(msg);
  REQUIRE(j["action"] == "trigger");
  REQUIRE(j["parameter"] == "/composition/layers/1/clips/1/connect");
  REQUIRE(j["value"] == true);
}

TEST_CASE("Serialize OutgoingMessage variant", "[protocol]") {
  OutgoingMessage msg = SubscribeMessage{"/parameter/by-id/123"};
  auto j = to_json(msg);
  REQUIRE(j["action"] == "subscribe");
}

TEST_CASE("Parse ParameterSubscribed", "[protocol]") {
  auto j = nlohmann::json{
      {"id", 1763903991101},
      {"valuetype", "ParamRange"},
      {"value", 0.5},
      {"path", "/composition/layers/1/video/opacity"},
      {"type", "parameter_subscribed"},
      {"min", 0.0},
      {"max", 1.0},
  };
  auto msg = parse_incoming(j);
  REQUIRE(std::holds_alternative<ParameterSubscribed>(msg));
  auto& ps = std::get<ParameterSubscribed>(msg);
  REQUIRE(ps.id == 1763903991101);
  REQUIRE(ps.valuetype == "ParamRange");
  REQUIRE(ps.value == 0.5);
  REQUIRE(ps.path == "/composition/layers/1/video/opacity");
  REQUIRE(ps.min.has_value());
  REQUIRE(ps.min.value() == 0.0);
  REQUIRE(ps.max.value() == 1.0);
}

TEST_CASE("Parse ParameterUpdate", "[protocol]") {
  auto j = nlohmann::json{
      {"id", 1763903991101},
      {"valuetype", "ParamRange"},
      {"value", 0.25},
      {"path", "/composition/layers/1/video/opacity"},
      {"type", "parameter_update"},
  };
  auto msg = parse_incoming(j);
  REQUIRE(std::holds_alternative<ParameterUpdate>(msg));
  auto& pu = std::get<ParameterUpdate>(msg);
  REQUIRE(pu.id == 1763903991101);
  REQUIRE(pu.value == 0.25);
}

TEST_CASE("Parse ErrorMessage", "[protocol]") {
  auto j = nlohmann::json{
      {"error", "Invalid parameter path"},
      {"path", "/bad/path"},
  };
  auto msg = parse_incoming(j);
  REQUIRE(std::holds_alternative<ErrorMessage>(msg));
  auto& err = std::get<ErrorMessage>(msg);
  REQUIRE(err.error == "Invalid parameter path");
  REQUIRE(err.path.has_value());
  REQUIRE(err.path.value() == "/bad/path");
}

TEST_CASE("Parse ErrorMessage without path", "[protocol]") {
  auto j = nlohmann::json{
      {"id", nullptr},
      {"error", "mandatory field doesn't exist"},
  };
  auto msg = parse_incoming(j);
  REQUIRE(std::holds_alternative<ErrorMessage>(msg));
}

TEST_CASE("Parse CompositionState", "[protocol]") {
  auto j = nlohmann::json{
      {"layers", nlohmann::json::array()},
      {"decks", nlohmann::json::array()},
      {"crossfader", nlohmann::json::object()},
  };
  auto msg = parse_incoming(j);
  REQUIRE(std::holds_alternative<CompositionState>(msg));
  auto& cs = std::get<CompositionState>(msg);
  REQUIRE(cs.data.contains("layers"));
}
