#include "video_pump.h"

#include <cstdio>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <set>
#include <thread>

#include "gpu/gpu_backend.h"
#include "media_fetch.h"
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

/**
 * Async mode's decode thread, one per clip. It opens the source (a media fetch
 * and an AVFoundation open can take a while) and then prepares whichever frames
 * the render thread last asked for, in its priority order — the pull first,
 * then read-ahead. The render thread uploads what it finds in `done`.
 *
 * The source is the worker's until `opened` is seen under the lock; from then
 * on the render thread may read its (immutable) shape and call upload(), while
 * only this thread calls prepare().
 */
struct VideoPump::Worker {
  std::string url;
  std::string mediaBase;

  std::mutex mu;
  std::condition_variable cv;
  // render → worker
  std::vector<int> wanted;
  bool stop = false;
  // worker → render
  bool opened = false;
  bool failed = false;
  bool finished = false;
  std::string error;
  std::unique_ptr<FrameSource> source;
  std::vector<std::unique_ptr<DecodedFrame>> done;
  std::set<int> doneIdx;     ///< frames in `done`, not yet taken
  std::set<int> badFrames;   ///< prepare() failed: never retried (no spin)
  std::thread th;

  /// First wanted frame not already prepared. Caller holds `mu`.
  int next() const {
    for (int f : wanted) {
      if (!doneIdx.count(f) && !badFrames.count(f)) return f;
    }
    return -1;
  }

  void run() {
    std::string why;
    const std::string path = localMediaPath(url, mediaBase, &why);
    std::unique_ptr<FrameSource> src = path.empty() ? nullptr : openFrameSource(path, &why);
    {
      std::lock_guard<std::mutex> lk(mu);
      if (!src) {
        failed = true;
        error = why;
        finished = true;
        return;
      }
      source = std::move(src);
      opened = true;
    }
    for (;;) {
      int f;
      {
        std::unique_lock<std::mutex> lk(mu);
        cv.wait(lk, [&] { return stop || next() >= 0; });
        if (stop) break;
        f = next();
      }
      auto df = source->prepare(f);
      std::lock_guard<std::mutex> lk(mu);
      if (df) {
        doneIdx.insert(f);
        done.push_back(std::move(df));
      } else {
        badFrames.insert(f);
      }
    }
    std::lock_guard<std::mutex> lk(mu);
    finished = true;
  }

  void requestStop() {
    {
      std::lock_guard<std::mutex> lk(mu);
      stop = true;
    }
    cv.notify_all();
  }
};

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
  bool transport = false;  ///< driven by the times channel, not `loop`
  double fps = 30;
  int durationFrames = 0;
  double descFps = 0;
  int descFrames = 0;
  BlitFit fit = BlitFit::Fit;
  BlitTransform transform;
  comp::ClipLoopConfig loop;

  // --- decode state ---
  /// Sync mode: owned here. Async mode: owned by `worker`, null until it opens.
  std::unique_ptr<FrameSource> ownSource;
  FrameSource* source = nullptr;
  std::unique_ptr<Worker> worker;
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
  int lastStride = 0;  ///< the last pull's stride (the cost tracker's input)
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
    if (c->worker) retire(std::move(c->worker));
  }
  for (auto& w : retiring_) {
    if (w->th.joinable()) w->th.join();
  }
}

void VideoPump::retire(std::unique_ptr<Worker> w) {
  w->requestStop();
  retiring_.push_back(std::move(w));
}

