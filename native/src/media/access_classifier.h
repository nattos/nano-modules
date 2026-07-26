// access_classifier.h — infers a consumer's frame-pull pattern.
//
// LOCK-STEP: web/src/video/access-classifier.ts. Shared goldens:
// web/src/video/video-policy-goldens.test.ts ↔ native/tests/test_video_policy.cpp.
// Keep the two byte-parallel — the mode decides the cache policy, so a native
// pump that classifies differently caches differently and its hit rate stops
// being comparable to web's.
//
// One of seven mutually-exclusive modes describes the recent access stream;
// each maps to a distinct cache policy in the playback service.
//
//   Sequential — forward play; ring-cache the next K frames.
//   Reverse    — backward play; ring-cache the previous K frames.
//   Strided    — every Nth frame (thumbnail strip / fast-forward).
//   Loop       — periodic [A,B] range; pin the loop in cache.
//   Hotspots   — a few specific frames hit far more than others; pin them.
//   Scrub      — high stride variance with brief sequential bursts.
//   Random     — no detectable structure; just-in-time fetch only.
//
// Per pull: append to a 128-entry ring + update a time-decayed frame-frequency
// histogram. Every 16 pulls (or on a "shock" — a stride far outside recent
// norms) the classifier rescores all modes; a candidate mode only takes over
// the current if it beats it by a confidence margin AND wins two consecutive
// classifier runs (hysteresis prevents thrashing mid-scrub).
//
// ORDER NOTE: the TS histogram is a `Map`, which iterates in INSERTION order,
// and JS `Array.sort` is stable. Both matter — the min-weight eviction and the
// top-8 hotspot cut break ties by insertion order. This port keeps the entries
// in a vector for exactly that reason; don't "optimize" it into a hash map.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <string>
#include <vector>

namespace nano_media {

enum class AccessMode { Sequential, Reverse, Strided, Loop, Hotspots, Scrub, Random };

inline const char* accessModeName(AccessMode m) {
  switch (m) {
    case AccessMode::Sequential: return "Sequential";
    case AccessMode::Reverse: return "Reverse";
    case AccessMode::Strided: return "Strided";
    case AccessMode::Loop: return "Loop";
    case AccessMode::Hotspots: return "Hotspots";
    case AccessMode::Scrub: return "Scrub";
    case AccessMode::Random: return "Random";
  }
  return "Random";
}

inline AccessMode accessModeFromName(const std::string& s) {
  if (s == "Reverse") return AccessMode::Reverse;
  if (s == "Strided") return AccessMode::Strided;
  if (s == "Loop") return AccessMode::Loop;
  if (s == "Hotspots") return AccessMode::Hotspots;
  if (s == "Scrub") return AccessMode::Scrub;
  if (s == "Random") return AccessMode::Random;
  return AccessMode::Sequential;
}

struct ClassifierSnapshot {
  AccessMode mode = AccessMode::Sequential;
  /// [0..1]; for Random this is "how certain we are it's NOT structured."
  double confidence = 0;
  /// Filled for Strided. The dominant non-±1 stride.
  bool hasStride = false;
  int stride = 0;
  /// Filled for Loop. [A, B] of the looping range.
  bool hasLoopRange = false;
  int loopRangeA = 0;
  int loopRangeB = 0;
  /// Filled for Hotspots. Top frame indices in descending weight order.
  bool hasHotFrames = false;
  std::vector<int> hotFrames;
};

namespace classifier_detail {

inline constexpr std::size_t kRingMax = 128;
inline constexpr int kReclassifyEvery = 16;
inline constexpr std::size_t kHotHistCap = 64;
/// Half-life for the frame-frequency time decay, in ms.
inline constexpr double kHotHistHalfLifeMs = 5000.0;
/// Candidate must beat current by this confidence margin to challenge.
inline constexpr double kSwitchMargin = 0.15;
/// Min real-mode score; below this we fall through to Random.
inline constexpr double kModeFloor = 0.5;

inline double hotHistDecayK() {
  // TS: Math.LN2 / HOT_HIST_HALF_LIFE_MS.
  static const double k = std::log(2.0) / kHotHistHalfLifeMs;
  return k;
}

inline double stdev(const std::vector<double>& xs) {
  if (xs.empty()) return 0;
  double mean = 0;
  for (double x : xs) mean += x;
  mean /= (double)xs.size();
  double variance = 0;
  for (double x : xs) variance += (x - mean) * (x - mean);
  variance /= (double)xs.size();
  return std::sqrt(variance);
}

inline double median(std::vector<double> xs) {
  if (xs.empty()) return 0;
  std::sort(xs.begin(), xs.end());
  const std::size_t mid = xs.size() >> 1;
  return (xs.size() & 1) ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2.0;
}

/// Extras a scoring function fills in alongside its confidence.
struct ModeExtras {
  bool hasStride = false;
  int stride = 0;
  bool hasLoopRange = false;
  int loopRangeA = 0;
  int loopRangeB = 0;
  bool hasHotFrames = false;
  std::vector<int> hotFrames;
};

struct Scored {
  AccessMode mode;
  double score;
  ModeExtras extras;
};

}  // namespace classifier_detail

class AccessClassifier {
 public:
  /// Cold-start the mode from a persisted record (best-effort). The classifier
  /// will overwrite it on the next reclassify if reality disagrees.
  void seedFromPersisted(const ClassifierSnapshot& snap) {
    mode_ = snap.mode;
    confidence_ = snap.confidence;
    hasStride_ = snap.hasStride;
    stride_ = snap.stride;
    hasLoopRange_ = snap.hasLoopRange;
    loopA_ = snap.loopRangeA;
    loopB_ = snap.loopRangeB;
    hasHotFrames_ = snap.hasHotFrames;
    hotFrames_ = snap.hotFrames;
  }

