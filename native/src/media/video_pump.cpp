#include "video_pump.h"

#include <algorithm>
#include <cmath>

#include "gpu/gpu_backend.h"
#include "read_ahead.h"
#include "sketch/comp/clip_time.h"
#include "sketch/comp/comp_model.h"
#include "sketch/comp/warp_curve.h"

namespace nano_media {
namespace {

constexpr int32_t kFmtRGBA8 = 1;

/// Textures for the frame cache, allocated from the GPU backend.
struct BackendPool : TexturePool {
  gpu::GPUBackend* backend = nullptr;
  int32_t createTexture(int width, int height, int formatCode) override {
    return backend ? backend->createTexture((uint32_t)width, (uint32_t)height, formatCode) : -1;
  }
  void release(int handle) override {
    if (backend && handle >= 0) backend->release(handle);
  }
};

BlitTransform transformFrom(const nlohmann::json& j) {
  BlitTransform t;
  if (!j.is_object()) return t;
  t.anchorX = j.value("anchorX", 0.5);
  t.anchorY = j.value("anchorY", 0.5);
  t.scale = j.value("scale", 1.0);
  t.rotation = j.value("rotation", 0.0);
  t.flipH = j.value("flipH", false);
  t.flipV = j.value("flipV", false);
  return t;
}

}  // namespace

struct VideoPump::Clip {
  // --- desc (refreshed every reconcile; the pump keys off clipId) ---
  std::string clipId;
  std::string instanceKey;
  std::string url;
  double startBeat = 0;
  double lengthBeat = 0;
  bool hasHoldBeat = false;
  double holdBeat = 0;
  bool prime = false;
  double fps = 30;
  int durationFrames = 0;
  BlitFit fit = BlitFit::Fit;
  BlitTransform transform;
  comp::ClipLoopConfig loop;

  // --- decode state ---
  DxvSource source;
  BackendPool pool;
  std::unique_ptr<FrameCachePolicy> cache;
  CostTracker cost;
  AccessClassifier classifier;
  FrameBlitter blitter;

  /// The render-sized texture handed to the executor. Distinct from the cache
  /// entries, which hold SOURCE-sized decoded frames.
  int32_t presentTex = -1;
  int lastPresentedFrame = -1;
  int lastPulledFrame = -1;
  /// Sign of the most recent non-zero motion. Read-ahead follows THIS, not the
  /// classified mode, so an oscillating pattern stays ahead of the playhead
  /// through every reversal (see read-ahead.ts).
  int lastMotionDir = 1;
  /// Frames read-ahead has already decoded but no pull has claimed yet — the
  /// "did the precache actually help" measurement.
  std::vector<int> precached;

