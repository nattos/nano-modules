#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "bridge/platform/mutex.h"

#include "resolume/composition.h"

namespace bridge {

struct CachedClip {
  int64_t clip_id = 0;
  std::string name;
  int channel = -1;           // -1=unassigned, 0-3
  bool connected = false;
  int64_t connected_param_id = 0;
  int32_t thumbnail_tex_id = -1;
  int layer_index = -1;       // 0-based position in the composition
  int clip_index = -1;        // 0-based position in the layer
  // Resolume WS "connect" (launch) action path, e.g.
  // "/composition/layers/0/clips/2/connect" — the target the ClipLauncher
  // triggers. Precomputed from the indices during rebuild.
  std::string connect_path;
  // The NanoLooper Ch marker's registered instance key (== its uuid, decoded
  // from the nanoch:// config blob), or "" if the clip has no marker. The web
  // renders this clip's live thumbnail under `inst_thumb:<marker_uuid>` and
  // requests it via `/plugins/<marker_uuid>/state`.
  std::string marker_uuid;
  // Cosmetic channel label from the marker's "Name" param (or blob), or "".
  std::string channel_name;
  // Resolume trigger style ("Piano"/"Normal"/... ; "" if unknown). A Piano clip
  // releases on connect:false; anything else is treated as Normal (ignores
  // connect:false — must be turned off by eviction). See ClipLauncher.
  std::string trigger_style;
  // A connect path to an EMPTY clip on the SAME layer, used to turn this clip
  // OFF by eviction (connecting another clip on a layer disconnects the current
  // one). "" if the layer has no empty clip. The style-independent "off" verb.
  std::string evict_path;
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
  mutable platform::Mutex mutex_;
  std::vector<CachedClip> clips_;
  double bpm_ = 120.0;

  // Resolve a clip's trigger channel (0-based) from a NanoLooper Ch marker, and
  // (optionally) the marker's registered uuid + cosmetic name. Returns -1 with
  // empty out-params if the clip carries no marker.
  static int channel_from_clip(const resolume::Clip& clip,
                               std::string* out_uuid = nullptr,
                               std::string* out_name = nullptr);
};

} // namespace bridge
