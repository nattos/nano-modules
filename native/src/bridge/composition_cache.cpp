#include "bridge/composition_cache.h"

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

int CompositionCache::channel_from_clip(const resolume::Clip& clip) {
  for (const auto& eff : clip.effects) {
    if (!is_channel_tag_effect(eff.name) &&
        !is_channel_tag_effect(eff.display_name))
      continue;

    auto it = eff.params.find(kChannelParamName);
    if (it == eff.params.end()) {
      for (auto candidate = eff.params.begin(); candidate != eff.params.end(); ++candidate) {
        if (candidate->first.find("hannel") != std::string::npos ||
            candidate->second.valuetype == "ParamChoice" ||
            candidate->second.valuetype == "ParamOption") {
          it = candidate;
          break;
        }
      }
    }
    if (it == eff.params.end()) continue;

    if (it->second.value.is_string()) {
      std::string val = it->second.value.get<std::string>();
      if (val.find('1') != std::string::npos) return 0;
      if (val.find('2') != std::string::npos) return 1;
      if (val.find('3') != std::string::npos) return 2;
      if (val.find('4') != std::string::npos) return 3;
      return -1;
    }
    if (it->second.value.is_number()) {
      float v = it->second.value.get<float>();
      if (v < 0.1f) return -1;
      if (v < 0.3f) return 0;
      if (v < 0.5f) return 1;
      if (v < 0.7f) return 2;
      return 3;
    }
    return -1;
  }
  return -1;
}

void CompositionCache::rebuild(const resolume::Composition& comp) {
  std::vector<CachedClip> new_clips;

  for (const auto& layer : comp.layers) {
    for (const auto& clip : layer.clips) {
      CachedClip cc;
      cc.clip_id = clip.id;
      cc.name = clip.name;
      cc.channel = channel_from_clip(clip);
      cc.connected = (clip.connected_state == "Connected");
      cc.connected_param_id = clip.connected_id;
      cc.thumbnail_tex_id = -1;
      new_clips.push_back(std::move(cc));
    }
  }

  std::lock_guard lock(mutex_);
  clips_ = std::move(new_clips);
}

int CompositionCache::clip_count() const {
  std::lock_guard lock(mutex_);
  return static_cast<int>(clips_.size());
}

CachedClip CompositionCache::get_clip(int index) const {
  std::lock_guard lock(mutex_);
  if (index < 0 || index >= static_cast<int>(clips_.size()))
    return {};
  return clips_[index];
}

double CompositionCache::bpm() const {
  std::lock_guard lock(mutex_);
  return bpm_;
}

void CompositionCache::set_bpm(double bpm) {
  std::lock_guard lock(mutex_);
  bpm_ = bpm;
}

} // namespace bridge
