#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "resolume/composition.h"

namespace bridge {

struct CachedClip {
  int64_t clip_id = 0;
  std::string name;
  int channel = -1;           // -1=unassigned, 0-3
  bool connected = false;
  int64_t connected_param_id = 0;
  int32_t thumbnail_tex_id = -1;
};

/// Maintains a flat, indexed view of the Resolume composition
/// with pre-computed channel assignments from NanoLooper Ch effects.
class CompositionCache {
public:
  /// Rebuild the cache from a parsed composition.
  void rebuild(const resolume::Composition& comp);

  /// Thread-safe accessors
  int clip_count() const;
  CachedClip get_clip(int index) const;

  /// Get the cached BPM (extracted from composition state)
  double bpm() const;
  void set_bpm(double bpm);

private:
  mutable std::mutex mutex_;
  std::vector<CachedClip> clips_;
  double bpm_ = 120.0;

  static int channel_from_clip(const resolume::Clip& clip);
};

} // namespace bridge