void VideoPump::reapRetired() {
  // Join only the ones already done: an in-flight seek or media fetch must not
  // stall the render thread. The source is destroyed HERE, on the render
  // thread, since a DXV source releases GPU objects.
  for (auto it = retiring_.begin(); it != retiring_.end();) {
    bool finished;
    {
      std::lock_guard<std::mutex> lk((*it)->mu);
      finished = (*it)->finished;
    }
    if (!finished) { ++it; continue; }
    if ((*it)->th.joinable()) (*it)->th.join();
    it = retiring_.erase(it);
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
    if (it->second->worker) retire(std::move(it->second->worker));
    it = clips_.erase(it);
  }

  for (const auto& d : descs) {
    if (!d.is_object() || !d.contains("clipId")) continue;
    const std::string clipId = d["clipId"].get<std::string>();

    auto it = clips_.find(clipId);
    if (it == clips_.end()) {
      const std::string url = d.value("url", std::string());
      // Known-unsupported — unless its source changed (a relink), which gets a
      // fresh attempt, as the web's failedAt does.
      if (skipped_.count(clipId)) {
        if (skippedUrl_[clipId] == url) continue;
        skipped_.erase(clipId);
      }
      skippedUrl_[clipId] = url;
      auto c = std::make_unique<Clip>();
      c->clipId = clipId;
      c->url = url;
      if (c->url.empty()) {
        skipped_[clipId] = "no locatable media (see comp_media_resolver.h)";
        continue;
      }
      if (cfg_.async) {
        // Opened on the clip's decode thread; until then it isn't ready.
        c->worker = std::make_unique<Worker>();
        c->worker->url = c->url;
        c->worker->mediaBase = mediaBase_;
        Worker* w = c->worker.get();
        w->th = std::thread([w] { w->run(); });
      } else {
        std::string why;
        const std::string path = localMediaPath(c->url, mediaBase_, &why);
        if (!path.empty()) c->ownSource = openFrameSource(path, &why);
        if (!c->ownSource) {
          markSkipped(clipId, why);
          continue;
        }
        c->source = c->ownSource.get();
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
    c.transport = d.value("transport", false);
    c.fit = blitFitFromString(d.value("scaleMode", std::string("fit")));
    c.transform = transformFrom(d.contains("transform") ? d["transform"] : nlohmann::json());
    c.loop = comp::ClipLoopConfig::fromJson(d.contains("loop") ? d["loop"] : nlohmann::json());
    // The document's probed rate wins (as on web), then the container's — DXV
    // doesn't parse its own (see DxvVideoInfo::fps) — then 30.
    const double descFps = d.contains("fps") && d["fps"].is_number() ? d["fps"].get<double>() : 0;
    c.descFps = d.contains("fps") && d["fps"].is_number() ? d["fps"].get<double>() : 0;
    c.descFrames = d.contains("durationFrames") && d["durationFrames"].is_number()
                       ? d["durationFrames"].get<int>() : 0;
    applySourceShape(c);
  }

  skippedActive_.clear();
  for (const auto& id : live) {
    if (skipped_.count(id)) skippedActive_.push_back(id);
  }
}

void VideoPump::applySourceShape(Clip& c) {
  // The document's probed rate wins (as on web), then the container's — DXV
  // doesn't parse its own (see DxvVideoInfo::fps) — then 30.
  const double srcFps = c.source ? c.source->fps() : 0;
  c.fps = c.descFps > 0 ? c.descFps : srcFps > 0 ? srcFps : 30.0;
  // Trust the FILE's frame count over the document's — a stale durationFrames
  // would index past the end of the frame table.
  const int srcFrames = c.source ? c.source->frameCount() : 0;
  c.durationFrames = srcFrames > 0 ? srcFrames : c.descFrames;
}

void VideoPump::markSkipped(const std::string& clipId, const std::string& why) {
  skipped_[clipId] = why;
  fprintf(stderr, "[video_pump] can't decode clip %s (%s): %s\n", clipId.c_str(),
          skippedUrl_[clipId].c_str(), why.c_str());
}

int32_t VideoPump::uploadPrepared(Clip& c, const DecodedFrame& df, bool precache) {
  if (c.cache->has(df.index)) return -1;  // a pull decoded it meanwhile
  const auto t0 = std::chrono::steady_clock::now();
  const int32_t tex = c.cache->reserve(df.index, (int)c.source->width(),
                                       (int)c.source->height(), c.source->formatCode());
  if (tex < 0) return -1;
  // A failed upload leaves the entry reserved but never ready: never served.
  if (!c.source->upload(backend_, df, tex)) return -1;
  c.cache->markReady(df.index);
  const double uploadMs =
      std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();

  CostPullOpts opts;
  // Prefetches contribute at "seek" rate: their stride isn't the live one and
  // we don't want them dominating the contiguous-decode bucket (the web
  // service passes stride 0 for exactly this reason).
  opts.stride = precache ? 0 : c.lastStride;
  opts.decodeMs = df.prepareMs + uploadMs;
  opts.hasPayloadBytes = df.payloadBytes > 0;
  opts.payloadBytes = df.payloadBytes;
  c.cost.recordPull(opts);

  c.tel.decodes++;
  totalDecodes_++;
  if (precache) {
    c.tel.precacheDecodes++;
    c.precached.push_back(df.index);
  }
  return tex;
}

bool VideoPump::syncWorker(Clip& c, std::vector<std::string>* failed) {
  Worker& w = *c.worker;
  std::vector<std::unique_ptr<DecodedFrame>> done;
  {
    std::lock_guard<std::mutex> lk(w.mu);
    if (w.failed) {
      failed->push_back(c.clipId);
      markSkipped(c.clipId, w.error);
      return false;
    }
    if (!w.opened) return false;
    if (!c.source) {
      c.source = w.source.get();
      applySourceShape(c);
    }
    done.swap(w.done);
    w.doneIdx.clear();
  }
  for (const auto& df : done) uploadPrepared(c, *df, df->index != c.lastPulledFrame);
  return true;
}

void VideoPump::postWanted(Clip& c, const std::vector<int>& frames) {
  std::vector<int> wanted;
  for (int f : frames) {
    if (f >= 0 && f < c.durationFrames && !c.cache->has(f)) wanted.push_back(f);
  }
  Worker& w = *c.worker;
  {
    std::lock_guard<std::mutex> lk(w.mu);
    if (w.wanted == wanted) return;
    w.wanted = std::move(wanted);
  }
  w.cv.notify_one();
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
    c.lastStride = stride;
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
  // Async: the decode thread has been asked (postWanted); it lands later.
  if (c.worker) return -1;

  const auto df = c.source->prepare(frame);
  if (!df) return -1;
  return uploadPrepared(c, *df, /*precache=*/!pull);
}

void VideoPump::present(Clip& c, int frame, int32_t srcTex) {
  // Dedupe on the presented frame: a held or paused frame repeats, and
  // re-blitting it would burn a dispatch and a fresh telemetry sample for
  // pixels the executor already has.
  if (frame == c.lastPresentedFrame) return;
  if (!c.blitter.blit(backend_, srcTex, (int)c.source->width(), (int)c.source->height(),
                      c.presentTex, cfg_.renderW, cfg_.renderH, c.fit, c.transform,
                      cfg_.logicalW, cfg_.logicalH)) {
    return;
  }
  c.lastPresentedFrame = frame;
  c.tel.injects++;
  totalInjects_++;
  if (inject_) inject_(c.instanceKey, c.presentTex);
  if (ready_) ready_(c.clipId, true);
}

int VideoPump::pump(double beat, double bpm) {
  int presented = 0;
  // Nothing here can decode these: ready with nothing bound (transparent), so
  // the Precise gate doesn't wait on a frame that will never come.
  if (ready_) for (const auto& id : skippedActive_) ready_(id, true);
  const comp::WarpClock clock(comp::WarpCurve(), bpm > 1 ? bpm : 120.0);

  reapRetired();
  std::vector<std::string> failed;

  for (auto& [id, cp] : clips_) {
    Clip& c = *cp;
    c.pullClockMs += 1000.0 / 60.0;  // a fixed-step pseudo-clock: see the header
    // Async: take what the decode thread finished. Still opening → not ready
    // (the web's "opening" pump), so Precise waits for the first frame.
    if (c.worker && !syncWorker(c, &failed)) {
      if (ready_ && std::find(failed.begin(), failed.end(), id) == failed.end()) ready_(id, false);
      continue;
    }

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

    std::optional<int32_t> frame;
    bool driven = false;
    if (c.transport && transport_) {
      // Transport-DRIVEN: the pre-pass's published time IS the target
      // (video-compositor.ts targetSecFor). An invalid row — the controller
      // instance isn't live yet — falls back to the ClipLoopConfig below for
      // this frame; an inactive one is transparent.
      const TransportTime t = transport_(c.clipId);
      if (t.valid) {
        driven = true;
        if (t.active && c.durationFrames > 0) {
          const double f = std::floor(t.timeSec * c.fps);
          frame = (int32_t)std::clamp(f, 0.0, (double)(c.durationFrames - 1));
        }
      }
    }
    if (!driven) frame = comp::clipSourceFrameAt(c.loop, ctx, at, c.fps, c.durationFrames);
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
    if (tex >= 0) {
      present(c, *frame, tex);
      presented++;
    }
    std::vector<int> wanted;
    if (c.worker) {
      // Ready = this frame is the one bound (clipReady on web). A miss keeps the
      // previous frame on screen and asks the decode thread, pull first.
      if (ready_) ready_(id, c.lastPresentedFrame == *frame);
      if (tex < 0) wanted.push_back(*frame);
    } else if (tex < 0) {
      continue;
    }

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
      for (int t : computeReadAheadTargets(inp)) {
        if (c.worker) wanted.push_back(t);
        else fetch(c, t, /*pull=*/false);
      }
    }
    if (c.worker) postWanted(c, wanted);
  }

  // Opens that failed: skipped from here on, exactly like a sync open failure.
  for (const auto& id : failed) {
    auto it = clips_.find(id);
    if (it == clips_.end()) continue;
    if (it->second->presentTex >= 0 && backend_) backend_->release(it->second->presentTex);
    it->second->cache->clear();
    retire(std::move(it->second->worker));
    clips_.erase(it);
    skippedActive_.push_back(id);
    if (ready_) ready_(id, true);
  }
  return presented;
}

std::map<std::string, int> VideoPump::presentedFrames() const {
  std::map<std::string, int> out;
  for (const auto& [id, cp] : clips_) {
    if (cp->lastPresentedFrame >= 0) out[id] = cp->lastPresentedFrame;
  }
  return out;
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