  void recordPull(int frameIdx, double monoTimeMs) {
    // Dedupe consecutive same-frame pulls. They mean "still presenting this
    // frame" (e.g. a 60 Hz render loop reading a 30 fps playhead), not "the
    // sink wants a new frame" — feeding them in would inject stride-zero noise
    // that fools the classifier into Strided/Hotspots patterns the access
    // stream doesn't actually have.
    if (!ring_.empty() && ring_.back().frameIdx == frameIdx) {
      // Touch the freq-hist anyway so a *truly* held frame (the `hold`
      // controller) accumulates weight and is still detectable as Hotspots
      // over time. We just skip the ring/stride pipeline.
      updateFreqHist(frameIdx, monoTimeMs);
      return;
    }

    // Stride for shock detection (vs the previous pull's index).
    bool shock = false;
    if (!ring_.empty()) {
      const int prev = ring_.back().frameIdx;
      const double absStride = std::abs((double)(frameIdx - prev));
      if (absStride > recentMeanAbsStride_ * 4 && absStride > 4) shock = true;
      // EWMA the abs stride lightly so the shock threshold tracks reality.
      recentMeanAbsStride_ = 0.9 * recentMeanAbsStride_ + 0.1 * absStride;
    }

    ring_.push_back({frameIdx, monoTimeMs});
    if (ring_.size() > classifier_detail::kRingMax) ring_.erase(ring_.begin());

    updateFreqHist(frameIdx, monoTimeMs);
    totalPulls_++;

    if (shock || totalPulls_ % classifier_detail::kReclassifyEvery == 0) runClassifier();
  }

  ClassifierSnapshot snapshot() const {
    ClassifierSnapshot s;
    s.mode = mode_;
    s.confidence = confidence_;
    if (mode_ == AccessMode::Strided && hasStride_) { s.hasStride = true; s.stride = stride_; }
    if (mode_ == AccessMode::Loop && hasLoopRange_) {
      s.hasLoopRange = true;
      s.loopRangeA = loopA_;
      s.loopRangeB = loopB_;
    }
    if (mode_ == AccessMode::Hotspots && hasHotFrames_) {
      s.hasHotFrames = true;
      s.hotFrames = hotFrames_;
    }
    return s;
  }

  /// Direct mode read — convenience for the cache policy lookup.
  AccessMode mode() const { return mode_; }

  void reset() {
    ring_.clear();
    freqHist_.clear();
    mode_ = AccessMode::Sequential;
    confidence_ = 0;
    hasStride_ = hasLoopRange_ = hasHotFrames_ = false;
    stride_ = loopA_ = loopB_ = 0;
    hotFrames_.clear();
    hasCandidate_ = false;
    recentMeanAbsStride_ = 1;
    totalPulls_ = 0;
  }

 private:
  struct PullEntry { int frameIdx; double monoTimeMs; };
  struct FreqEntry { int frameIdx; double weight; double lastSeenMs; };

  // --- Internal: hot-frame histogram with time decay ---

