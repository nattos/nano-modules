// cost_tracker.h — source-side timing profile for one video source.
//
// LOCK-STEP: web/src/video/cost-tracker.ts. Shared goldens:
// web/src/video/video-policy-goldens.test.ts ↔ native/tests/test_video_policy.cpp.
//
// Tracks EWMAs of frame decode time, seek decode time, first-byte read latency,
// and compressed payload size. Derives a coarse `CostClass` that the playback
// service uses to size its read-ahead window: a `FastRandom` source can satisfy
// random seeks cheaply, a `SlowSeek` source must cache aggressively because
// every miss is expensive.
//
// All math here is pure — no GPU, no IO.

#pragma once

#include <algorithm>
#include <string>

namespace nano_media {

enum class CostClass { FastRandom, SlowSeek, SlowDecode, Unknown };

inline const char* costClassName(CostClass c) {
  switch (c) {
    case CostClass::FastRandom: return "FastRandom";
    case CostClass::SlowSeek: return "SlowSeek";
    case CostClass::SlowDecode: return "SlowDecode";
    case CostClass::Unknown: return "Unknown";
  }
  return "Unknown";
}

struct CostSnapshot {
  /// EWMA of decode time on **contiguous** (stride=+1) pulls.
  double meanFrameDecodeMs = 0;
  /// EWMA of decode time on **non-contiguous** (seek) pulls.
  double seekDecodeMs = 0;
  /// Derived: seekDecodeMs − meanFrameDecodeMs (clamped ≥0).
  double seekPenaltyMs = 0;
  /// EWMA of time from the source's slice() call to first byte.
  double firstByteLatencyMs = 0;
  /// Running mean of compressed sample size.
  double payloadBytesPerFrame = 0;
  /// Count of pulls feeding the EWMAs.
  int samples = 0;
  /// Pulls observed with stride === +1 (contiguous decodes).
  int contiguousSamples = 0;
  /// Pulls observed with stride !== +1 — "the codec had to seek." On codecs
  /// where seek is expensive (h264 keyframe walk) this is the count of
  /// expensive operations. On DXV it's just "how often a jump happened" since
  /// seeks are free.
  int seekSamples = 0;
  CostClass costClass = CostClass::Unknown;
};

struct CostPullOpts {
  /// Frame-index delta from the previous pull. +1 for contiguous play.
  int stride = 0;
  /// Time from pull request to texture-ready (ms).
  double decodeMs = 0;
  /// Time from the slice() call to first byte (ms). Optional.
  bool hasFirstByteMs = false;
  double firstByteMs = 0;
  /// Compressed payload size for this frame (bytes). Optional.
  bool hasPayloadBytes = false;
  double payloadBytes = 0;
};

namespace cost_detail {

/// EWMA smoothing factor. 0.1 = ~10-sample half-life.
inline constexpr double kAlpha = 0.1;
/// Below this sample count we report `Unknown` and the service uses
/// conservative defaults.
inline constexpr int kMinSamplesForClass = 32;
/// When seeding from a persisted profile we cap the running sample count so a
/// few fresh observations can still nudge the EWMAs.
inline constexpr int kSeedSampleCap = 32;

inline double ewma(double prev, double next, bool isFirst) {
  return isFirst ? next : (kAlpha * next + (1 - kAlpha) * prev);
}

}  // namespace cost_detail

/// Cost classification logic, exposed for direct testing.
inline CostClass classifyCost(int samples, double meanDecode, double seekDecode) {
  if (samples < cost_detail::kMinSamplesForClass) return CostClass::Unknown;
  if (meanDecode > 50) return CostClass::SlowDecode;
  // When the contiguous-decode bucket is undersampled (which happens whenever
  // aggressive read-ahead keeps every sequential pull warm in the cache), fall
  // back to the seek bucket alone — it's the only signal we have about raw
  // decode cost.
  if (meanDecode == 0) {
    if (seekDecode == 0) return CostClass::Unknown;
    if (seekDecode > 50) return CostClass::SlowDecode;
    if (seekDecode < 10) return CostClass::FastRandom;
    return CostClass::SlowSeek;
  }
  const double penalty = std::max(0.0, seekDecode - meanDecode);
  // FastRandom requires BOTH cheap decode AND cheap seek.
  if (meanDecode < 10 && penalty < 2 * std::max(meanDecode, 1.0)) return CostClass::FastRandom;
  // Everything else (moderate decode, or large seek penalty) leans toward
  // aggressive caching — SlowSeek captures it. SlowDecode already
  // shortcircuited above.
  return CostClass::SlowSeek;
}

class CostTracker {
 public:
  /// Number of pulls observed since the last reset.
  int samples() const { return samples_; }
  int contiguousSamples() const { return contiguousSamples_; }
  int seekSamples() const { return seekSamples_; }

