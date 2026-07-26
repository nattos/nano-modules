// frame_cache_policy.h — the frame cache's residency + eviction policy.
//
// LOCK-STEP: web/src/video/frame-cache.ts. Shared goldens:
// web/src/video/video-policy-goldens.test.ts ↔ native/tests/test_video_policy.cpp.
// Only the POLICY is twinned — which frame gets evicted when, and what the
// hit/miss accounting says. Texture allocation is delegated to the host
// (`TexturePool`), exactly as the TS side delegates to `GpuHostLike`, so this
// header stays free of GPU types and testable without a device.
//
// Two sets: a **pinned** set (frames the access mode says we should hold
// indefinitely — loop range, hot frames) and an **LRU** set (recently-presented
// frames). Together they share a byte budget; eviction is LRU-first, with
// pinned-oldest as a last resort if pinned alone exceeds the budget.
//
// ORDER NOTE: entries live in a vector because the TS twin's Map iterates in
// INSERTION order, and `clear()` releases in that order. Eviction sorts by a
// strictly-increasing access ticker, so that ordering is total either way.

#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace nano_media {

/// Just the bits of the GPU host the cache touches.
struct TexturePool {
  virtual ~TexturePool() = default;
  virtual int createTexture(int width, int height, int formatCode) = 0;
  virtual void release(int handle) = 0;
};

/// Bytes per pixel for the texture formats the cache allocates. Matches the
/// codes accepted by GPUHost.createTexture (gpu-host.ts) / the Metal backend.
inline int formatBytesPerPixel(int formatCode) {
  switch (formatCode) {
    case 0: return 4;   // BGRA8
    case 1: return 4;   // RGBA8
    case 2: return 4;   // Surface (rgba8unorm/bgra8unorm — assume 4)
    case 3: return 8;   // RGBA16F
    case 4: return 4;   // R32F
    case 5: return 16;  // RGBA32F
    default: return 4;
  }
}

struct FrameCacheStats {
  /// Total bytes resident across both sets.
  int64_t bytes = 0;
  /// Distinct frames cached.
  int entries = 0;
  /// Cumulative hits / misses since the last resetStats().
  int hits = 0;
  int misses = 0;
  /// Cumulative hits / (hits + misses); 0 when both are 0.
  double hitRate = 0;
  /// Hits / misses observed in the last `recentWindowMs` of wall-clock time.
  /// The live, "how are we doing right now" view.
  int recentHits = 0;
  int recentMisses = 0;
  double recentHitRate = 0;
  /// True if a pinned entry was evicted to honor the budget. Sticky until
  /// resetStats(); the playback service surfaces this to downgrade caching
  /// aggressiveness for one cycle.
  bool pinnedEvicted = false;
};

class FrameCachePolicy {
 public:
  /// `now` is injectable so tests (and the goldens) stay deterministic.
  FrameCachePolicy(TexturePool* pool, int64_t budgetBytes = 256ll * 1024 * 1024,
                   std::function<double()> now = nullptr, double recentWindowMs = 1000)
      : pool_(pool), budgetBytes_(budgetBytes), now_(std::move(now)),
        recentWindowMs_(recentWindowMs) {}

  /// Returns the existing handle for `frameIdx` if cached, else -1. Counts as a
  /// sink request — records a hit/miss (cumulative + window) and bumps the LRU
  /// position. Internal callers that only want to peek (prefetch scheduling)
  /// must use `has()` instead so they don't pollute the stats.
  int lookup(int frameIdx) {
    Entry* e = find(frameIdx);
    // A reserved-but-not-yet-decoded entry is still black — treat it as a miss
    // so the caller awaits the in-flight decode rather than serving garbage.
    const bool ready = e != nullptr && e->ready;
    recordEvent(ready);
    if (!ready) { misses_++; return -1; }
    hits_++;
    e->lastAccessedMs = ++accessTicker_;
    return e->textureHandle;
  }

  /// Presence check that records nothing and doesn't touch LRU order.
  bool has(int frameIdx) const { return find(frameIdx) != nullptr; }

  /// Allocate (or recycle) a texture for `frameIdx`. Returns the new handle;
  /// the caller writes pixels into it. If `frameIdx` is already cached this
  /// returns the existing handle without reallocating.
  int reserve(int frameIdx, int width, int height, int formatCode) {
    if (Entry* existing = find(frameIdx)) {
      existing->lastAccessedMs = ++accessTicker_;
      return existing->textureHandle;
    }
    const int64_t sizeBytes = (int64_t)width * height * formatBytesPerPixel(formatCode);
    ensureRoomFor(sizeBytes);
    const int handle = pool_ ? pool_->createTexture(width, height, formatCode) : -1;
    entries_.push_back({frameIdx, handle, sizeBytes, ++accessTicker_, false});
    bytesUsed_ += sizeBytes;
    return handle;
  }

  /// Mark a reserved entry's pixels valid — call once the decode that filled
  /// its texture has completed. No-op if the entry was evicted meanwhile.
  void markReady(int frameIdx) {
    if (Entry* e = find(frameIdx)) e->ready = true;
  }

  /// Replace the pinned set wholesale. Frames removed from it drop to LRU
  /// (still cached, just evictable); frames newly in it become non-evictable
  /// until LRU is exhausted.
  void setPinned(const std::vector<int>& frames) {
    pinned_.assign(frames.begin(), frames.end());
    std::sort(pinned_.begin(), pinned_.end());
    pinned_.erase(std::unique(pinned_.begin(), pinned_.end()), pinned_.end());
  }

  bool isPinned(int frameIdx) const {
    return std::binary_search(pinned_.begin(), pinned_.end(), frameIdx);
  }