  void updateFreqHist(int frameIdx, double nowMs) {
    using namespace classifier_detail;
    // Decay every entry to "now" so weights are comparable.
    for (auto& entry : freqHist_) {
      const double dt = nowMs - entry.lastSeenMs;
      if (dt > 0) entry.weight *= std::exp(-hotHistDecayK() * dt);
      entry.lastSeenMs = nowMs;
    }
    for (auto& entry : freqHist_) {
      if (entry.frameIdx == frameIdx) {
        entry.weight += 1;
        return;
      }
    }
    // Evict the lowest-weight entry if at cap. Strict `<` keeps the FIRST
    // minimum, matching the TS Map's insertion-ordered scan.
    if (freqHist_.size() >= kHotHistCap) {
      std::size_t minIdx = 0;
      double minWeight = freqHist_[0].weight;
      for (std::size_t i = 1; i < freqHist_.size(); i++) {
        if (freqHist_[i].weight < minWeight) { minWeight = freqHist_[i].weight; minIdx = i; }
      }
      freqHist_.erase(freqHist_.begin() + (long)minIdx);
    }
    freqHist_.push_back({frameIdx, 1.0, nowMs});
  }

  // --- Internal: classifier core ---

  void runClassifier() {
    using namespace classifier_detail;
    if (ring_.size() < 4) return;  // not enough signal yet
    const std::vector<double> strides = computeStrides();

    std::vector<Scored> scored;
    scored.push_back({AccessMode::Sequential, scoreSequential(strides), {}});
    scored.push_back({AccessMode::Reverse, scoreReverse(strides), {}});
    scored.push_back(scoreStrided(strides));
    scored.push_back(scoreLoop());
    scored.push_back(scoreHotspots());
    scored.push_back({AccessMode::Scrub, scoreScrub(strides), {}});

    AccessMode topMode = AccessMode::Random;
    double topScore = kModeFloor;  // anything below this falls through
    ModeExtras topExtras;
    for (const auto& s : scored) {
      if (s.score > topScore) { topScore = s.score; topMode = s.mode; topExtras = s.extras; }
    }

    // Same mode as before → just refresh confidence + extras.
    if (topMode == mode_) {
      confidence_ = topMode == AccessMode::Random ? 1 - maxOf(scored) : topScore;
      assignExtras(topMode, topExtras);
      hasCandidate_ = false;
      return;
    }

    // Different — compare against the CURRENT mode's score IN THIS WINDOW (not
    // its stale historical confidence). Otherwise a mode that locked in at
    // confidence=1.0 can never be unseated, no matter what the data shows now.
    const double currentNow = currentModeScore(scored, mode_);
    if (!(topScore > currentNow + kSwitchMargin)) {
      hasCandidate_ = false;
      return;
    }
    if (hasCandidate_ && candidateMode_ == topMode) {
      // Won two runs in a row → commit.
      mode_ = topMode;
      confidence_ = topScore;
      assignExtras(topMode, topExtras);
      hasCandidate_ = false;
    } else {
      candidateMode_ = topMode;
      hasCandidate_ = true;
    }
  }

  void assignExtras(AccessMode mode, const classifier_detail::ModeExtras& ex) {
    hasStride_ = mode == AccessMode::Strided && ex.hasStride;
    stride_ = hasStride_ ? ex.stride : 0;
    hasLoopRange_ = mode == AccessMode::Loop && ex.hasLoopRange;
    loopA_ = hasLoopRange_ ? ex.loopRangeA : 0;
    loopB_ = hasLoopRange_ ? ex.loopRangeB : 0;
    hasHotFrames_ = mode == AccessMode::Hotspots && ex.hasHotFrames;
    hotFrames_ = hasHotFrames_ ? ex.hotFrames : std::vector<int>();
  }

  static double maxOf(const std::vector<classifier_detail::Scored>& scored) {
    double m = 0;
    for (const auto& s : scored) if (s.score > m) m = s.score;
    return m;
  }

  static double currentModeScore(const std::vector<classifier_detail::Scored>& scored,
                                 AccessMode mode) {
    // Random's "score" in this window is the inverse of the strongest real
    // mode — we hold our position iff nothing else has substantially won.
    if (mode == AccessMode::Random) return 1 - maxOf(scored);
    for (const auto& s : scored) if (s.mode == mode) return s.score;
    return 0;
  }

  // --- Mode scoring (each returns [0..1] confidence) ---

  std::vector<double> computeStrides() const {
    std::vector<double> out;
    for (std::size_t i = 1; i < ring_.size(); i++) {
      out.push_back((double)(ring_[i].frameIdx - ring_[i - 1].frameIdx));
    }
    return out;
  }

