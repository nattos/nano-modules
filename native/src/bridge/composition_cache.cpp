#include "bridge/composition_cache.h"

#include "bridge/trig_log.h"
#include "plugin/nano_barrel/channel_marker_codec.h"

namespace bridge {

// Channel tag effect identifiers (matching NanoLooper Ch plugin)
static const char* kChannelTagFFGLCode = "NLCH";
static const char* kChannelTagPluginName = "NanoLooper Ch";
static const char* kChannelParamName = "Channel";

static bool is_channel_tag_effect(const std::string& s) {
  return s == kChannelTagFFGLCode ||
         s == kChannelTagPluginName ||
         s.find("NanoLooper") != std::string::npos ||
         s.find("NLCH") != std::string::npos;
}

// Does this effect carry a nanoch:// marker config in any string param?
static bool has_marker_config(const resolume::Effect& eff) {
  for (const auto& [name, param] : eff.params) {
    if (param.value.is_string() &&
        channel_marker::is_marker_config(param.value.get<std::string>()))
      return true;
  }
  return false;
}

// Resolve a clip's trigger channel (0-based) from a NanoLooper Ch scene marker,
// or -1 if the clip carries none.
//
// PRIMARY source is the marker's broadcast "Channel" param VALUE: Resolume
// always serializes float param values inline in the composition, so this
// tracks the slider live (unlike the config FILE blob, which the plugin can't
// push back to the host on a slider move). The config blob is a SECONDARY
// source (carries the channel too, but may be stale/absent in the broadcast).
int CompositionCache::channel_from_clip(const resolume::Clip& clip) {
  for (const auto& eff : clip.effects) {
    const bool is_marker = is_channel_tag_effect(eff.name) ||
                           is_channel_tag_effect(eff.display_name) ||
                           has_marker_config(eff);
    if (!is_marker) continue;

    // PRIMARY: the "Channel" float param value (norm 0..1 → 1..N, shared
    // encoding with the plugin). Reliable — always broadcast.
    auto it = eff.params.find(kChannelParamName);
    if (it != eff.params.end() && it->second.value.is_number()) {
      const float v = (float)it->second.value.get<double>();
      const int ch0 = channel_marker::norm_to_channel(v) - 1;
      trig_log("resolve clip='%s' marker='%s' Channel=%.4f -> ch(1-based)=%d",
               clip.name.c_str(), eff.name.c_str(), v, ch0 + 1);
      return ch0;
    }

    // SECONDARY: the {uuid,channel} config blob, if present in the broadcast.
    for (const auto& [name, param] : eff.params) {
      if (!param.value.is_string()) continue;
      const int ch = channel_marker::channel_of(param.value.get<std::string>());
      if (ch >= 1) {
        trig_log("resolve clip='%s' marker='%s' from config blob -> ch(1-based)=%d",
                 clip.name.c_str(), eff.name.c_str(), ch);
        return ch - 1;
      }
    }

    trig_log("resolve clip='%s' marker='%s' FOUND but no Channel param/config "
             "(params=%zu) -> unassigned", clip.name.c_str(), eff.name.c_str(),
             eff.params.size());
    return -1;
  }
  return -1;
}

void CompositionCache::rebuild(const resolume::Composition& comp) {
  std::vector<CachedClip> new_clips;

  for (size_t li = 0; li < comp.layers.size(); ++li) {
    const auto& layer = comp.layers[li];
    for (size_t ci = 0; ci < layer.clips.size(); ++ci) {
      const auto& clip = layer.clips[ci];
      CachedClip cc;
      cc.clip_id = clip.id;
      cc.name = clip.name;
      cc.channel = channel_from_clip(clip);
      cc.connected = (clip.connected_state == "Connected");
      cc.connected_param_id = clip.connected_id;
      cc.thumbnail_tex_id = -1;
      cc.layer_index = static_cast<int>(li);
      cc.clip_index = static_cast<int>(ci);
      // Resolume's WS API addresses layers/clips 1-BASED (its own example is
      // "/composition/layers/1/clips/1/connect"), while comp.layers/clips are
      // 0-based arrays — so the action path is (index + 1). Getting this wrong
      // launches the clip one row up / one column left.
      cc.connect_path = "/composition/layers/" + std::to_string(li + 1) +
                        "/clips/" + std::to_string(ci + 1) + "/connect";
      new_clips.push_back(std::move(cc));
    }
  }

  platform::LockGuard<platform::Mutex> lock(mutex_);
  clips_ = std::move(new_clips);
}

int CompositionCache::clip_count() const {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  return static_cast<int>(clips_.size());
}

CachedClip CompositionCache::get_clip(int index) const {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  if (index < 0 || index >= static_cast<int>(clips_.size()))
    return {};
  return clips_[index];
}

double CompositionCache::bpm() const {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  return bpm_;
}

void CompositionCache::set_bpm(double bpm) {
  platform::LockGuard<platform::Mutex> lock(mutex_);
  bpm_ = bpm;
}

} // namespace bridge