  /// Record one pull's timing. Seek vs contiguous is determined by
  /// `stride == 1`; everything else (including the first pull of a session
  /// where the caller passes stride=0) is treated as a seek.
  void recordPull(const CostPullOpts& opts) {
    using namespace cost_detail;
    if (opts.stride == 1) {
      meanDecode_ = ewma(meanDecode_, opts.decodeMs, !decodeSeeded_);
      decodeSeeded_ = true;
      contiguousSamples_++;
    } else {
      seekDecode_ = ewma(seekDecode_, opts.decodeMs, !seekSeeded_);
      seekSeeded_ = true;
      seekSamples_++;
    }
    if (opts.hasFirstByteMs) {
      firstByte_ = ewma(firstByte_, opts.firstByteMs, !firstByteSeeded_);
      firstByteSeeded_ = true;
    }
    if (opts.hasPayloadBytes) {
      payloadCount_++;
      payloadBytes_ += (opts.payloadBytes - payloadBytes_) / payloadCount_;
    }
    samples_++;
  }

  /// Seed from a persisted profile. Caps the sample count so subsequent live
  /// observations can still nudge the EWMAs. Only the EWMA fields are used —
  /// the per-bucket sub-counts aren't persisted and accumulate fresh.
  void seedFromPersisted(const CostSnapshot& snap) {
    meanDecode_ = snap.meanFrameDecodeMs;
    seekDecode_ = snap.seekDecodeMs;
    firstByte_ = snap.firstByteLatencyMs;
    payloadBytes_ = snap.payloadBytesPerFrame;
    payloadCount_ = snap.payloadBytesPerFrame > 0 ? 1 : 0;
    decodeSeeded_ = snap.meanFrameDecodeMs > 0;
    seekSeeded_ = snap.seekDecodeMs > 0;
    firstByteSeeded_ = snap.firstByteLatencyMs > 0;
    samples_ = std::min(snap.samples, cost_detail::kSeedSampleCap);
  }

  /// Resets all state. Used when a persisted profile is stale (>30 days).
  void reset() {
    meanDecode_ = seekDecode_ = firstByte_ = payloadBytes_ = 0;
    payloadCount_ = 0;
    decodeSeeded_ = seekSeeded_ = firstByteSeeded_ = false;
    samples_ = contiguousSamples_ = seekSamples_ = 0;
  }

  CostSnapshot snapshot() const {
    CostSnapshot s;
    s.meanFrameDecodeMs = meanDecode_;
    s.seekDecodeMs = seekDecode_;
    s.seekPenaltyMs = std::max(0.0, seekDecode_ - meanDecode_);
    s.firstByteLatencyMs = firstByte_;
    s.payloadBytesPerFrame = payloadBytes_;
    s.samples = samples_;
    s.contiguousSamples = contiguousSamples_;
    s.seekSamples = seekSamples_;
    s.costClass = classifyCost(samples_, meanDecode_, seekDecode_);
    return s;
  }

 private:
  double meanDecode_ = 0;
  double seekDecode_ = 0;
  double firstByte_ = 0;
  double payloadBytes_ = 0;
  double payloadCount_ = 0;
  // Per-bucket "have we seen at least one sample yet" flags. The first sample
  // into a bucket initializes the EWMA directly; subsequent samples smooth.
  // Tracking these per-bucket (rather than off the global sample count) is
  // essential — otherwise the first seek of a session smooths from 0 and takes
  // ~30 measurements to catch up.
  bool decodeSeeded_ = false;
  bool seekSeeded_ = false;
  bool firstByteSeeded_ = false;
  int samples_ = 0;
  int contiguousSamples_ = 0;
  int seekSamples_ = 0;
};

}  // namespace nano_media
