#include "composition.h"

namespace resolume {

Parameter parse_parameter(const nlohmann::json& j) {
  Parameter p;
  if (!j.is_object()) return p;
  if (j.contains("id")) p.id = j["id"].get<int64_t>();
  if (j.contains("valuetype")) p.valuetype = j["valuetype"].get<std::string>();
  if (j.contains("value")) p.value = j["value"];
  if (j.contains("min")) p.min = j["min"].get<double>();
  if (j.contains("max")) p.max = j["max"].get<double>();
  if (j.contains("options") && j["options"].is_array()) {
    for (const auto& opt : j["options"]) {
      if (opt.is_string()) p.options.push_back(opt.get<std::string>());
    }
  }
  return p;
}

static Effect parse_effect(const nlohmann::json& j) {
  Effect eff;
  if (j.contains("id")) eff.id = j["id"].get<int64_t>();
  if (j.contains("name")) eff.name = j["name"].get<std::string>();
  if (j.contains("display_name")) eff.display_name = j["display_name"].get<std::string>();
  if (j.contains("params") && j["params"].is_object()) {
    for (auto& [key, val] : j["params"].items()) {
      if (val.is_object() && val.contains("id") && val.contains("valuetype"))
        eff.params[key] = parse_parameter(val);
    }
  }
  return eff;
}

static Clip parse_clip(const nlohmann::json& j) {
  Clip clip;
  if (j.contains("id")) clip.id = j["id"].get<int64_t>();
  if (j.contains("name") && j["name"].is_object()) {
    auto& name = j["name"];
    if (name.contains("value")) clip.name = name["value"].get<std::string>();
  }
  if (j.contains("connected") && j["connected"].is_object()) {
    auto& conn = j["connected"];
    if (conn.contains("value")) clip.connected_state = conn["value"].get<std::string>();
    if (conn.contains("id")) clip.connected_id = conn["id"].get<int64_t>();
  }
  // Effects can be in video.effects or directly in clip.effects (depends on Resolume version)
  auto parse_effects_from = [&](const nlohmann::json& container) {
    if (container.contains("effects") && container["effects"].is_array()) {
      for (const auto& eff_json : container["effects"])
        clip.effects.push_back(parse_effect(eff_json));
    }
  };
  if (j.contains("video") && j["video"].is_object()) {
    auto& video = j["video"];
    if (video.contains("opacity"))
      clip.video_opacity = parse_parameter(video["opacity"]);
    parse_effects_from(video);
  }
  // Also check for effects directly on the clip (some Resolume versions)
  parse_effects_from(j);
  if (j.contains("thumbnail") && j["thumbnail"].is_object()) {
    auto& th = j["thumbnail"];
    if (th.contains("path")) clip.thumbnail_path = th["path"].get<std::string>();
    if (th.contains("is_default")) clip.thumbnail_is_default = th["is_default"].get<bool>();
  }
  return clip;
}

static Layer parse_layer(const nlohmann::json& j) {
  Layer layer;
  if (j.contains("id")) layer.id = j["id"].get<int64_t>();
  if (j.contains("name") && j["name"].is_object()) {
    auto& name = j["name"];
    if (name.contains("value")) layer.name = name["value"].get<std::string>();
  }
  if (j.contains("clips") && j["clips"].is_array()) {
    for (const auto& clip_json : j["clips"]) {
      layer.clips.push_back(parse_clip(clip_json));
    }
  }
  if (j.contains("video") && j["video"].is_object()) {
    auto& video = j["video"];
    if (video.contains("opacity")) {
      layer.video_opacity = parse_parameter(video["opacity"]);
    }
  }
  if (j.contains("master") && j["master"].is_object()) {
    layer.master = parse_parameter(j["master"]);
  }
  return layer;
}

Composition parse_composition(const nlohmann::json& state) {
  Composition comp;
  if (state.contains("name") && state["name"].is_object()) {
    auto& name = state["name"];
    if (name.contains("value")) comp.name = name["value"].get<std::string>();
  }
  if (state.contains("layers") && state["layers"].is_array()) {
    for (const auto& layer_json : state["layers"]) {
      comp.layers.push_back(parse_layer(layer_json));
    }
  }
  return comp;
}

} // namespace resolume