  double pullClockMs = 0;  ///< monotone pseudo-clock for the classifier/cache
  ClipTelemetry tel;
};

VideoPump::VideoPump(gpu::GPUBackend* backend, const Config& cfg)
    : backend_(backend), cfg_(cfg) {
  if (cfg_.logicalW <= 0) cfg_.logicalW = cfg_.renderW;
  if (cfg_.logicalH <= 0) cfg_.logicalH = cfg_.renderH;
}

VideoPump::~VideoPump() {
  for (auto& [id, c] : clips_) {
    if (c->presentTex >= 0 && backend_) backend_->release(c->presentTex);
    if (c->cache) c->cache->clear();
  }
}

void VideoPump::setActiveClips(const nlohmann::json& descs) {
  if (!descs.is_array()) return;

  // Tear down anything that left the set. Unbind FIRST: the executor must not
  // hold a handle into a cache we're about to release.
  std::vector<std::string> live;
  for (const auto& d : descs) {
    if (d.is_object() && d.contains("clipId")) live.push_back(d["clipId"].get<std::string>());
  }
  for (auto it = clips_.begin(); it != clips_.end();) {
    if (std::find(live.begin(), live.end(), it->first) != live.end()) { ++it; continue; }
    if (inject_) inject_(it->second->instanceKey, -1);
    if (ready_) ready_(it->first, false);
    if (it->second->presentTex >= 0 && backend_) backend_->release(it->second->presentTex);
    it->second->cache->clear();
    it = clips_.erase(it);
  }

  for (const auto& d : descs) {
    if (!d.is_object() || !d.contains("clipId")) continue;
    const std::string clipId = d["clipId"].get<std::string>();

    // Transport-DRIVEN clips follow a per-frame published times channel rather
    // than their ClipLoopConfig. Nothing here reads that channel yet, so say so
    // instead of pumping the wrong frame.
    if (d.value("transport", false)) {
      if (!skipped_.count(clipId)) skipped_[clipId] = "transport-driven clip (unsupported natively)";
      continue;
    }

    auto it = clips_.find(clipId);
    if (it == clips_.end()) {
      if (skipped_.count(clipId)) continue;  // already known-unsupported
      auto c = std::make_unique<Clip>();
      c->clipId = clipId;
      c->url = d.value("url", std::string());
      if (c->url.empty()) {
        skipped_[clipId] = "no locatable media (see comp_media_resolver.h)";
        continue;
      }
      if (!c->source.open(c->url)) {
        skipped_[clipId] = c->source.error();
        continue;
      }
      c->pool.backend = backend_;
      c->cache = std::make_unique<FrameCachePolicy>(
          &c->pool, cfg_.cacheBudgetBytes, [p = c.get()]() { return p->pullClockMs; }, 1000.0);
      c->presentTex = backend_->createTexture((uint32_t)cfg_.renderW, (uint32_t)cfg_.renderH,
                                              kFmtRGBA8);
      it = clips_.emplace(clipId, std::move(c)).first;
    }

    // Refresh the per-frame-mutable half of the desc every reconcile: a scene
    // relaunch moves startBeat, a param edit moves the loop or the placement.
    Clip& c = *it->second;
    c.instanceKey = d.value("instanceKey", std::string());
    c.startBeat = d.value("startBeat", 0.0);
    c.lengthBeat = d.value("lengthBeat", 0.0);
    c.hasHoldBeat = d.contains("holdBeat") && d["holdBeat"].is_number();
    c.holdBeat = c.hasHoldBeat ? d["holdBeat"].get<double>() : 0.0;
    c.prime = d.value("prime", false);
    c.fit = blitFitFromString(d.value("scaleMode", std::string("fit")));
    c.transform = transformFrom(d.contains("transform") ? d["transform"] : nlohmann::json());
    c.loop = comp::ClipLoopConfig::fromJson(d.contains("loop") ? d["loop"] : nlohmann::json());
    // The container's own rate isn't parsed natively (see DxvVideoInfo::fps);
    // the document's probed rate is the source of truth, then 30.
    const double descFps = d.contains("fps") && d["fps"].is_number() ? d["fps"].get<double>() : 0;
    c.fps = descFps > 0 ? descFps : 30.0;
    const int descFrames = d.contains("durationFrames") && d["durationFrames"].is_number()
                               ? d["durationFrames"].get<int>() : 0;
    // Trust the FILE's frame count over the document's — a stale durationFrames
    // would index past the end of the frame table.
    c.durationFrames = c.source.info().frameCount > 0 ? c.source.info().frameCount : descFrames;
  }
}

int32_t VideoPump::fetch(Clip& c, int frame, bool pull) {
  if (frame < 0 || frame >= c.durationFrames) return -1;

  // Frame-index delta from the previous PULL. 0 on the first pull of a session,
  // which the cost tracker treats as a seek (matching CostPullOpts.stride).
  int stride = 0;
  if (pull) {
    // The classifier and the cost tracker only ever see SINK requests — a
    // prefetch peek would inject stride noise the access stream doesn't have.
    c.classifier.recordPull(frame, c.pullClockMs);
    stride = c.lastPulledFrame < 0 ? 0 : frame - c.lastPulledFrame;
    if (stride != 1) c.tel.seeks++;
    if (stride != 0) c.lastMotionDir = stride < 0 ? -1 : 1;
    c.lastPulledFrame = frame;

    const auto pit = std::find(c.precached.begin(), c.precached.end(), frame);
    if (pit != c.precached.end()) {
      c.tel.precacheHits++;
      c.precached.erase(pit);
    }
    const int32_t hit = c.cache->lookup(frame);
    if (hit >= 0) {
      c.tel.cacheHits++;
      // A cache hit still costs the pipeline nothing to decode, so it feeds no
      // timing sample — matching the web service, which only records real pulls.
      return hit;
    }
    c.tel.cacheMisses++;
  } else if (c.cache->has(frame)) {
    return -1;  // already resident; nothing to precache
  }

  const uint32_t w = c.source.info().width;
  const uint32_t h = c.source.info().height;
  const int32_t tex = c.cache->reserve(frame, (int)w, (int)h, kFmtRGBA8);
  if (tex < 0) return -1;
  if (!c.source.decode(backend_, frame, tex)) return -1;
  c.cache->markReady(frame);

  CostPullOpts opts;
  // Prefetches contribute at "seek" rate: their stride isn't the live one and
  // we don't want them dominating the contiguous-decode bucket (the web
  // service passes stride 0 for exactly this reason).
  opts.stride = pull ? stride : 0;
  opts.decodeMs = c.source.lastDecodeMs();
  opts.hasPayloadBytes = true;
  opts.payloadBytes = c.source.frameSize(frame);
  c.cost.recordPull(opts);

  c.tel.decodes++;
  totalDecodes_++;
  if (!pull) {
    c.tel.precacheDecodes++;
    c.precached.push_back(frame);
  }
  return tex;
}

void VideoPump::present(Clip& c, int frame, int32_t srcTex) {
  // Dedupe on the presented frame: a held or paused frame repeats, and
  // re-blitting it would burn a dispatch and a fresh telemetry sample for
  // pixels the executor already has.
  if (frame == c.lastPresentedFrame) return;
  if (!c.blitter.blit(backend_, srcTex, (int)c.source.info().width, (int)c.source.info().height,
                      c.presentTex, cfg_.renderW, cfg_.renderH, c.fit, c.transform,
                      cfg_.logicalW, cfg_.logicalH)) {
    return;
  }
  c.lastPresentedFrame = frame;
  c.tel.injects++;
  if (inject_) inject_(c.instanceKey, c.presentTex);
  if (ready_) ready_(c.clipId, true);
}

int VideoPump::pump(double beat, double bpm) {
  int presented = 0;
  const comp::WarpClock clock(comp::WarpCurve(), bpm > 1 ? bpm : 120.0);

  for (auto& [id, cp] : clips_) {
    Clip& c = *cp;
    c.pullClockMs += 1000.0 / 60.0;  // a fixed-step pseudo-clock: see the header

    // Linger clamp: freeze the clock at the pass-end beat while this clip's
    // track has a pending handover (VideoClipDesc.holdBeat).
    double at = beat;
    if (c.hasHoldBeat && at > c.holdBeat) at = c.holdBeat;
    // A clip not yet reached targets its ENTRY frame, so a precache warms the
    // right place rather than chasing a future phase.
    const bool ahead = at < c.startBeat - 1e-6;
    if (ahead || c.prime) at = c.startBeat;

    comp::ClipTimeCtx ctx;
    ctx.startBeat = c.startBeat;
    ctx.lengthBeat = c.lengthBeat;
    ctx.videoDurSec = c.durationFrames / std::max(1.0, c.fps);
    ctx.clock = &clock;
    ctx.seed = comp::clipNoiseSeed(c.clipId);

    const auto frame = comp::clipSourceFrameAt(c.loop, ctx, at, c.fps, c.durationFrames);
    if (!frame) {
      // Off the slice (a one-shot before or after its span) → transparent, and
      // NOT ready: nothing should hold the transport waiting for it.
      if (c.lastPresentedFrame != -1) {
        c.lastPresentedFrame = -1;
        if (inject_) inject_(c.instanceKey, -1);
      }
      continue;
    }

    const int32_t tex = fetch(c, *frame, /*pull=*/true);
    if (tex < 0) continue;
    present(c, *frame, tex);
    presented++;

    // Read-ahead for the NEXT pulls, sized by the shared policy so the
    // precache depth is the same number web reports.
    if (cfg_.readAheadDepth > 0) {
      const ClassifierSnapshot snap = c.classifier.snapshot();
      c.cache->setPinned(computePinnedFrames(snap));
      ReadAheadInputs inp;
      inp.mode = snap.mode;
      inp.frameIdx = *frame;
      inp.frameCount = c.durationFrames;
      inp.motionDir = c.lastMotionDir;
      inp.depth = cfg_.readAheadDepth;
      inp.hasStride = snap.hasStride;
      inp.stride = snap.stride;
      for (int t : computeReadAheadTargets(inp)) fetch(c, t, /*pull=*/false);
    }
  }
  return presented;
}

std::map<std::string, ClipTelemetry> VideoPump::telemetry() const {
  std::map<std::string, ClipTelemetry> out;
  for (const auto& [id, cp] : clips_) {
    ClipTelemetry t = cp->tel;
    const CostSnapshot cs = cp->cost.snapshot();
    t.meanDecodeMs = cs.meanFrameDecodeMs;
    t.seekDecodeMs = cs.seekDecodeMs;
    t.costClass = costClassName(cs.costClass);
    t.accessMode = accessModeName(cp->classifier.snapshot().mode);
    t.cachedFrames = (int)cp->cache->cachedFrameIndices().size();
    t.cacheBytes = cp->cache->currentBytes();
    out[id] = t;
  }
  return out;
}

}  // namespace nano_media
