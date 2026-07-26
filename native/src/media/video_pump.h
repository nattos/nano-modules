// video_pump.h — the native decode pump for composition video clips.
//
// The twin of web/src/views/arrangement/engine/video-compositor.ts + the
// random-access half of video/playback-service.ts. `comp::CompExecutor` never
// decodes: it publishes a desc set (`videoDescsJson`) and blocks on
// `setVideoReady(clipId, ready)`. This is the host side of that contract.
//
// Per active clip, per frame:
//   desc + beat → source frame index   (comp/clip_time.h, shared with web)
//   frame index → cached texture       (media/frame_cache_policy.h)
//   miss        → DxvSource decode     (media/dxv_source.h)
//   read-ahead  → precache targets     (media/read_ahead.h)
//   present     → placement blit       (media/frame_blitter.h)
//               → executor slot 0 + setVideoReady
//
// Decode is SYNCHRONOUS here. Web decodes off the render thread because it must
// not stall a live rAF loop; the native consumers are the fixed-step scenario
// runner and the offline exporter, where a frame that isn't ready yet is a
// determinism bug rather than a dropped frame. The policy headers are shared
// with web regardless, so hit rate and precache depth stay comparable.
//
// SCOPE: DXV only, and only the built-in play modes. A non-DXV source or a
// transport-DRIVEN clip is skipped and never reports ready — loudly, via
// `skipped()`, so a test can say so by name instead of silently rendering a
// hole. (AVFoundation and the transport channel are the follow-ups.)
//
// HOST ONLY. Never include from src/sketch/comp/.

#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "access_classifier.h"
#include "cost_tracker.h"
#include "dxv_source.h"
#include "frame_blitter.h"
#include "frame_cache_policy.h"
#include "read_ahead.h"

namespace gpu { class GPUBackend; }

namespace nano_media {

/// Per-clip counters the perf regression suite compares across hosts.
struct ClipTelemetry {
  int cacheHits = 0;
  int cacheMisses = 0;
  int decodes = 0;
  int precacheDecodes = 0;   ///< decodes issued by read-ahead, not by a pull
  int precacheHits = 0;      ///< pulls served by a frame read-ahead had queued
  int seeks = 0;             ///< pulls whose stride wasn't +1
  int injects = 0;           ///< distinct frames pushed to the executor
  double meanDecodeMs = 0;
  double seekDecodeMs = 0;
  std::string costClass = "Unknown";
  std::string accessMode = "Sequential";
  int cachedFrames = 0;
  int64_t cacheBytes = 0;
};

class VideoPump {
 public:
  struct Config {
    /// Size of the injected frame — the composition render size.
    int renderW = 0;
    int renderH = 0;
    /// The size ScaleMode::None reasons about (the composition resolution).
    int logicalW = 0;
    int logicalH = 0;
    /// Per-clip frame-cache budget. Matches FrameCache's web-side default so
    /// residency (and therefore hit rate) is comparable between the hosts.
    int64_t cacheBudgetBytes = 256ll * 1024 * 1024;
    /// Frames to precache per pull. 0 disables read-ahead — which is how the
    /// perf suite proves the hit-rate gate actually bites.
    int readAheadDepth = kReadAheadDepth;
  };

  VideoPump(gpu::GPUBackend* backend, const Config& cfg);
  ~VideoPump();

  /// Bind the frame into an instance's input slot 0 (SketchExecutor::
  /// setInjectedTexture) and report readiness (CompExecutor::setVideoReady).
  void setInjectSink(std::function<void(const std::string& instanceKey, int32_t tex)> fn) {
    inject_ = std::move(fn);
  }
  void setReadySink(std::function<void(const std::string& clipId, bool ready)> fn) {
    ready_ = std::move(fn);
  }

  /**
   * Reconcile against comp's desc set. Clips that left it are torn down (and
   * unbound), new ones are opened. Call whenever `kCompVideoSetChanged` rides a
   * frame — reconciling every frame also works, it just re-parses.
   */
  void setActiveClips(const nlohmann::json& descs);

  /**
   * Decode + present every active clip at `beat`. Returns the number of clips
   * that presented a frame this call.
   */
  int pump(double beat, double bpm);

  /// Clip ids skipped because nothing here can decode them, with the reason.
  const std::map<std::string, std::string>& skipped() const { return skipped_; }

  /// Per-clip telemetry, keyed by clip id.
  std::map<std::string, ClipTelemetry> telemetry() const;

  /// Frames whose decode this pump has performed, across all clips.
  int totalDecodes() const { return totalDecodes_; }

 private:
  struct Clip;

  /// Decode `frame` into the cache and return its texture handle, or -1.
  /// `pull` distinguishes a sink request (counts hits/misses, feeds the
  /// classifier) from a read-ahead prefetch (must not pollute either).
  int32_t fetch(Clip& c, int frame, bool pull);
  void present(Clip& c, int frame, int32_t srcTex);

  gpu::GPUBackend* backend_ = nullptr;
  Config cfg_;
  std::function<void(const std::string&, int32_t)> inject_;
  std::function<void(const std::string&, bool)> ready_;

  std::map<std::string, std::unique_ptr<Clip>> clips_;
  std::map<std::string, std::string> skipped_;
  int totalDecodes_ = 0;
};

}  // namespace nano_media
