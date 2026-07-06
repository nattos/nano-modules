#pragma once
// channel_marker_codec.h — config envelope for the "NanoLooper Ch" scene-marker
// FFGL plugin.
//
// The marker persists {uuid, channel} inline in its FILE param, wrapped in a
// `nanoch://config?<base64>` scheme (a sibling of the barrel's
// `nanobarrel://config?`). Two readers decode it:
//   - the shared server's CompositionCache, to resolve channel → clips for
//     launching (see composition_cache.cpp);
//   - the plugin itself, to restore its uuid + channel across host restarts.
//
// The DISTINCT scheme keeps the InstanceLocator (which matches `nanobarrel://`)
// from ever mistaking a marker for a barrel. Reuses barrel_codec's header-only
// base64 so there is exactly one base64 implementation.

#include <cstring>
#include <string>

#include <nlohmann/json.hpp>

#include "plugin/nano_barrel/barrel_codec.h"

namespace channel_marker {

constexpr const char* kConfigPrefix = "nanoch://config?";

// Channel range + the normalized-slider <-> 1-based-channel mapping. SHARED by
// the FFGL plugin (which exposes "Channel" as an FF_TYPE_STANDARD 0..1 slider)
// and the server's CompositionCache (which reads that broadcast value back).
// Both MUST use this one mapping or the server resolves a different channel
// than the user picked. v=0 -> ch1, and each ~1/3 step advances a channel.
constexpr int kMaxChannel = 4;

inline float channel_to_norm(int ch) {
  if (ch < 1) ch = 1;
  if (ch > kMaxChannel) ch = kMaxChannel;
  return static_cast<float>(ch - 1) / static_cast<float>(kMaxChannel - 1);
}

inline int norm_to_channel(float v) {
  if (v < 0.0f) v = 0.0f;
  if (v > 1.0f) v = 1.0f;
  return 1 + static_cast<int>(v * (kMaxChannel - 1) + 0.5f);
}

// Wrap {uuid, channel, name} into the nanoch:// FILE-param value. `name` is an
// optional cosmetic label for the channel (empty = unnamed); the numeric channel
// remains the matching key.
inline std::string wrap_config(const std::string& uuid, int channel,
                               const std::string& name = "") {
  nlohmann::json j = {{"uuid", uuid}, {"channel", channel}, {"name", name}};
  return std::string(kConfigPrefix) + barrel_codec::base64_encode(j.dump());
}

inline bool is_marker_config(const std::string& value) {
  const size_t plen = std::strlen(kConfigPrefix);
  return value.size() >= plen && value.compare(0, plen, kConfigPrefix) == 0;
}

// Decode the raw {uuid, channel} JSON, or "" if the value isn't a marker blob.
inline std::string unwrap_config(const std::string& value) {
  if (!is_marker_config(value)) return "";
  return barrel_codec::base64_decode(value.substr(std::strlen(kConfigPrefix)));
}

// The 1-based channel carried in a marker config value, or -1 if absent/invalid.
inline int channel_of(const std::string& value) {
  const std::string js = unwrap_config(value);
  if (js.empty()) return -1;
  auto j = nlohmann::json::parse(js, nullptr, /*allow_exceptions=*/false);
  if (!j.is_object() || !j.contains("channel") || !j["channel"].is_number())
    return -1;
  return j["channel"].get<int>();
}

// The uuid carried in a marker config value, or "" if absent/invalid.
inline std::string uuid_of(const std::string& value) {
  const std::string js = unwrap_config(value);
  if (js.empty()) return "";
  auto j = nlohmann::json::parse(js, nullptr, /*allow_exceptions=*/false);
  if (!j.is_object() || !j.contains("uuid") || !j["uuid"].is_string()) return "";
  return j["uuid"].get<std::string>();
}

// The cosmetic channel name carried in a marker config value, or "" if
// absent/invalid (older blobs predate the field).
inline std::string name_of(const std::string& value) {
  const std::string js = unwrap_config(value);
  if (js.empty()) return "";
  auto j = nlohmann::json::parse(js, nullptr, /*allow_exceptions=*/false);
  if (!j.is_object() || !j.contains("name") || !j["name"].is_string()) return "";
  return j["name"].get<std::string>();
}

}  // namespace channel_marker
