#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace resolume {

struct Parameter {
  int64_t id = 0;
  std::string valuetype;
  nlohmann::json value;
  std::optional<double> min;
  std::optional<double> max;
  std::vector<std::string> options; // For ParamChoice
};

struct Effect {
  int64_t id = 0;
  std::string name;         // internal FFGL name/code
  std::string display_name;
  std::map<std::string, Parameter> params;
};

struct Clip {
  int64_t id = 0;
  std::string name;
  std::string connected_state; // "Empty", "Disconnected", "Connected", etc.
  int64_t connected_id = 0;   // ID of the connected ParamState
  Parameter video_opacity;
  std::string thumbnail_path;
  bool thumbnail_is_default = true;
  std::vector<Effect> effects; // effects on this clip's video chain
};

struct Layer {
  int64_t id = 0;
  std::string name;
  std::vector<Clip> clips;
  Parameter video_opacity;
  Parameter master;
};

struct Composition {
  std::string name;
  std::vector<Layer> layers;
};

// Parse a full composition state JSON into a Composition struct.
// Only extracts the fields we care about — layers, clips, key params.
Composition parse_composition(const nlohmann::json& state);

// Parse a single parameter from JSON
Parameter parse_parameter(const nlohmann::json& j);

} // namespace resolume