  FrameCacheStats stats() {
    const int total = hits_ + misses_;
    pruneEvents(nowMs());
    FrameCacheStats s;
    for (const auto& e : events_) {
      if (e.hit) s.recentHits++; else s.recentMisses++;
    }
    const int recentTotal = s.recentHits + s.recentMisses;
    s.bytes = bytesUsed_;
    s.entries = (int)entries_.size();
    s.hits = hits_;
    s.misses = misses_;
    s.hitRate = total == 0 ? 0 : (double)hits_ / (double)total;
    s.recentHitRate = recentTotal == 0 ? 0 : (double)s.recentHits / (double)recentTotal;
    s.pinnedEvicted = pinnedEvicted_;
    return s;
  }

  /// Frame indices currently resident (any set), ascending.
  std::vector<int> cachedFrameIndices() const {
    std::vector<int> out;
    for (const auto& e : entries_) out.push_back(e.frameIdx);
    std::sort(out.begin(), out.end());
    return out;
  }

  /// Frame indices currently in the pinned set (already sorted).
  const std::vector<int>& pinnedFrameIndices() const { return pinned_; }

  void resetStats() {
    hits_ = misses_ = 0;
    events_.clear();
    pinnedEvicted_ = false;
  }

  /// Drop all entries, release every texture.
  void clear() {
    if (pool_) for (const auto& e : entries_) pool_->release(e.textureHandle);
    entries_.clear();
    pinned_.clear();
    bytesUsed_ = 0;
    hits_ = misses_ = 0;
    events_.clear();
    pinnedEvicted_ = false;
  }

  /// Bytes resident — exposed for the playback service's debug snapshot.
  int64_t currentBytes() const { return bytesUsed_; }

 private:
  struct Entry {
    int frameIdx;
    int textureHandle;
    int64_t sizeBytes;
    double lastAccessedMs;
    /// False between reserve() and the decode writing real pixels in. A
    /// not-ready entry must never be served as a cache hit (it's still black)
    /// nor evicted (its decode is writing into it).
    bool ready;
  };
  struct CacheEvent { double t; bool hit; };

  Entry* find(int frameIdx) {
    for (auto& e : entries_) if (e.frameIdx == frameIdx) return &e;
    return nullptr;
  }
  const Entry* find(int frameIdx) const {
    for (const auto& e : entries_) if (e.frameIdx == frameIdx) return &e;
    return nullptr;
  }

  double nowMs() const { return now_ ? now_() : 0.0; }

  void recordEvent(bool hit) {
    events_.push_back({nowMs(), hit});
    // Safety cap for the case where stats() isn't called for a long time.
    if (events_.size() > 4096) pruneEvents(nowMs());
  }

  void pruneEvents(double nowMsVal) {
    const double cutoff = nowMsVal - recentWindowMs_;
    std::size_t drop = 0;
    while (drop < events_.size() && events_[drop].t < cutoff) drop++;
    if (drop > 0) events_.erase(events_.begin(), events_.begin() + (long)drop);
  }

  // --- Internal: eviction ---

  void ensureRoomFor(int64_t extraBytes) {
    if (bytesUsed_ + extraBytes <= budgetBytes_) return;
    // Evict LRU entries (non-pinned) oldest-first until we fit.
    for (int idx : collectByAge(/*pinnedOnly=*/false)) {
      if (bytesUsed_ + extraBytes <= budgetBytes_) return;
      evict(idx);
    }
    // Still over budget? Pinned alone exceeds budget; force-evict pinned
    // oldest-first as a last resort.
    if (bytesUsed_ + extraBytes > budgetBytes_) {
      for (int idx : collectByAge(/*pinnedOnly=*/true)) {
        if (bytesUsed_ + extraBytes <= budgetBytes_) return;
        evict(idx);
        pinnedEvicted_ = true;
      }
    }
  }

  /// Frame indices ordered oldest → newest. Returns FRAME INDICES, not
  /// pointers: evicting mutates the entry vector.
  std::vector<int> collectByAge(bool pinnedOnly) const {
    std::vector<const Entry*> out;
    for (const auto& e : entries_) {
      // Never evict an entry whose decode is still in flight — its texture is
      // being written to right now; freeing it would corrupt the write.
      if (!e.ready) continue;
      if (isPinned(e.frameIdx) == pinnedOnly) out.push_back(&e);
    }
    std::sort(out.begin(), out.end(),
              [](const Entry* a, const Entry* b) { return a->lastAccessedMs < b->lastAccessedMs; });
    std::vector<int> idxs;
    idxs.reserve(out.size());
    for (const Entry* e : out) idxs.push_back(e->frameIdx);
    return idxs;
  }

  void evict(int frameIdx) {
    for (std::size_t i = 0; i < entries_.size(); i++) {
      if (entries_[i].frameIdx != frameIdx) continue;
      if (pool_) pool_->release(entries_[i].textureHandle);
      bytesUsed_ -= entries_[i].sizeBytes;
      entries_.erase(entries_.begin() + (long)i);
      return;
    }
  }

  TexturePool* pool_ = nullptr;
  int64_t budgetBytes_ = 0;
  std::function<double()> now_;
  double recentWindowMs_ = 1000;

  std::vector<Entry> entries_;
  std::vector<int> pinned_;

  int64_t bytesUsed_ = 0;
  int hits_ = 0;
  int misses_ = 0;
  bool pinnedEvicted_ = false;
  double accessTicker_ = 0;  // monotonic counter for ordering

  std::vector<CacheEvent> events_;
};

}  // namespace nano_media