  static double scoreSequential(const std::vector<double>& strides) {
    if (strides.empty()) return 0;
    int hits = 0;
    int resets = 0;  // backward jumps of meaningful magnitude
    for (double s : strides) {
      if (s == 1) hits++;
      else if (s < -4) resets++;
    }
    const double raw = (double)hits / (double)strides.size();
    // Each meaningful reset costs Sequential's score — pure-sequential play
    // doesn't have resets. ≥3 resets is loop-shaped, not sequential.
    const double penalty = std::min(0.6, resets * 0.2);
    return std::max(0.0, raw - penalty);
  }

  static double scoreReverse(const std::vector<double>& strides) {
    if (strides.empty()) return 0;
    int hits = 0;
    int resets = 0;  // forward jumps of meaningful magnitude
    for (double s : strides) {
      if (s == -1) hits++;
      else if (s > 4) resets++;
    }
    const double raw = (double)hits / (double)strides.size();
    const double penalty = std::min(0.6, resets * 0.2);
    return std::max(0.0, raw - penalty);
  }

  static classifier_detail::Scored scoreStrided(const std::vector<double>& strides) {
    using namespace classifier_detail;
    Scored r{AccessMode::Strided, 0, {}};
    if (strides.empty()) return r;
    // Insertion-ordered histogram (TS Map) — first-seen wins ties on `>`.
    std::vector<std::pair<double, int>> hist;
    for (double s : strides) {
      if (s == 1 || s == -1) continue;  // those are Sequential/Reverse
      bool found = false;
      for (auto& h : hist) {
        if (h.first == s) { h.second++; found = true; break; }
      }
      if (!found) hist.push_back({s, 1});
    }
    double bestStride = 0;
    int bestCount = 0;
    for (const auto& h : hist) {
      if (h.second > bestCount) { bestCount = h.second; bestStride = h.first; }
    }
    if (bestCount == 0) return r;
    r.score = (double)bestCount / (double)strides.size();
    r.extras.hasStride = true;
    r.extras.stride = (int)bestStride;
    return r;
  }

  classifier_detail::Scored scoreLoop() const {
    using namespace classifier_detail;
    Scored r{AccessMode::Loop, 0, {}};
    // Loop signature: ≥3 "resets" (frameIdx drops sharply), with the post-reset
    // starting points clustered AND the pre-reset peaks clustered. Between
    // resets the index should generally increase.
    if (ring_.size() < 12) return r;

    std::vector<std::size_t> resets;  // indices into ring_ where a reset starts
    for (std::size_t i = 1; i < ring_.size(); i++) {
      // Drop of at least 4 frames.
      if (ring_[i].frameIdx < ring_[i - 1].frameIdx - 4) resets.push_back(i);
    }
    if (resets.size() < 3) return r;

    // Collect (post-reset start, pre-reset peak, reset magnitude) per cycle.
    std::vector<double> starts, peaks, magnitudes;
    for (std::size_t k = 0; k < resets.size(); k++) {
      const std::size_t startIdx = resets[k];
      starts.push_back(ring_[startIdx].frameIdx);
      const std::size_t peakIdx = startIdx - 1;
      peaks.push_back(ring_[peakIdx].frameIdx);
      magnitudes.push_back((double)(ring_[peakIdx].frameIdx - ring_[startIdx].frameIdx));
    }
    // Reset magnitudes must cluster — that's what makes a periodic loop
    // distinguishable from random negative jumps that happen to repeat 3+
    // times by chance.
    double magMean = 0;
    for (double m : magnitudes) magMean += m;
    magMean /= (double)magnitudes.size();
    const double magStd = stdev(magnitudes);
    if (magMean <= 0 || magStd > magMean * 0.25) return r;
    // Starts and peaks must each individually cluster tightly. The denominator
    // is the *loop period* (mean magnitude), not the overall span — otherwise
    // wide-range patterns where each cycle sits at a different base trip the
    // threshold.
    const double startStd = stdev(starts);
    const double peakStd = stdev(peaks);
    const double tolerance = std::max(2.0, magMean * 0.1);
    if (startStd > tolerance || peakStd > tolerance) return r;
    // ≥3 clean cycles is enough to max-confidence a Loop classification — any
    // further cycles are extra confirmation but don't raise the bar.
    r.score = std::min(1.0, (double)resets.size() / 3.0);
    r.extras.hasLoopRange = true;
    r.extras.loopRangeA = (int)jsRound(median(starts));
    r.extras.loopRangeB = (int)jsRound(median(peaks));
    return r;
  }

  classifier_detail::Scored scoreHotspots() const {
    using namespace classifier_detail;
    Scored r{AccessMode::Hotspots, 0, {}};
    if (freqHist_.size() < 2) return r;
    double total = 0;
    std::vector<std::pair<int, double>> items;  // insertion order, as in TS
    for (const auto& e : freqHist_) {
      total += e.weight;
      items.push_back({e.frameIdx, e.weight});
    }
    if (total <= 0) return r;
    // STABLE sort: JS Array.prototype.sort is stable (ES2019+), so equal
    // weights keep insertion order and the top-8 cut is deterministic.
    std::stable_sort(items.begin(), items.end(),
                     [](const auto& a, const auto& b) { return b.second < a.second; });
    const std::size_t topN = std::min<std::size_t>(8, items.size());
    double topMass = 0;
    for (std::size_t i = 0; i < topN; i++) topMass += items[i].second;
    const double coverage = topMass / total;
    // Real hotspot patterns concentrate ≥75% of weight in the top-8 with each
    // hot frame visited multiple times. Random/uniform data trips the 60% bar
    // by chance on small samples, so we keep the bar higher AND require the top
    // frame to have weight ≥3 (otherwise nothing is truly "hot", it's just the
    // most-recent few unique entries).
    const double topWeight = topN > 0 ? items[0].second : 0;
    if (coverage < 0.75 || topWeight < 3) return r;
    r.score = coverage;
    r.extras.hasHotFrames = true;
    for (std::size_t i = 0; i < topN; i++) r.extras.hotFrames.push_back(items[i].first);
    return r;
  }

  static double scoreScrub(const std::vector<double>& strides) {
    using namespace classifier_detail;
    if (strides.size() < 8) return 0;
    // Loop has priority over Scrub: if the negative jumps (the resets) cluster
    // around one magnitude, this is loop-shaped, not scrub-shaped. Without this
    // check, Scrub commits at 2 cycles before Loop can hit its 3-cycle
    // threshold — and once Scrub is locked in, Loop can't beat it by the
    // hysteresis margin even when its score reaches 1.0.
    std::vector<double> resets;
    for (double s : strides) if (s < -4) resets.push_back(s);
    if (resets.size() >= 2) {
      double mean = 0;
      for (double s : resets) mean += s;
      mean /= (double)resets.size();
      if (stdev(resets) <= std::abs(mean) * 0.2) return 0;  // looks like a loop
    }

    // High stride variance + at least 2 BRIEF sequential bursts (≥3 +1s in a
    // row). A long run of +1s with one big negative jump (the first wrap of a
    // Loop, before there are enough cycles to detect Loop properly) trips this
    // gate otherwise — even though that's clearly not scrub-shaped. Cap the
    // longest burst length so the "first wraparound" case stays Sequential
    // until Loop catches up.
    const double variance = stdev(strides);
    if (variance < 3) return 0;  // too smooth → not scrub-like
    int bursts = 0;
    int run = 0;
    int longestBurst = 0;
    for (double s : strides) {
      if (s == 1) {
        run++;
        if (run == 3) bursts++;
        if (run > longestBurst) longestBurst = run;
      } else {
        run = 0;
      }
    }
    if (bursts < 2) return 0;
    // A "brief" burst is a UI-scrub-sized run — interactive drags rarely stay
    // on the slider for more than ~15 frames. Anything past that is
    // sequential-with-a-reset, not scrubbing.
    if (longestBurst > 20) return 0;
    // Confidence rises with both variance and burst count; cap at 1.
    return std::min(1.0, 0.55 + 0.1 * bursts + std::min(0.25, variance / 40));
  }

  /// Math.round: half rounds UP (toward +∞), unlike std::round's half-away.
  /// Only differs on negative halves, which loop bounds can be.
  static double jsRound(double x) { return std::floor(x + 0.5); }

  std::vector<PullEntry> ring_;
  std::vector<FreqEntry> freqHist_;

  AccessMode mode_ = AccessMode::Sequential;  // sensible cold-start default
  double confidence_ = 0;
  bool hasStride_ = false;
  int stride_ = 0;
  bool hasLoopRange_ = false;
  int loopA_ = 0, loopB_ = 0;
  bool hasHotFrames_ = false;
  std::vector<int> hotFrames_;

  // Hysteresis: a challenger must win two consecutive classifier runs to
  // unseat the current mode. We track "the candidate that won the LAST run";
  // if the same candidate wins the next run, it commits.
  bool hasCandidate_ = false;
  AccessMode candidateMode_ = AccessMode::Random;

  // Stats for "shock" detection — abrupt stride magnitude change suggests the
  // pattern has changed and we should re-classify NOW instead of waiting for
  // the 16-pull tick.
  double recentMeanAbsStride_ = 1;

  long long totalPulls_ = 0;
};

}  // namespace nano_media
