// comp_executor.cpp — see comp_executor.h. TS twins being inverted:
// engine-bridge.ts (showComposite / precise hold / pump reconcile shape),
// composite-frame.ts (videoDescFor), arrangement-app.ts (the gate-freezes-
// transport rule), executor-host.ts step 3 (producer-output mirror).

#include "comp_executor.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <functional>
#include <map>
#include <vector>

#include "../effrt.h"
#include "../exec_gpu.h"
#include "comp_eval.h"
#include "precise_gate.h"

#ifndef __wasm__
namespace sketch_executor {
// effrt_impls.cpp — bind the effrt forwarders to `rt` and reset the frame's
// handle table. The comp executor must call this BEFORE its published-output
// fold (which uses effrt_instance_for ahead of the internal execute()).
void effrtSetRuntime(effect_runtime::EffectRuntime* rt);
}  // namespace sketch_executor
namespace effect_runtime {
// host_impls.cpp — the process-wide host clock beat-reactive effects read
// (host::barPhase / host::bpm). The comp transport owns them during a comp
// render; the web build feeds the same values per instance via frameState.
void setHostBarPhase(double p);
void setHostBpm(double bpm);
}  // namespace effect_runtime
#endif

namespace comp {

namespace {

/** engine-bridge.ts LOOKAHEAD_BEATS — the decode-pump precache window. */
constexpr double kLookaheadBeats = 8.0;
/** engine-bridge.ts precise fail-safe timeout (2500 ms). */
constexpr double kForceTimeoutSec = 2.5;
/** effect-catalog.ts VIDEO_SOURCE_TYPE. */
constexpr const char* kVideoSourceType = "source.video.file";

/** composition.ts resolveSourceTransform — fill defaults for omitted fields. */
nlohmann::json resolveSourceTransform(const nlohmann::json& t) {
  const auto num = [&](const char* k, double dflt) -> double {
    return t.is_object() && t.contains(k) && t[k].is_number() ? t[k].get<double>() : dflt;
  };
  const auto flag = [&](const char* k) -> bool {
    return t.is_object() && t.contains(k) && t[k].is_boolean() && t[k].get<bool>();
  };
  return {{"anchorX", num("anchorX", 0.5)}, {"anchorY", num("anchorY", 0.5)},
          {"scale", num("scale", 1)},       {"rotation", num("rotation", 0)},
          {"flipH", flag("flipH")},         {"flipV", flag("flipV")}};
}

}  // namespace

CompExecutor::CompExecutor(effect_runtime::EffectRuntime* rt,
                           sketch_executor::ModuleRegistry* registry,
                           gpu::GPUBackend* gpuBackend)
    : rt_(rt),
      registry_(registry),
      gpu_(gpuBackend),
      ex_(std::make_unique<sketch_executor::SketchExecutor>(rt, registry, gpuBackend)),
      transportEx_(std::make_unique<sketch_executor::SketchExecutor>(rt, registry, gpuBackend)) {}

CompExecutor::~CompExecutor() = default;

void CompExecutor::setTraceHooks(sketch_executor::SketchExecutor::ChainEntryHook chainEntry,
                                 sketch_executor::SketchExecutor::SketchOutputHook output,
                                 sketch_executor::SketchExecutor::BarrierPredicate barrier) {
  chainEntryHook_ = std::move(chainEntry);
  outputHook_ = std::move(output);
  barrierHook_ = std::move(barrier);
  ex_->setChainEntryHook(chainEntryHook_);
  ex_->setSketchOutputHook(outputHook_);
  ex_->setBarrierPredicate(barrierHook_);
}

void CompExecutor::resetInternalExecutor() {
  ex_ = std::make_unique<sketch_executor::SketchExecutor>(rt_, registry_, gpu_);
  ex_->setChainEntryHook(chainEntryHook_);
  ex_->setSketchOutputHook(outputHook_);
  ex_->setBarrierPredicate(barrierHook_);
  // The transport executor shares the revive contract: a pruned-then-revived
  // web instance holds DEFAULT params while lastAppliedState_ still matches.
  transportEx_ = std::make_unique<sketch_executor::SketchExecutor>(rt_, registry_, gpu_);
  catalog_.forEach([&](const std::string& type, const nlohmann::json& schema,
                       const std::vector<std::string>& caps) {
    ex_->registerModuleSchema(type, schema);
    ex_->registerModuleCapabilities(type, std::vector<std::string>(caps));
    transportEx_->registerModuleSchema(type, schema);
    transportEx_->registerModuleCapabilities(type, std::vector<std::string>(caps));
  });
  dirty_ = true;  // the fresh executor must re-apply every instance's state
  transportDirty_ = true;
}

void CompExecutor::registerSchema(const std::string& moduleType, const nlohmann::json& fields) {
  catalog_.registerSchema(moduleType, fields);
  ex_->registerModuleSchema(moduleType, fields);
  transportEx_->registerModuleSchema(moduleType, fields);
}

void CompExecutor::registerCapabilities(const std::string& moduleType,
                                        const nlohmann::json& caps) {
  catalog_.registerCapabilities(moduleType, caps);
  std::vector<std::string> tags;
  if (caps.is_array()) {
    for (const auto& c : caps) {
      if (c.is_string()) tags.push_back(c.get<std::string>());
    }
  }
  transportEx_->registerModuleCapabilities(moduleType, std::vector<std::string>(tags));
  ex_->registerModuleCapabilities(moduleType, std::move(tags));
}

void CompExecutor::rebuildClock() {
  clock_ = WarpClock(WarpCurve(derivedWarpSegments(doc_), compositionLengthBeats(doc_)),
                     doc_.baseBPM);
  transport_.reanchor();
}

void CompExecutor::loadDocument(const nlohmann::json& doc) {
  // The cached eval tree points INTO the old doc_ — clear before replacing.
  // Transport rows hold clip pointers from the same doc — clear with it.
  evalTree_.clear();
  transportRows_.clear();
  transportResolved_.clear();
  invalidateEval();
  doc_ = parseComposition(doc);
  docLoaded_ = true;
  docEpoch_++;
  // Pinned-param lifecycle: removing a wire/lane can rebuild a byte-identical
  // sketch, leaving the plugin runtime pinned at the last modulated value (the
  // whole-state fast path would skip re-asserting the authored value). Doc
  // loads are edit-rate, so force a full state re-assert on the next frame.
  dirty_ = true;
  ex_->forceStateReassert();
  // Restore persisted loop markers when present (the store mirrors these too).
  if (doc.is_object() && doc.contains("loop") && doc["loop"].is_object()) {
    const auto& l = doc["loop"];
    state_.loopEnabled = l.value("enabled", state_.loopEnabled);
    state_.loopStartBeat = l.value("startBeat", state_.loopStartBeat);
    state_.loopEndBeat = l.value("endBeat", state_.loopEndBeat);
  }
  rebuildClock();
  // Launch state survives doc reloads (every undoable edit round-trips one);
  // heal drops entries whose track/scene vanished — which IS how deleting a
  // playing scene stops it.
  healSceneLaunches();
  rebuildTriggerRoutes();
  rebuildStreamsTable();
}

void CompExecutor::rebuildStreamsTable() {
  streamsTable_ = buildStreamsTable(doc_, clock_, docEpoch_);
  // Launched scenes keep their live content anchor across the rebuild (the
  // launch map survives doc reloads; the table is doc-shaped and must follow).
  // anchorSec is the STORED launch seconds — shipped, never recomputed, so the
  // web twin subtracts the identical double (event-boundary determinism).
  for (const auto& [trackId, l] : sceneLaunch_) {
    auto it = streamsTable_.contentByClipId.find(l.sceneId);
    if (it == streamsTable_.contentByClipId.end()) continue;
    if (StreamInfo* s = streamsTable_.findMutable(it->second)) {
      s->anchorBeat = l.launchBeat;
      s->anchorSec = l.launchSec;
    }
  }
  // Live forks keep their frozen launch anchors the same way — the outgoing
  // playback must survive a routine doc reload mid-fade.
  for (const auto& [trackId, f] : fork_) {
    auto it = streamsTable_.contentByClipId.find(f.clipId);
    if (it == streamsTable_.contentByClipId.end()) continue;
    if (StreamInfo* s = streamsTable_.findMutable(it->second)) {
      s->anchorBeat = f.anchorBeat;
      s->anchorSec = f.anchorSec;
    }
  }
  sampleStreamsFrame();
}

void CompExecutor::sampleStreamsFrame() {
  auto& f = streamsTable_.frame;
  f.posBeat = state_.positionBeat;
  f.posSec = transportSec_;
  f.playing = state_.playing ? 1 : 0;
  f.loopEnabled = state_.loopEnabled ? 1 : 0;
  f.loopStartBeat = state_.loopStartBeat;
  f.loopEndBeat = state_.loopEndBeat;
  // Scene-track live state (ordinal-axis pos): reset, then mirror the launch
  // map. All lookups are by pre-built maps — no allocation on this path.
  for (auto& s : streamsTable_.streams) {
    if (s.kind == kStreamKindSceneTrack) {
      s.liveOrdinal = std::numeric_limits<double>::quiet_NaN();
      s.nlState = 0;
      s.nlOrdinal = -1;
      s.nlCls = 1;
      s.nlEtaSec = 0;
    }
  }
  for (const auto& [trackId, l] : sceneLaunch_) {
    auto th = streamsTable_.trackByTrackId.find(trackId);
    if (th == streamsTable_.trackByTrackId.end()) continue;
    StreamInfo* s = streamsTable_.findMutable(th->second);
    if (!s || s->kind != kStreamKindSceneTrack) continue;
    auto ref = s->clipsById.find(l.sceneId);
    if (ref == s->clipsById.end()) continue;
    s->liveOrdinal = static_cast<double>(ref->second.ordinal);
    s->liveAnchorBeat = l.launchBeat;
    s->liveLengthBeat = ref->second.lengthBeat;
  }
  // Upcoming-launch mirror (streams.next_launch): announces first, then
  // pending commits OVERWRITE (a deferral in flight is the more imminent
  // fact). Stale announces are erased in update(), so entries here are fresh.
  for (const auto& [trackId, a] : announces_) {
    auto th = streamsTable_.trackByTrackId.find(trackId);
    if (th == streamsTable_.trackByTrackId.end()) continue;
    StreamInfo* s = streamsTable_.findMutable(th->second);
    if (!s || s->kind != kStreamKindSceneTrack) continue;
    auto ref = s->clipsById.find(a.sceneId);
    if (ref == s->clipsById.end()) continue;
    s->nlState = 1;
    s->nlOrdinal = ref->second.ordinal;
    s->nlCls = a.cls;
    s->nlEtaSec = std::max(0.0, a.etaSec - a.ageSec);
  }
  for (const auto& [trackId, p] : pendingLaunch_) {
    auto th = streamsTable_.trackByTrackId.find(trackId);
    if (th == streamsTable_.trackByTrackId.end()) continue;
    StreamInfo* s = streamsTable_.findMutable(th->second);
    if (!s || s->kind != kStreamKindSceneTrack) continue;
    auto ref = s->clipsById.find(p.sceneId);
    if (ref == s->clipsById.end()) continue;
    s->nlState = 2;
    s->nlOrdinal = ref->second.ordinal;
    s->nlCls = p.cls;
    s->nlEtaSec = 0;
  }
}

void CompExecutor::setDeviceParam(const std::string& ownerId, const std::string& deviceId,
                                  const std::string& field, const nlohmann::json& value) {
  // Params are baked into the built sketch's instance states — the eval-skip
  // span must not serve the stale bake (propagation = rebuild + deep-compare).
  invalidateEval();
  // Merge ONE field (shallow-merge contract: never replace the state object).
  auto patch = [&](SketchSpecM& sketch) -> bool {
    for (auto& d : sketch.devices) {
      if (d.id != deviceId) continue;
      if (!d.state.is_object()) d.state = nlohmann::json::object();
      d.state[field] = value;
      return true;
    }
    return false;
  };
  for (auto& t : doc_.tracks) {
    if (t.id == ownerId) {
      if (patch(t.sketch)) return;
      // TRACK transport sections (transition effects) take params too.
      if (t.hasTransport && patch(t.transport)) return;
    }
    for (auto& c : t.clips) {
      if (c.id != ownerId) continue;
      if (patch(c.sketch)) return;
      // Transport-section devices are param targets too (same cheap-op path).
      if (c.hasTransport && patch(c.transport)) return;
    }
  }
}

void CompExecutor::setTrackLevel(const std::string& trackId, double level) {
  invalidateEval();  // levels are baked as layer opacity in the built sketch
  for (auto& t : doc_.tracks) {
    if (t.id == trackId) { t.level = level; return; }
  }
}

void CompExecutor::setSourceTransform(const std::string& clipId,
                                      const nlohmann::json& transform) {
  // The transform rides the video DESC (videoDescFor reads sourceJson), so the
  // eval must re-run for the pump to see it (kCompVideoSetChanged).
  invalidateEval();
  for (auto& t : doc_.tracks) {
    for (auto& c : t.clips) {
      if (c.id != clipId) continue;
      if (!c.sourceJson.is_object()) return;  // no source → nothing to place
      c.sourceJson["transform"] = transform;
      return;
    }
  }
}

namespace {
std::vector<EnvPointM> pointsFromTriples(const double* xyBend, int32_t nPoints) {
  std::vector<EnvPointM> pts;
  pts.reserve(static_cast<size_t>(std::max<int32_t>(0, nPoints)));
  for (int32_t i = 0; i < nPoints; i++) {
    pts.push_back({xyBend[i * 3], xyBend[i * 3 + 1], xyBend[i * 3 + 2]});
  }
  return pts;
}
}  // namespace

void CompExecutor::setLanePoints(const std::string& ownerId, const std::string& laneId,
                                 const double* xyBend, int32_t nPoints) {
  auto patch = [&](std::vector<LaneM>& lanes) -> bool {
    for (auto& l : lanes) {
      if (l.id != laneId) continue;
      l.points = pointsFromTriples(xyBend, nPoints);
      return true;
    }
    return false;
  };
  for (auto& t : doc_.tracks) {
    if (t.id == ownerId && patch(t.automation)) return;
    for (auto& c : t.clips) {
      if (c.id == ownerId && patch(c.automation)) return;
    }
  }
}

void CompExecutor::setRailBase(const std::string& railTrackId, const double* xyBend,
                               int32_t nPoints) {
  // The base value is baked into the built sketch (the per-frame automation
  // re-assert would mask a stale bake, but keep the sketch honest anyway).
  // NOTE setLanePoints deliberately does NOT invalidate: lanes never reach the
  // built sketch, and the per-frame automation eval reads them fresh through
  // the cached tree's pointers.
  invalidateEval();
  for (auto& t : doc_.tracks) {
    if (t.id != railTrackId) continue;
    t.baseCurve = pointsFromTriples(xyBend, nPoints);
    t.hasBaseCurve = true;
    return;
  }
}

void CompExecutor::play() {
  state_.playing = true;
  transport_.reanchor();
}

void CompExecutor::pause() { state_.playing = false; }

void CompExecutor::seekBeat(double beat) { state_.positionBeat = std::max(0.0, beat); }

void CompExecutor::setLoop(bool enabled, double startBeat, double endBeat) {
  state_.loopEnabled = enabled;
  state_.loopStartBeat = startBeat;
  state_.loopEndBeat = endBeat;
}

void CompExecutor::setIgnoreSolo(bool on) {
  if (ignoreSolo_ != on) invalidateEval();  // changes the evaluated tree
  ignoreSolo_ = on;
}

double CompExecutor::positionSec() const { return transport_.secondsAt(state_, clock_); }

void CompExecutor::setVideoReady(const std::string& clipId, bool ready) {
  if (ready) readyClips_.insert(clipId);
  else readyClips_.erase(clipId);
}

bool CompExecutor::scenePrewarmWanted(const std::string& trackId, const SceneLaunch& l) const {
  // A live scene with a FOLLOWER inside its last kScenePrewarmSec: the follow
  // will fire at the next semantic boundary — warm its candidates now.
  const ClipM* live = findSceneClip(trackId, l.sceneId);
  if (!live) return false;
  bool hasFollower = false;
  for (const auto& dev : live->transport.devices) {
    if (catalog_.hasCapability(dev.moduleType, "transport_section")) {
      hasFollower = true;
      break;
    }
  }
  if (!hasFollower) return false;
  double remainingSec = -1;
  auto cit = streamsTable_.contentByClipId.find(l.sceneId);
  const StreamInfo* cs =
      cit != streamsTable_.contentByClipId.end() ? streamsTable_.find(cit->second) : nullptr;
  if (cs) {
    const double nowE = streamElapsed(*cs, streamsTable_, 0.0);
    const int32_t idx = contentEventLowerBound(*cs, nowE, nowE);
    if (idx < contentEventCount(*cs, nowE)) {
      double units = contentEventAt(*cs, idx).time - nowE;
      if (cs->loop.mode == ClipPlayMode::BeatSync) {
        units *= 60.0 / (doc_.baseBPM > 1 ? doc_.baseBPM : 120.0);
      }
      remainingSec = units;
    }
  } else {
    // Effect-only scene: the standard duration clock.
    remainingSec = l.launchSec + standardClipDurationSec(*live, doc_.baseBPM) - transportSec_;
  }
  return remainingSec >= 0 && remainingSec <= kScenePrewarmSec;
}

std::vector<const ClipM*> CompExecutor::precacheCandidatesFor(const std::string& trackId,
                                                              const SceneLaunch& l) const {
  std::vector<const ClipM*> out;
  auto tit = streamsTable_.trackByTrackId.find(trackId);
  const StreamInfo* ts =
      tit != streamsTable_.trackByTrackId.end() ? streamsTable_.find(tit->second) : nullptr;
  if (!ts) return out;
  int32_t liveOrd = -1;
  auto lref = ts->clipsById.find(l.sceneId);
  if (lref != ts->clipsById.end()) liveOrd = lref->second.ordinal;
  // Launchable ordinals (start events), nearest-first around the live scene —
  // the successor is unknown until the effect fires, so warm by proximity.
  std::vector<int32_t> cands;
  for (const auto& e : ts->events) {
    if (e.kind == 0 && e.clipOrdinal != liveOrd) cands.push_back(e.clipOrdinal);
  }
  std::stable_sort(cands.begin(), cands.end(), [&](int32_t a, int32_t b) {
    return std::abs(a - liveOrd) < std::abs(b - liveOrd);
  });
  std::set<std::string> taken;
  for (const int32_t ord : cands) {
    if (static_cast<int>(out.size()) >= kScenePrewarmMax) break;
    if (ord < 0 || ord >= static_cast<int32_t>(ts->byOrdinalClipId.size())) continue;
    const std::string& clipId = ts->byOrdinalClipId[static_cast<size_t>(ord)];
    if (taken.count(clipId)) continue;
    const ClipM* cand = findSceneClip(trackId, clipId);
    if (!cand || !cand->hasSourceUrl) continue;
    taken.insert(clipId);
    out.push_back(cand);
  }
  return out;
}

void CompExecutor::announceScene(const std::string& trackId, const std::string& sceneId,
                                 double etaSec, int32_t cls) {
  if (sceneId.empty()) {  // retract
    if (announces_.erase(trackId)) invalidateEval();
    return;
  }
  // Invalidate only on DISCRETE changes: an entry crossing the warm window
  // or a target change while visible. Per-tick re-asserts inside the window
  // carry no eval-visible information (descs embed no eta; consumption reads
  // the stored record) — invalidating on each would defeat the span cache.
  auto it = announces_.find(trackId);
  const bool visibleBefore = it != announces_.end() && it->second.etaSec <= kScenePrewarmSec;
  const std::string beforeTarget = it != announces_.end() ? it->second.sceneId : std::string();
  const bool visibleAfter = etaSec <= kScenePrewarmSec;
  SceneAnnounce& a = announces_[trackId];
  a.sceneId = sceneId;
  a.etaSec = etaSec;
  a.cls = cls;
  a.ageSec = 0;
  if (visibleBefore != visibleAfter || (visibleAfter && beforeTarget != sceneId)) {
    invalidateEval();
  }
}

const ClipM* CompExecutor::announcedTargetFor(const std::string& trackId) const {
  auto it = announces_.find(trackId);
  if (it == announces_.end()) return nullptr;
  if (it->second.etaSec > kScenePrewarmSec) return nullptr;  // outside the warm window
  // Revalidate against the CURRENT doc: announces outlive their drain across
  // edits/reloads, and staleness expiry alone is too slow for correctness.
  const ClipM* scene = findSceneClip(trackId, it->second.sceneId);
  if (!scene || scene->bypassed) return nullptr;
  return scene;
}

std::map<std::string, std::vector<const ClipM*>> CompExecutor::scenePrewarmPlan() const {
  std::map<std::string, std::vector<const ClipM*>> plan;
  // Track ids from live launches ∪ announces — an announce onto an EMPTY
  // track (nothing playing) warms its target too.
  std::set<std::string> trackIds;
  for (const auto& [tid, l] : sceneLaunch_) trackIds.insert(tid);
  for (const auto& [tid, a] : announces_) trackIds.insert(tid);
  for (const auto& tid : trackIds) {
    std::vector<const ClipM*> cands;
    std::set<std::string> taken;
    // The announced target goes FIRST — the fill order below guarantees the
    // heuristic can never evict it.
    if (const ClipM* target = announcedTargetFor(tid)) {
      cands.push_back(target);
      taken.insert(target->id);
    }
    auto lit = sceneLaunch_.find(tid);
    if (lit != sceneLaunch_.end() && scenePrewarmWanted(tid, lit->second)) {
      for (const ClipM* c : precacheCandidatesFor(tid, lit->second)) {
        if (static_cast<int>(cands.size()) >= kScenePrewarmMax) break;
        if (!taken.insert(c->id).second) continue;
        cands.push_back(c);
      }
    }
    if (!cands.empty()) plan[tid] = std::move(cands);
  }
  return plan;
}

const ClipM* CompExecutor::findSceneClip(const std::string& trackId,
                                         const std::string& sceneId) const {
  for (const auto& t : doc_.tracks) {
    if (t.id != trackId || t.kind != TrackKind::Scene) continue;
    for (const auto& c : t.clips) {
      if (c.id == sceneId) return &c;
    }
    return nullptr;
  }
  return nullptr;
}

void CompExecutor::releaseFork(const std::string& trackId) {
  auto it = fork_.find(trackId);
  if (it == fork_.end()) return;
  auto cit = streamsTable_.contentByClipId.find(it->second.clipId);
  if (cit != streamsTable_.contentByClipId.end()) {
    if (StreamInfo* cs = streamsTable_.findMutable(cit->second)) cs->eventRev++;
  }
  fork_.erase(it);
  scenesDirty_ = true;
  invalidateEval();
}

void CompExecutor::launchScene(const std::string& trackId, const std::string& sceneId,
                               int32_t cls) {
  // While a fork runs on this track, a relaunch of the ALREADY-LIVE scene is
  // dropped: the transition committed the incoming early, and the original
  // announcer's redundant boundary-time fire must not re-anchor it mid-fade.
  // Bounded by the fork's short life; retriggers behave normally otherwise.
  if (fork_.count(trackId)) {
    auto lit = sceneLaunch_.find(trackId);
    if (lit != sceneLaunch_.end() && lit->second.sceneId == sceneId) return;
  }
  // Gapless handover: defer the commit while the incoming VIDEO isn't decoded
  // yet — the outgoing scene keeps playing and the pump warms the incoming
  // one (its desc ships active-shaped from warmVideoDescs). Deferral needs a
  // live readiness feed (the web bridge's handshake; the native barrel has
  // none → legacy immediate commits), an actual video, and a policy match:
  // Precise defers everything; Live defers only Loose intents ("we must keep
  // pumping frames" — an Instant stab commits now, flash or not).
  const ClipM* scene = findSceneClip(trackId, sceneId);
  const bool defer = readyFeedAlive_ && scene && scene->hasSourceUrl &&
                     !readyClips_.count(sceneId) && (precise_ || cls == kLaunchLoose);
  if (defer) {
    PendingLaunch p;
    p.sceneId = sceneId;
    p.requestBeat = state_.positionBeat;  // REQUEST anchor: chains stay on grid
    p.requestSec = clock_.secondsAt(p.requestBeat);
    p.cls = cls;
    // Linger clamp: freeze the OUTGOING scene at the end of its in-progress
    // pass while the handover pends — without it a looping outgoing wraps
    // back to its start during the window (the cold-launch cousin of the
    // primed-candidate fast path; primed follows never get here). Driven
    // scenes are excluded: their controller owns content time (the pump
    // follows the times channel, not the desc mapping we clamp). An armed or
    // live FORK also suppresses the clamp — the outgoing plays THROUGH the
    // window into the crossfade; freezing it would fight the fade.
    auto lit = sceneLaunch_.find(trackId);
    if (lit != sceneLaunch_.end() && !forkArm_.count(trackId) && !fork_.count(trackId)) {
      const ClipM* out = findSceneClip(trackId, lit->second.sceneId);
      auto cit = streamsTable_.contentByClipId.find(lit->second.sceneId);
      const StreamInfo* cs =
          cit != streamsTable_.contentByClipId.end() ? streamsTable_.find(cit->second) : nullptr;
      if (cs && out && !transportDeviceOf(*out, catalog_)) {
        const double nowE = streamElapsed(*cs, streamsTable_, 0.0);
        const int32_t idx = contentEventLowerBound(*cs, nowE, nowE);
        if (!std::isnan(nowE) && idx < contentEventCount(*cs, nowE)) {
          // A sub-frame margin keeps the clamp strictly INSIDE the pass —
          // the boundary itself already maps to the wrapped frame.
          const double marginSec = 0.25 / std::max(1.0, cs->fps);
          const double bound = contentEventAt(*cs, idx).time;
          if (cs->loop.mode == ClipPlayMode::BeatSync) {
            const double spb = 60.0 / (doc_.baseBPM > 1 ? doc_.baseBPM : 120.0);
            p.holdBeat = cs->anchorBeat + bound - marginSec / spb;
          } else {
            p.holdBeat = clock_.beatAtSeconds(cs->anchorSec + bound - marginSec);
          }
        }
      }
    }
    // A re-request on the same track keeps the FIRST freeze point: the pump
    // has been clamped there since the original request — adopting a later
    // boundary would visibly unfreeze + wrap. (Not when a fork suppresses
    // the clamp — the outgoing must keep playing.)
    auto prev = pendingLaunch_.find(trackId);
    if (prev != pendingLaunch_.end() && prev->second.holdBeat >= 0 &&
        !forkArm_.count(trackId) && !fork_.count(trackId) &&
        (p.holdBeat < 0 || prev->second.holdBeat < p.holdBeat)) {
      p.holdBeat = prev->second.holdBeat;
    }
    pendingLaunch_[trackId] = std::move(p);  // single slot, last wins
    scenesDirty_ = true;                     // ships in the pending channel
    invalidateEval();                        // the pending desc must reach the pump
    return;
  }
  pendingLaunch_.erase(trackId);
  commitLaunch(trackId, sceneId, state_.positionBeat, clock_.secondsAt(state_.positionBeat));
}

void CompExecutor::applyPendingLaunches(double dtSec) {
  for (auto it = pendingLaunch_.begin(); it != pendingLaunch_.end();) {
    it->second.ageSec += std::max(0.0, dtSec);
    // Doc edits round-trip through loadDocument while pending survives —
    // validate like the heal: a vanished track/scene drops the entry.
    const ClipM* scene = findSceneClip(it->first, it->second.sceneId);
    if (!scene) {
      it = pendingLaunch_.erase(it);
      scenesDirty_ = true;
      invalidateEval();
      continue;
    }
    const bool ready = !scene->hasSourceUrl || readyClips_.count(it->second.sceneId) > 0;
    if (ready || it->second.ageSec >= kForceTimeoutSec) {
      const PendingLaunch p = it->second;
      const std::string trackId = it->first;
      it = pendingLaunch_.erase(it);
      commitLaunch(trackId, p.sceneId, p.requestBeat, p.requestSec);
    } else {
      ++it;
    }
  }
}

void CompExecutor::commitLaunch(const std::string& trackId, const std::string& sceneId,
                                double launchBeat, double launchSec) {
  // fork materialization (ADOPTED IDENTITY): an armed fork whose clip IS the
  // track's live scene detaches at the exact commit instant — the evicted
  // SceneLaunch moves into the fork slot with its anchors frozen, so the
  // outgoing keeps advancing through the untouched lazy mapping (same clipId,
  // same content stream, same pump, same effect instances — nothing moves).
  // A→A relaunches skip: identity collision, plain retrigger semantics.
  auto arm = forkArm_.find(trackId);
  if (arm != forkArm_.end()) {
    auto live = sceneLaunch_.find(trackId);
    if (live != sceneLaunch_.end() && live->second.sceneId == arm->second.clipId &&
        sceneId != arm->second.clipId) {
      releaseFork(trackId);  // snap-finish an existing fork (chained cuts)
      ForkState f;
      f.clipId = live->second.sceneId;
      f.anchorBeat = live->second.launchBeat;
      f.anchorSec = live->second.launchSec;
      fork_[trackId] = std::move(f);
      auto fcit = streamsTable_.contentByClipId.find(arm->second.clipId);
      if (fcit != streamsTable_.contentByClipId.end()) {
        if (StreamInfo* cs = streamsTable_.findMutable(fcit->second)) cs->eventRev++;
      }
    }
    forkArm_.erase(arm);  // consumed; the standing re-assert re-arms next tick
  }
  // A fulfilled announce is done — without this the just-launched target
  // haunts the NEXT cycle's warm slots until the stale window closes.
  auto ait = announces_.find(trackId);
  if (ait != announces_.end() && ait->second.sceneId == sceneId) announces_.erase(ait);
  SceneLaunch& l = sceneLaunch_[trackId];
  l.sceneId = sceneId;
  l.launchBeat = launchBeat;
  l.launchSec = launchSec;
  // A (re)launch clears any latched transport_ended for this scene — else a
  // controller's stale latch (still live in the effect instance) would let
  // the next heal kill the relaunch before the effect re-arms.
  transportEnded_.erase(sceneId);
  // The scene's content stream re-anchors too: its lazy position mapping runs
  // from the launch beat, exactly like the tree's anchorBeat. A (re)launch is
  // an event-generator change → bump the stream revs (content + parent track).
  auto it = streamsTable_.contentByClipId.find(sceneId);
  if (it != streamsTable_.contentByClipId.end()) {
    if (StreamInfo* s = streamsTable_.findMutable(it->second)) {
      s->anchorBeat = l.launchBeat;
      s->anchorSec = l.launchSec;
      s->dynEvents.clear();  // a relaunch restarts the declared looped log
      s->declLoopCount = 0;
      s->eventRev++;
    }
  }
  auto pt = streamsTable_.trackByTrackId.find(trackId);
  if (pt != streamsTable_.trackByTrackId.end()) {
    if (StreamInfo* s = streamsTable_.findMutable(pt->second)) s->eventRev++;
  }
  scenesDirty_ = true;
  invalidateEval();
}

void CompExecutor::stopScene(const std::string& trackId) {
  // The announcing section dies with the scene — collapse the warm set now
  // rather than waiting out the stale window. A stop gesture also clears the
  // track's fork lifecycle (armed or fading).
  if (announces_.erase(trackId)) invalidateEval();
  forkArm_.erase(trackId);
  releaseFork(trackId);
  if (pendingLaunch_.erase(trackId)) {
    scenesDirty_ = true;
    invalidateEval();
  }
  auto lit = sceneLaunch_.find(trackId);
  if (lit == sceneLaunch_.end()) return;
  auto cit = streamsTable_.contentByClipId.find(lit->second.sceneId);
  if (cit != streamsTable_.contentByClipId.end()) {
    if (StreamInfo* s = streamsTable_.findMutable(cit->second)) s->eventRev++;
  }
  auto pt = streamsTable_.trackByTrackId.find(trackId);
  if (pt != streamsTable_.trackByTrackId.end()) {
    if (StreamInfo* s = streamsTable_.findMutable(pt->second)) s->eventRev++;
  }
  sceneLaunch_.erase(lit);
  pendingLaunch_.erase(trackId);
  scenesDirty_ = true;
  invalidateEval();
}

void CompExecutor::stopAllScenes() {
  if (sceneLaunch_.empty() && pendingLaunch_.empty() && announces_.empty() &&
      fork_.empty() && forkArm_.empty()) {
    return;
  }
  sceneLaunch_.clear();
  pendingLaunch_.clear();
  announces_.clear();
  fork_.clear();
  forkArm_.clear();
  scenesDirty_ = true;
  invalidateEval();
}

void CompExecutor::healSceneLaunches() {
  for (auto it = sceneLaunch_.begin(); it != sceneLaunch_.end();) {
    // A PENDING handover owns this track's end-of-life: the successor is
    // already chosen, so no stop path may evict the outgoing scene mid-window
    // (mirrors the follower defer below — the commit replaces it, bounded by
    // the pending deadline).
    if (pendingLaunch_.count(it->first)) {
      ++it;
      continue;
    }
    const TrackM* track = nullptr;
    for (const auto& t : doc_.tracks) {
      if (t.id == it->first && t.kind == TrackKind::Scene) { track = &t; break; }
    }
    const ClipM* scene = nullptr;
    if (track) {
      for (const auto& c : track->clips) {
        if (c.id == it->second.sceneId) { scene = &c; break; }
      }
    }
    bool stop = !scene;
    // A transport SECTION owns its scene's end-of-life. A follower present ⇒
    // heal never stops the scene (the follower evicts-by-launch or calls
    // streams.stop) — heal runs BEFORE the pre-pass each frame, so any
    // heal-side stop would consistently win the same-frame race and silence
    // the follower. A driven (controller, no follower) scene stops on the
    // controller's latched transport_ended (read by the last pre-pass;
    // 1-frame, same class as the trigger readback).
    const bool sectioned = scene && clipHasTransportSection(*scene, catalog_);
    const bool hasFollower = sectioned && [&] {
      for (const auto& d : scene->transport.devices) {
        if (catalog_.hasCapability(d.moduleType, "transport_section")) return true;
      }
      return false;
    }();
    if (hasFollower) {
      // Follower owns the end — no config or ended stop.
    } else if (scene && transportDeviceOf(*scene, catalog_)) {
      if (transportEnded_.count(it->second.sceneId)) stop = true;
    }
    // One-shot scenes auto-stop once their content elapses (the track goes
    // empty). Video: the source slice at its speed; effect-only: the scene's
    // nominal lengthBeat. Loop-mode scenes play until replaced/stopped.
    else if (scene && scene->loop.mode == ClipPlayMode::OneShot) {
      if (scene->hasSourceUrl) {
        double sliceSec = -1;
        if (scene->loop.endSec) {
          sliceSec = *scene->loop.endSec - scene->loop.startSec;
        } else if (scene->sourceJson.is_object() &&
                   scene->sourceJson.contains("durationFrames") &&
                   scene->sourceJson["durationFrames"].is_number()) {
          const double fps = scene->sourceJson.contains("fps") &&
                                     scene->sourceJson["fps"].is_number() &&
                                     scene->sourceJson["fps"].get<double>() > 0
                                 ? scene->sourceJson["fps"].get<double>()
                                 : 30.0;
          sliceSec = scene->sourceJson["durationFrames"].get<double>() / fps;
        }
        const double speed = std::max(1e-6, std::abs(scene->loop.speed));
        if (sliceSec >= 0 && transportSec_ >= it->second.launchSec + sliceSec / speed) {
          stop = true;
        }
      } else if (state_.positionBeat >= it->second.launchBeat + scene->lengthBeat) {
        stop = true;
      }
    }
    if (stop) {
      it = sceneLaunch_.erase(it);
      scenesDirty_ = true;
      invalidateEval();
    } else {
      ++it;
    }
  }
}

nlohmann::json CompExecutor::videoDescFor(const ClipM& clip, double anchorBeat,
                                          bool unbounded) const {
  // composite-frame.ts videoDescFor — the instanceKey MUST match the clip's
  // source.video.file chain entry or the injected frame goes nowhere.
  // `anchorBeat` = clip.startBeat for arrangement clips, the LAUNCH beat for
  // scenes (the pump maps beats to source time from the desc's startBeat).
  if (!clip.hasSourceUrl) return nullptr;
  const DeviceM* dev = nullptr;
  for (const auto& d : clip.sketch.devices) {
    if (d.moduleType == kVideoSourceType) { dev = &d; break; }
  }
  if (!dev) return nullptr;
  const auto& src = clip.sourceJson;
  const bool driven = transportDeviceOf(clip, catalog_) != nullptr;
  nlohmann::json d = {
      {"clipId", clip.id},
      {"instanceKey", clipInstanceKey(clip.id, dev->id)},
      {"url", src.value("url", std::string())},
      {"sourceKey", src.contains("sourceKey") && src["sourceKey"].is_string()
                        ? src["sourceKey"].get<std::string>()
                        : clip.id},
      {"startBeat", anchorBeat},
      // A scene's lengthBeat is its one-bar GRID cell width (layout only);
      // playback runs until stopped — ship an effectively-infinite window.
      {"lengthBeat", unbounded ? 1e9 : clip.lengthBeat},
      {"durationFrames", src.contains("durationFrames") && src["durationFrames"].is_number()
                             ? src["durationFrames"]
                             : nlohmann::json(0)},
      {"scaleMode", src.value("scaleMode", std::string("fit"))},
      {"transform",
       resolveSourceTransform(src.contains("transform") ? src["transform"] : nlohmann::json())},
  };
  // Transport-DRIVEN clips: the pump follows the per-frame times channel — the
  // desc stays structural (loop/speed omitted; the pump's ClipLoopConfig math
  // is bypassed, but survives untouched as the invalid-row fallback default).
  if (driven) {
    d["transport"] = true;
  } else {
    d["loop"] = clip.loopJson.is_object() ? clip.loopJson : nlohmann::json::object();
    if (clip.loopJson.is_object() && clip.loopJson.contains("speed") &&
        clip.loopJson["speed"].is_number()) {
      d["speed"] = clip.loopJson["speed"];
    }
  }
  // Optionals: JS drops undefined keys — mirror by omitting absent fields.
  if (src.contains("fps") && src["fps"].is_number()) d["fps"] = src["fps"];
  return d;
}

nlohmann::json CompExecutor::videoDescsForTree(const std::vector<CompNode>& tree) const {
  // Walk leaves (same DFS as collectClips) keeping each leaf's anchorBeat —
  // a launched scene's desc must carry its launch beat, not clip.startBeat.
  nlohmann::json descs = nlohmann::json::array();
  std::function<void(const std::vector<CompNode>&)> walk =
      [&](const std::vector<CompNode>& nodes) {
        for (const auto& n : nodes) {
          if (n.isGroup) {
            walk(n.children);
            continue;
          }
          const bool scene = n.track && n.track->kind == TrackKind::Scene;
          nlohmann::json d = videoDescFor(*n.clip, n.anchorBeat, scene);
          if (!d.is_null()) {
            // Linger clamp: while this track's handover pends, the OUTGOING
            // scene's desc carries the pass-end freeze beat (launchScene).
            if (scene) {
              auto pit = pendingLaunch_.find(n.track->id);
              if (pit != pendingLaunch_.end() && pit->second.holdBeat >= 0 &&
                  !d.contains("transport")) {
                d["holdBeat"] = pit->second.holdBeat;
              }
            }
            descs.push_back(std::move(d));
          }
          // A live fork's desc is BYTE-IDENTICAL to the desc it shipped as
          // the live scene (same clipId/instanceKey/anchors, unbounded, no
          // holdBeat) — the pump reconcile must keep the running pump/decoder
          // untouched across the detach.
          if (n.hasFork && n.forkClip) {
            nlohmann::json fd = videoDescFor(*n.forkClip, n.forkAnchorBeat, true);
            if (!fd.is_null()) descs.push_back(std::move(fd));
          }
        }
      };
  walk(tree);
  return descs;
}

nlohmann::json CompExecutor::warmVideoDescs(const std::vector<CompNode>& tree,
                                            double beat) const {
  // Active + the lookahead precache window (store.videoClipsInWindow — video
  // clips overlapping [beat, beat+LOOKAHEAD) on non-bypassed tracks).
  nlohmann::json warm = videoDescsForTree(tree);
  std::set<std::string> seen;
  for (const auto& d : warm) seen.insert(d["clipId"].get<std::string>());

  // effectiveBypassed = own bypass OR any ancestor group's.
  std::map<std::string, const TrackM*> byId;
  for (const auto& t : doc_.tracks) byId[t.id] = &t;
  auto effectiveBypassed = [&](const TrackM& t) -> bool {
    if (t.bypassed) return true;
    std::string pid = t.parentId;
    while (!pid.empty()) {
      auto it = byId.find(pid);
      if (it == byId.end()) break;
      if (it->second->bypassed) return true;
      pid = it->second->parentId;
    }
    return false;
  };

  const double beatEnd = beat + kLookaheadBeats;
  for (const auto& t : doc_.tracks) {
    if (t.kind != TrackKind::Track) continue;
    if (effectiveBypassed(t)) continue;
    for (const auto& c : t.clips) {
      if (!c.hasSourceUrl) continue;
      if (!(c.startBeat < beatEnd && c.startBeat + c.lengthBeat > beat)) continue;
      if (seen.count(c.id)) continue;
      nlohmann::json d = videoDescFor(c, c.startBeat);
      if (d.is_null()) continue;
      seen.insert(c.id);
      warm.push_back(std::move(d));
    }
  }

  // Pending handovers: the incoming scene ships ACTIVE-SHAPED (request-beat
  // anchor, unbounded window) so the pump opens + plays + INJECTS it while
  // the outgoing scene still shows — its readiness edge commits the launch,
  // and the injected frame is exactly what the committed mapping wants (the
  // commit anchors at the same request beat; zero snap). Warm-shaped descs
  // can NOT signal readiness (the warm path never injects) — do not "clean
  // this up" into an entry pre-seek.
  // A driven scene has NO times row while pending/warming (rows follow the
  // ACTIVE tree) — force the real loop config so the pump's mapping, and thus
  // its readiness verdict, is well-defined rather than an arbitrary fallback.
  auto forceLoopShape = [](nlohmann::json& d, const ClipM& scene) {
    if (!d.contains("transport")) return;
    d.erase("transport");
    d["loop"] = scene.loopJson.is_object() ? scene.loopJson : nlohmann::json::object();
    if (scene.loopJson.is_object() && scene.loopJson.contains("speed") &&
        scene.loopJson["speed"].is_number()) {
      d["speed"] = scene.loopJson["speed"];
    }
  };
  for (const auto& [trackId, p] : pendingLaunch_) {
    if (seen.count(p.sceneId)) continue;
    const ClipM* scene = findSceneClip(trackId, p.sceneId);
    if (!scene || !scene->hasSourceUrl) continue;
    nlohmann::json d = videoDescFor(*scene, p.requestBeat, /*unbounded=*/true);
    if (d.is_null()) continue;
    forceLoopShape(d, *scene);
    seen.insert(p.sceneId);
    warm.push_back(std::move(d));
  }

  // Scene precache plan (announced target first, then follower proximity):
  // warm the tracks' likely-next scenes. This is the primary gapless
  // mechanism — deferral alone would just relocate the gap onto the outgoing
  // scene. Candidates ship PRIMED: the pump decodes AND INJECTS the entry
  // frame (the worker retains textures for instances and binds on creation)
  // and reports real entry readiness, so the launch hits the readyClips_
  // fast path and commits SAME-FRAME — a deferral window here would render
  // the outgoing clip wrapping back to its start (the "plays 1-3 frames of
  // the first clip again" handover artifact). The pending block above ran
  // first, so a pending handover's ACTIVE-shape wins the dedup when the
  // announced target IS the pending scene. Descs are video-only; a source-
  // less (effect-only / gap) announced target still pre-instantiates its
  // chain via ensureEvalAt's candidate worlds.
  for (const auto& [trackId, cands] : scenePrewarmPlan()) {
    for (const ClipM* cand : cands) {
      if (seen.count(cand->id) || !cand->hasSourceUrl) continue;
      // Warm-shaped (in-the-future anchor: entry targeting, no play) + prime.
      nlohmann::json d = videoDescFor(*cand, beat + kLookaheadBeats);
      if (d.is_null()) continue;
      forceLoopShape(d, *cand);
      d["prime"] = true;
      seen.insert(cand->id);
      warm.push_back(std::move(d));
    }
  }
  return warm;
}

bool CompExecutor::videoReady(const nlohmann::json& descs) const {
  for (const auto& d : descs) {
    if (!readyClips_.count(d["clipId"].get<std::string>())) return false;
  }
  return true;
}

std::string CompExecutor::chainSigOf(const nlohmann::json& sketch) {
  std::string sig;
  if (!sketch.is_object() || !sketch.contains("chain")) return sig;
  for (const auto& e : sketch["chain"]) {
    sig += e.value("module_type", std::string());
    sig += '\x1f';
    sig += e.value("instance_key", std::string());
    sig += '\x1e';
  }
  return sig;
}

bool CompExecutor::ensureEvalAt(double beat, uint32_t& flags) {
  // EVAL-level `__layer__` bypass: compare the lane-driven decision vector at
  // the CURRENT beat against the vector captured at eval time — a threshold
  // flip is a structural change the span can't see (lanes are deliberately
  // not span boundaries), so invalidate exactly when a decision flips. The
  // RAIL-driven decisions (last frame's post-render readback) join the same
  // compare — the 1-frame "iterative update" loop.
  std::map<std::string, bool> bypassDec = laneBypassDecisions(doc_, beat);
  if (evalValid_ && (bypassDec != evalBypassDecisions_ ||
                     railBypassDecisions_ != evalRailBypass_)) {
    evalValid_ = false;
  }
  // SEQUENCE interiors: a sub-clip switch inside a sequence clip is a
  // structural change the span can't see (the span is built from TOP-LEVEL
  // clip boundaries), so compare which sub-clip each active sequence is
  // showing and invalidate exactly on a change — the same shape as the bypass
  // compare above. Exact for every play mode; an analytic interior boundary
  // can layer on top later as a pure optimization. One frame of latency on
  // appliedContentSec for transport-driven sequences, identical in class to
  // the rail-bypass readback loop.
  std::map<std::string, std::string> seqPicks =
      sequencePickDecisions(doc_, beat, clock_, &streamsTable_.appliedContentSec);
  if (evalValid_ && seqPicks != evalSequencePicks_) evalValid_ = false;

  // Span hit: the evaluation at evalBeat_ is valid for [evalBeat_, boundary).
  // Backward motion (seek/loop wrap) falls out of the half-open interval and
  // re-evaluates — even landing back inside a previously-evaluated span, one
  // conservative re-eval beats tracking span history.
  if (evalValid_ && beat >= evalBeat_ && beat < evalNextBoundary_) return false;

  evalCount_++;
  evalBypassDecisions_ = std::move(bypassDec);
  evalSequencePicks_ = std::move(seqPicks);
  evalRailBypass_ = railBypassDecisions_;
  // Live forks join the tree as second leaves on their tracks. (Candidate /
  // pending worlds below deliberately DON'T carry them: a fork's chain keys
  // are the previously-live scene's keys — already alive in this sketch — so
  // continuity needs no pre-instantiation.)
  std::map<std::string, SceneLaunch> forkView;
  for (const auto& [tid, f] : fork_) forkView[tid] = {f.clipId, f.anchorBeat, f.anchorSec};
  evalTree_ = compositeTreeAtBeat(doc_, beat, ignoreSolo_, &evalRailBypass_, &sceneLaunch_,
                                  forkView.empty() ? nullptr : &forkView, &clock_,
                                  &streamsTable_.appliedContentSec);
  SketchBuild build = buildCompositeRenderFromTree(doc_, catalog_, clock_, evalTree_, beat);
  hasContent_ = build.hasContent;
  layerTargets_ = std::move(build.layerTargets);
  if (build.hasContent) {
    if (cleanSketch_.is_null() || build.sketch != cleanSketch_) {
      cleanSketch_ = std::move(build.sketch);
      dirty_ = true;
    }
    std::string sig = chainSigOf(cleanSketch_);
    if (sig != chainSig_) {
      chainSig_ = std::move(sig);
      flags |= kCompStructureChanged;
    }
  } else if (!cleanSketch_.is_null()) {
    cleanSketch_ = nlohmann::json();
    execSketch_ = nlohmann::json();
    chainSig_.clear();
    dirty_ = false;
    flags |= kCompStructureChanged;
  }
  evalActiveDescs_ = videoDescsForTree(evalTree_);
  evalWarmDescs_ = warmVideoDescs(evalTree_, beat);
  // Pending handovers: pre-build the POST-COMMIT world's sketch (launch map
  // with pending overlaid — same builder, same anchors ⇒ IDENTICAL instance
  // keys) and ship its chain through requiredJson, so the worker instantiates
  // the incoming scene's whole chain (video source, effects, layer) BEFORE
  // the commit. Without this the swap's first frames render with missing
  // instances → the layer blanks for exactly the frames instantiation takes.
  if (pendingLaunch_.empty()) {
    if (!pendingSketch_.is_null()) {
      pendingSketch_ = nlohmann::json();
      flags |= kCompStructureChanged;
    }
  } else {
    std::map<std::string, SceneLaunch> future = sceneLaunch_;
    for (const auto& [tid, p] : pendingLaunch_) {
      SceneLaunch l;
      l.sceneId = p.sceneId;
      l.launchBeat = p.requestBeat;
      l.launchSec = p.requestSec;
      future[tid] = l;
    }
    std::vector<CompNode> futureTree =
        compositeTreeAtBeat(doc_, beat, ignoreSolo_, &evalRailBypass_, &future, nullptr, &clock_,
                            &streamsTable_.appliedContentSec);
    SketchBuild fb = buildCompositeRenderFromTree(doc_, catalog_, clock_, futureTree, beat);
    if (fb.sketch != pendingSketch_) {
      pendingSketch_ = std::move(fb.sketch);
      flags |= kCompStructureChanged;  // the worker re-fetches requiredJson
    }
  }
  // Precache candidates: pre-instantiate each candidate's POST-COMMIT world
  // too (same builder ⇒ identical, anchor-independent instance keys), so a
  // primed candidate's fast-path commit renders complete on its very first
  // frame — the primed entry texture is already retained/bound. Alternative
  // futures per track union by chain (bounded by kScenePrewarmMax).
  {
    nlohmann::json cand;
    std::set<std::string> have;
    for (const auto& [trackId, cands] : scenePrewarmPlan()) {
      for (const ClipM* c : cands) {
        std::map<std::string, SceneLaunch> future = sceneLaunch_;
        future[trackId] = SceneLaunch{c->id, beat, clock_.secondsAt(beat)};
        std::vector<CompNode> ftree =
            compositeTreeAtBeat(doc_, beat, ignoreSolo_, &evalRailBypass_, &future);
        SketchBuild fb = buildCompositeRenderFromTree(doc_, catalog_, clock_, ftree, beat);
        if (!fb.sketch.is_object() || !fb.sketch.contains("chain")) continue;
        if (cand.is_null()) cand = nlohmann::json{{"chain", nlohmann::json::array()}};
        for (auto& e : fb.sketch["chain"]) {
          const std::string key = e.value("instance_key", std::string());
          if (!have.insert(key).second) continue;
          cand["chain"].push_back(std::move(e));
        }
      }
    }
    if (cand != candidateSketch_) {
      candidateSketch_ = std::move(cand);
      flags |= kCompStructureChanged;  // the worker re-fetches requiredJson
    }
  }
  rebuildTransportSketch(beat, flags);
  evalBeat_ = beat;
  evalNextBoundary_ = nextEvalBoundary(doc_, beat, kLookaheadBeats);
  evalValid_ = true;
  return true;
}

void CompExecutor::rebuildTransportSketch(double beat, uint32_t& flags) {
  // Sketch basis = SECTIONED clips among the active tree leaves (DFS order),
  // then the lookahead window (warmVideoDescs' criteria, but for ANY
  // sectioned clip — effect-only clips can carry sections too). Follower-only
  // sections execute without driving; a warming clip's controller publishes
  // its entry target before the playhead arrives (pre-seek parity).
  std::vector<const ClipM*> clips;
  std::set<std::string> seen;
  std::set<std::string> controllerOnly;
  std::function<void(const std::vector<CompNode>&)> walk =
      [&](const std::vector<CompNode>& nodes) {
        for (const auto& n : nodes) {
          if (n.isGroup) {
            walk(n.children);
            continue;
          }
          if (n.clip && !seen.count(n.clip->id) &&
              clipHasTransportSection(*n.clip, catalog_)) {
            seen.insert(n.clip->id);
            clips.push_back(n.clip);
          }
          // A DRIVEN fork keeps its controller (its clock stays owned), but
          // sheds its section members — a detached clip's follower re-arming
          // against the track's new live scene would double-drive.
          if (n.hasFork && n.forkClip && !seen.count(n.forkClip->id) &&
              clipHasTransportSection(*n.forkClip, catalog_)) {
            seen.insert(n.forkClip->id);
            clips.push_back(n.forkClip);
            controllerOnly.insert(n.forkClip->id);
          }
        }
      };
  walk(evalTree_);
  // Launched scenes with NO content leaf: an empty "gap" scene carrying only
  // a transport section never reaches the composite tree (nothing to render),
  // but its section must still execute — it owns the gap's dwell and hands
  // the track on (Follow-as-timed-gap).
  for (const auto& [trackId, l] : sceneLaunch_) {
    const ClipM* scene = findSceneClip(trackId, l.sceneId);
    if (!scene || scene->bypassed || seen.count(scene->id)) continue;
    if (!clipHasTransportSection(*scene, catalog_)) continue;
    seen.insert(scene->id);
    clips.push_back(scene);
  }
  const double beatEnd = beat + kLookaheadBeats;
  for (const auto& t : doc_.tracks) {
    if (t.kind != TrackKind::Track || t.bypassed) continue;
    for (const auto& c : t.clips) {
      if (seen.count(c.id)) continue;
      if (!(c.startBeat < beatEnd && c.startBeat + c.lengthBeat > beat)) continue;
      if (!clipHasTransportSection(c, catalog_)) continue;
      seen.insert(c.id);
      clips.push_back(&c);
    }
  }

  // TRACK transport sections: every non-bypassed scene track with a section
  // executes unconditionally (no beat window — the track is always "active";
  // transition effects must watch even while the track idles).
  std::vector<const TrackM*> trackSections;
  for (const auto& t : doc_.tracks) {
    if (t.kind != TrackKind::Scene || t.bypassed || !t.hasTransport) continue;
    for (const auto& d : t.transport.devices) {
      if (catalog_.has(d.moduleType)) { trackSections.push_back(&t); break; }
    }
  }
  nlohmann::json built = buildTransportSketch(
      clips, catalog_, controllerOnly.empty() ? nullptr : &controllerOnly,
      trackSections.empty() ? nullptr : &trackSections);
  // Same contract as the main sketch: ANY JSON difference (a param edit baked
  // into an instance state, not just topology) must re-apply state.
  if (built != transportCleanSketch_) {
    transportCleanSketch_ = std::move(built);
    transportDirty_ = true;
  }
  // Times-channel ROWS stay DRIVEN-only — a follower never flags its clip as
  // transport-driven (desc keeps loop; ended-heal keeps needing a controller).
  transportRows_.clear();
  transportRows_.reserve(clips.size());
  for (const ClipM* c : clips) {
    const DeviceM* dev = transportDeviceOf(*c, catalog_);
    if (!dev) continue;  // sectioned but not driven (follower-only)
    TransportRow row;
    row.clip = c;
    row.clipId = c->id;
    row.moduleType = dev->moduleType;
    row.instanceKey = transportInstanceKey(c->id, dev->id);
    transportRows_.push_back(std::move(row));
  }
  transportResolved_.assign(transportRows_.size(), TransportResolved{});
  std::string sig = chainSigOf(transportCleanSketch_);
  if (sig != transportSig_) {
    transportSig_ = std::move(sig);
    // Structure so the host ensures the section instances; set-changed so it
    // refreshes the times-channel row order. (Dirty already followed the JSON
    // diff above — a sig change is always a JSON change.)
    flags |= kCompStructureChanged | kCompTransportSetChanged;
  }
}

std::vector<std::string> CompExecutor::transportOrder() const {
  std::vector<std::string> order;
  order.reserve(transportRows_.size());
  for (const auto& r : transportRows_) order.push_back(r.clipId);
  return order;
}

void CompExecutor::transportResolve(double dtSec) {
  // Drain FIRST and unconditionally: pixel-chain effects can queue seeks
  // during render(), landing after last frame's drain — they must not strand
  // when no transport section exists.
  drainStreamOps();
  transportResolved_.assign(transportRows_.size(), TransportResolved{});
  // Gate on the SKETCH, not the rows: a follower-only section has zero driven
  // rows but must still execute (its whole job is watching + launching).
  if (transportCleanSketch_.is_null()) {
    streamsTable_.appliedContentSec.clear();
    transportEnded_.clear();
    return;
  }
#ifndef __wasm__
  // Same rebind render() does — the fold + execute below use effrt.
  sketch_executor::effrtSetRuntime(rt_);
  effect_runtime::setHostBarPhase(std::fmod(std::max(0.0, state_.positionBeat) / 4.0, 1.0));
  effect_runtime::setHostBpm(doc_.baseBPM);
#endif
  if (transportInTex_ < 0) {
    // All section effects are identity and never tap textures — two cached 1x1
    // dummies satisfy the executor's surface contract with zero dispatches.
    transportInTex_ = gpu_create_texture(1, 1, 1);
    transportOutTex_ = gpu_create_texture(1, 1, 1);
  }
  transportExecSketch_ = transportCleanSketch_;
  foldPublishedOutputs(transportExecSketch_);  // intra-section wires, 1-frame
  transportEx_->setFrameTime(transportSec_);
  transportEx_->execute(transportExecSketch_, transportInTex_, transportOutTex_, 1, 1, dtSec,
                        transportDirty_);
  transportDirty_ = false;

  static constexpr const char* kFields[10] = {
      "transport_time_sec",      "transport_active",
      "transport_rate",          "transport_next_jump_sec",
      "transport_jump_target_sec", "transport_loop_start_sec",
      "transport_loop_end_sec",  "transport_ended",
      "transport_next_end_sec",  "transport_loop_count"};
  for (size_t i = 0; i < transportRows_.size(); ++i) {
    const TransportRow& row = transportRows_[i];
    const int32_t inst =
        effrt_instance_for(row.moduleType.data(), static_cast<int32_t>(row.moduleType.size()),
                           row.instanceKey.data(), static_cast<int32_t>(row.instanceKey.size()));
    if (inst < 0) continue;  // pre-instance frame → invalid row → fallback
    TransportResolved r;
    double* slots[10] = {&r.timeSec,       &r.active,       &r.rate,       &r.nextJumpSec,
                         &r.jumpTargetSec, &r.loopStartSec, &r.loopEndSec, &r.ended,
                         &r.nextEndSec,    &r.loopCount};
    for (int f = 0; f < 10; ++f) {
      double v = 0.0;
      if (effrt_published_scalar(inst, kFields[f],
                                 static_cast<int32_t>(std::strlen(kFields[f])), &v)) {
        *slots[f] = v;
        if (f == 0) r.valid = true;  // transport_time_sec is the required field
      }
    }
    transportResolved_[i] = r;
  }

  // Applied content time (streams pos(content) + the pump's target): valid +
  // active rows override the built-in mapping; everything else falls back.
  // Ended latches feed the scene auto-stop; both prune to the live row set.
  streamsTable_.appliedContentSec.clear();
  std::set<std::string> liveIds;
  for (size_t i = 0; i < transportRows_.size(); ++i) {
    liveIds.insert(transportRows_[i].clipId);
    const TransportResolved& r = transportResolved_[i];
    if (!r.valid) continue;
    if (r.active >= 0.5) streamsTable_.appliedContentSec[transportRows_[i].clipId] = r.timeSec;
    if (r.ended >= 0.5) transportEnded_.insert(transportRows_[i].clipId);
    // Fold the controller's DECLARED future into the clip's content stream
    // (streams events; LOCK-STEP: StreamsRegistry.foldDecl). nextEndSec is
    // REMAINING seconds → absolute elapsed, quantized to 10 ms so per-frame
    // jitter doesn't churn the rev; loop_count increments append 'looped'
    // edges (integer compares — no fp hazard).
    auto cit = streamsTable_.contentByClipId.find(transportRows_[i].clipId);
    if (cit != streamsTable_.contentByClipId.end()) {
      if (StreamInfo* s = streamsTable_.findMutable(cit->second)) {
        if (!s->declared) {
          s->declared = true;
          s->eventRev++;
        }
        const double nowElapsed = streamElapsed(*s, streamsTable_, 0.0);
        const double absEnd =
            r.nextEndSec >= 0 ? std::round((nowElapsed + r.nextEndSec) * 100.0) / 100.0 : -1;
        if (absEnd != s->declNextEnd) {
          s->declNextEnd = absEnd;
          s->eventRev++;
        }
        const double k = std::floor(r.loopCount);
        if (k < s->declLoopCount) {  // controller restarted its count
          s->dynEvents.clear();
          s->declLoopCount = 0;
          s->eventRev++;
        }
        while (s->declLoopCount < k) {
          s->declLoopCount += 1;
          StreamEvent e;
          e.time = nowElapsed;
          e.kind = 2;
          e.clipOrdinal = static_cast<int32_t>(s->declLoopCount);
          e.idHash48 = clipIdHash48(s->ownerId);
          s->dynEvents.push_back(e);
        }
      }
    }
  }
  // Streams whose controller vanished revert to the built-in analytics.
  for (auto& s : streamsTable_.streams) {
    if (s.declared && !liveIds.count(s.ownerId)) {
      s.declared = false;
      s.declNextEnd = -1;
      s.declLoopCount = 0;
      s.dynEvents.clear();
      s.eventRev++;
    }
  }
  for (auto it = transportEnded_.begin(); it != transportEnded_.end();) {
    if (!liveIds.count(*it)) it = transportEnded_.erase(it);
    else ++it;
  }

  // ── FORK fader fold: while a track has a live fork, its TRACK transport
  // section's published `xfade_mix` (+ optional `xfade_shape`) rides the
  // automation channel onto the build's track_<tid>_xfade blend node —
  // same-frame, both hosts, zero new channels (automation_ was rebuilt by
  // this frame's update(); render() consumes it via setAutomation).
  for (const auto& [trackId, f] : fork_) {
    const TrackM* track = nullptr;
    for (const auto& t : doc_.tracks) {
      if (t.id == trackId) { track = &t; break; }
    }
    if (!track || !track->hasTransport) continue;
    for (const auto& d : track->transport.devices) {
      if (!catalog_.has(d.moduleType)) continue;
      const std::string key = trackTransportInstanceKey(trackId, d.id);
      const int32_t inst =
          effrt_instance_for(d.moduleType.data(), static_cast<int32_t>(d.moduleType.size()),
                             key.data(), static_cast<int32_t>(key.size()));
      if (inst < 0) continue;
      double mix = 0;
      if (!effrt_published_scalar(inst, "xfade_mix", 9, &mix)) continue;
      const std::string xkey = trackInstanceKey(trackId, "xfade");
      automation_.push_back({{"instance", xkey},
                             {"field", "opacity"},
                             {"value", std::max(0.0, std::min(1.0, mix))},
                             {"combine", "replace"},
                             {"magnitude", "unsigned"}});
      double shape = 0;
      if (effrt_published_scalar(inst, "xfade_shape", 11, &shape)) {
        automation_.push_back({{"instance", xkey},
                               {"field", "__xfade_shape__"},
                               {"value", shape},
                               {"combine", "replace"},
                               {"magnitude", "unsigned"}});
      }
      break;  // first publishing device wins
    }
  }

  // Second drain: ops the section fired DURING this execute apply same-frame
  // (a follower's launch evicts the current scene at the very next update —
  // ahead of the heal that would otherwise race it).
  drainStreamOps();
}

void CompExecutor::drainStreamOps() {
  if (streamsTable_.pendingOps.empty()) return;
  // Move-out first: launchScene/stopScene mutate the table's scene anchors,
  // and a re-entrant push mid-drain must not invalidate iteration.
  std::vector<StreamsTable::StreamOp> ops = std::move(streamsTable_.pendingOps);
  streamsTable_.pendingOps.clear();
  for (const auto& op : ops) {
    const StreamInfo* s = streamsTable_.find(op.handle);
    if (!s) {
      // RESOURCE-handle verbs: fork arm/re-assert (kind 3) and fork release
      // (kind 1) — the streamless generative-clip path (a video clip's
      // content-stream handle resolves the same way below).
      const ResourceInfo* r = streamsTable_.findResource(op.handle);
      if (!r) continue;
      const std::string& clipId = r->ownerId;
      auto pit = streamsTable_.parentByClipId.find(clipId);
      const StreamInfo* pt =
          pit != streamsTable_.parentByClipId.end() ? streamsTable_.find(pit->second) : nullptr;
      if (!pt || pt->kind != kStreamKindSceneTrack) continue;
      const std::string& trackId = pt->ownerId;
      if (op.kind == 3) {
        auto fit = fork_.find(trackId);
        if (fit != fork_.end() && fit->second.clipId == clipId) {
          fit->second.assertAgeSec = 0;
          continue;
        }
        auto lit = sceneLaunch_.find(trackId);
        if (lit != sceneLaunch_.end() && lit->second.sceneId == clipId) {
          auto& arm = forkArm_[trackId];
          arm.clipId = clipId;
          arm.ageSec = 0;
        }
      } else if (op.kind == 1) {
        auto fit = fork_.find(trackId);
        if (fit != fork_.end() && fit->second.clipId == clipId) releaseFork(trackId);
      }
      continue;
    }
    if (s->kind == kStreamKindVideoContent) {
      // Content-handle verbs exist only for the FORK lifecycle (LOCK-STEP:
      // the web drain forwards these raw via comp_queue_stream_op, so this
      // branch is the single implementation on both hosts). Resolve the
      // owning scene track first.
      const std::string& clipId = s->ownerId;
      auto pit = streamsTable_.parentByClipId.find(clipId);
      const StreamInfo* pt =
          pit != streamsTable_.parentByClipId.end() ? streamsTable_.find(pit->second) : nullptr;
      if (!pt || pt->kind != kStreamKindSceneTrack) continue;
      const std::string& trackId = pt->ownerId;
      if (op.kind == 3) {
        // fork arm / re-assert: a LIVE fork of this clip refreshes its keep-
        // alive; else arming requires the clip to be the track's live scene.
        auto fit = fork_.find(trackId);
        if (fit != fork_.end() && fit->second.clipId == clipId) {
          fit->second.assertAgeSec = 0;
          continue;
        }
        auto lit = sceneLaunch_.find(trackId);
        if (lit != sceneLaunch_.end() && lit->second.sceneId == clipId) {
          auto& arm = forkArm_[trackId];
          arm.clipId = clipId;
          arm.ageSec = 0;
        }
        continue;
      }
      if (op.kind == 1) {
        // streams.stop on a fork stream releases it (the fade-done call).
        auto fit = fork_.find(trackId);
        if (fit != fork_.end() && fit->second.clipId == clipId) releaseFork(trackId);
        continue;
      }
      continue;  // content-handle seek/announce: future (owner re-timing)
    }
    if (s->kind != kStreamKindSceneTrack) continue;  // seekable timelines: future
    if (op.kind == 1) {
      stopScene(s->ownerId);
      continue;
    }
    // Announce retract (t < 0) resolves BEFORE the ordinal guard — floor(-1)
    // must not fall into the bad-ordinal silent drop.
    if (op.kind == 2 && op.t < 0) {
      announceScene(s->ownerId, std::string(), 0, 0);
      continue;
    }
    const int32_t ord = static_cast<int32_t>(std::floor(op.t));
    if (ord < 0 || ord >= static_cast<int32_t>(s->byOrdinalClipId.size())) continue;
    // Launchable = has a START event (the event list already excludes
    // bypassed/empty scenes — the trigger matcher's rules; a raw seek must
    // not create a phantom playing state). LOCK-STEP: the web drain applies
    // the same events-based check for seek AND announce.
    bool launchable = false;
    for (const auto& e : s->events) {
      if (e.kind == 0 && e.clipOrdinal == ord) { launchable = true; break; }
    }
    if (!launchable) continue;
    if (op.kind == 2) {
      // streams.announce: declared future launch — a precache hint, no
      // engine mutation. The eventual seek carries the operative class.
      announceScene(s->ownerId, s->byOrdinalClipId[static_cast<size_t>(ord)], op.eta,
                    static_cast<int32_t>(op.cls));
      continue;
    }
    // Streams-verb launches come from transport effects (autopilot): Loose —
    // Live mode may linger on the outgoing scene while the incoming warms.
    launchScene(s->ownerId, s->byOrdinalClipId[static_cast<size_t>(ord)],
                static_cast<int32_t>(op.cls));
  }
}

uint32_t CompExecutor::update(double dtSec) {
  uint32_t flags = 0;
  if (!docLoaded_) return 0;

  // Verb ordering: ops queued since the last resolve apply BEFORE the
  // pending-commit evaluation below. The WEB drain forwards raw fork arms
  // via comp_queue_stream_op AFTER its comp_transport_resolve call, so an
  // arm queued in the same effect tick as its seek would otherwise sit in
  // pendingOps until the NEXT transportResolve — and applyPendingLaunches
  // would commit that seek's handover first, seeing no arm (a cut instead
  // of a detach). Draining here makes same-frame arm+seek safe on both
  // hosts by construction.
  drainStreamOps();
  // Scene lifecycle first: pending handovers commit the moment their video is
  // ready (BEFORE the heal, so a fresh commit can't be same-frame stopped and
  // the heal sees the committed map), then elapsed one-shots auto-stop (and
  // dangling entries drop) before this frame's eval.
  applyPendingLaunches(dtSec);
  healSceneLaunches();
  // streams.announce records age on WALL-CLOCK and expire when not
  // re-asserted (the announcing effect died or went silent). Runs PRE-HOLD —
  // a Precise hold outlasts the stale window while sections keep ticking, so
  // ageing after the hold's early return would never expire anything.
  for (auto it = announces_.begin(); it != announces_.end();) {
    it->second.ageSec += std::max(0.0, dtSec);
    if (it->second.ageSec > kAnnounceStaleSec) {
      it = announces_.erase(it);
      invalidateEval();
    } else {
      ++it;
    }
  }
  // fork arms + detached forks age on WALL-CLOCK too (same PRE-hold rule):
  // an arm not re-asserted expires quietly; a detached fork releases when its
  // owner goes silent, when the TTL backstop trips, or when a doc edit
  // removed its clip (the heal's validation, fork flavored).
  for (auto it = forkArm_.begin(); it != forkArm_.end();) {
    it->second.ageSec += std::max(0.0, dtSec);
    if (it->second.ageSec > kForkArmStaleSec) it = forkArm_.erase(it);
    else ++it;
  }
  for (auto it = fork_.begin(); it != fork_.end();) {
    it->second.ageSec += std::max(0.0, dtSec);
    it->second.assertAgeSec += std::max(0.0, dtSec);
    const bool dead = it->second.assertAgeSec > kForkArmStaleSec ||
                      it->second.ageSec > kForkMaxSec ||
                      !findSceneClip(it->first, it->second.clipId);
    const std::string trackId = it->first;
    ++it;
    if (dead) releaseFork(trackId);
  }
  // Follow-candidate precache arming is TIME-based and must flip mid-span
  // (evals skip during steady playback): re-eval when the armed set changes.
  {
    std::string arm;
    for (const auto& [trackId, l] : sceneLaunch_) {
      if (scenePrewarmWanted(trackId, l)) {
        arm += trackId;
        arm += ';';
      }
    }
    if (arm != precacheArm_) {
      precacheArm_ = arm;
      invalidateEval();
    }
  }
  if (scenesDirty_) {
    flags |= kCompScenesChanged;
    scenesDirty_ = false;
  }

  // Make the eval current at the PRE-advance playhead (the gate decides on the
  // frame the user is looking at) — this is where a seek's re-eval lands.
  // Steady playback inside one span skips this.
  bool evaled = ensureEvalAt(state_.positionBeat, flags);

  // ── Precise gate (engine-bridge showComposite + the app's advance rule):
  // with unready active video the transport freezes AND the displayed
  // composite holds; a fail-safe timeout forces through a stuck decode.
  const bool ready = videoReady(evalActiveDescs_);
  holding_ = shouldHoldPrecise(precise_, forceBypass_,
                               static_cast<int>(evalActiveDescs_.size()), ready);
  if (holding_) {
    holdClock_ += std::max(0.0, dtSec);
    if (holdClock_ > kForceTimeoutSec) forceBypass_ = true;  // next frame forces through
    flags |= kCompHoldingPrecise;
    if (hasContent_) flags |= kCompHasContent;
    // Keep the on-screen clips alive alongside the (warm) target while holding;
    // the union must collapse back to warm-only once the hold releases.
    pumpRecheck_ = true;
    nlohmann::json unionSet = pumpUnion(evalWarmDescs_, displayedDescs_);
    if (unionSet != pumpDescs_) {
      pumpDescs_ = std::move(unionSet);
      flags |= kCompVideoSetChanged;
      pruneReadyClips();
    }
    // Automation still evaluates (frozen beat → stable values).
    automation_ = automationEntriesForTree(doc_, evalTree_, state_.positionBeat, clipLoopMode_,
                                         &layerTargets_);
    transportSec_ = transport_.secondsAt(state_, clock_);
    sampleStreamsFrame();
    return flags;
  }
  holdClock_ = 0;
  forceBypass_ = false;

  transport_.advance(state_, clock_, dtSec);
  transportSec_ = transport_.secondsAt(state_, clock_);

  // ── Evaluate + (re)build at the advanced playhead (skipped within the span).
  evaled |= ensureEvalAt(state_.positionBeat, flags);
  if (hasContent_) flags |= kCompHasContent;

  // ── Commit: the pump follows the (warm) target; displayed = the new active
  // set. Within a span with an untouched document neither set can change, so
  // the deep compares only run on a real eval (or right after a hold released).
  if (evaled || pumpRecheck_) {
    displayedDescs_ = evalActiveDescs_;
    if (evalWarmDescs_ != pumpDescs_) {
      pumpDescs_ = evalWarmDescs_;
      flags |= kCompVideoSetChanged;
      // Readiness is only knowable for clips the pump is feeding: a clip that
      // left the pump set had its decoder DISPOSED — a stale ready latch would
      // make its next launch commit instantly against a closed pump (the
      // handover flash this whole mechanism exists to prevent).
      pruneReadyClips();
    }
    pumpRecheck_ = false;
  }

  // Lane/curve values vary continuously — evaluate every frame, but over the
  // span's cached tree (no per-frame tree rebuild).
  automation_ = automationEntriesForTree(doc_, evalTree_, state_.positionBeat, clipLoopMode_,
                                         &layerTargets_);
  sampleStreamsFrame();
  return flags;
}

void CompExecutor::pruneReadyClips() {
  if (readyClips_.empty()) return;
  std::set<std::string> pumped;
  for (const auto& d : pumpDescs_) {
    if (d.contains("clipId") && d["clipId"].is_string()) {
      pumped.insert(d["clipId"].get<std::string>());
    }
  }
  for (auto it = readyClips_.begin(); it != readyClips_.end();) {
    if (!pumped.count(*it)) it = readyClips_.erase(it);
    else ++it;
  }
}

nlohmann::json CompExecutor::pumpUnion(const nlohmann::json& target,
                                       const nlohmann::json& displayed) {
  // precise_gate.pumpActiveSet over raw desc JSON (union by clipId, target
  // wins values, displayed order first).
  std::vector<nlohmann::json> targetV(target.begin(), target.end());
  std::vector<nlohmann::json> displayedV(displayed.begin(), displayed.end());
  auto merged = pumpActiveSet(true, targetV, displayedV, [](const nlohmann::json& d) {
    return d.value("clipId", std::string());
  });
  return nlohmann::json(std::move(merged));
}

void CompExecutor::foldPublishedOutputs(nlohmann::json& sketch) {
  // executor-host.ts step 3: mirror each instance's LIVE published PURE-OUTPUT
  // scalars into the sketch state the executor's write-taps read (1-frame
  // latency, matching the barrel's state-doc mirroring). Field names come
  // statically from the catalog, so each read is one numeric published_scalar
  // call — no JSON on this per-frame path.
  if (!sketch.is_object() || !sketch.contains("chain")) return;
  auto& instances = sketch["instances"];
  for (const auto& e : sketch["chain"]) {
    const std::string mt = e.value("module_type", std::string());
    const std::string key = e.value("instance_key", std::string());
    const auto outFields = catalog_.publishedOutFields(mt);
    if (outFields.empty()) continue;
    const int32_t inst = effrt_instance_for(mt.data(), static_cast<int32_t>(mt.size()),
                                            key.data(), static_cast<int32_t>(key.size()));
    if (inst < 0) continue;
    for (const auto& field : outFields) {
      double v = 0.0;
      if (!effrt_published_scalar(inst, field.data(),
                                  static_cast<int32_t>(field.size()), &v))
        continue;
      auto& instObj = instances[key];
      if (!instObj.is_object()) instObj = {{"module_type", mt}};
      auto& state = instObj["state"];
      if (!state.is_object()) state = nlohmann::json::object();
      state[field] = v;
    }
  }
}

int32_t CompExecutor::render(int32_t inTex, int32_t outTex, int32_t W, int32_t H, double dt) {
  if (!docLoaded_ || !hasContent_ || cleanSketch_.is_null()) return inTex;
#ifndef __wasm__
  // Bind the effrt forwarders BEFORE the fold: natively the handle table is
  // frame-local and only execute() rebinds it — the fold's effrt_instance_for
  // would otherwise see a stale/null runtime on the first frame.
  sketch_executor::effrtSetRuntime(rt_);
  // The comp transport owns the host clock during its render: barPhase from
  // the REAL beat (exact even under warp; 4 beats/bar) — beat-reactive
  // effects (mod.trigger.beat) would otherwise tick a wall-clock 120 BPM.
  effect_runtime::setHostBarPhase(std::fmod(std::max(0.0, state_.positionBeat) / 4.0, 1.0));
  effect_runtime::setHostBpm(doc_.baseBPM);
#endif
  execSketch_ = cleanSketch_;  // fresh copy → last frame's folded outputs can't go stale
  foldPublishedOutputs(execSketch_);
  ex_->setFrameTime(transportSec_);
  ex_->setAutomation(automation_);
  const int32_t out = ex_->execute(execSketch_, inTex, outTex, W, H, dt, dirty_);
  dirty_ = false;
  // Rail-driven structural bypass: sample the rails AFTER the frame computed
  // them; the decisions feed the NEXT update()'s eval compare (1-frame loop).
  readRailBypassSignals();
  // Trigger events: consume the sources' published rings and launch matching
  // scenes — the launch lands next update() (the same 1-frame loop).
  readTriggerSignals();
  return out;
}

void CompExecutor::rebuildTriggerRoutes() {
  triggerRoutes_.clear();
  auto routeSketch = [&](const SketchSpecM& sketch, const std::vector<TriggerExportM>* exports,
                         const std::string& ownerId, bool isClip) {
    for (const auto& d : sketch.devices) {
      if (!catalog_.hasCapability(d.moduleType, "trigger_source")) continue;
      std::string railId = kGlobalTriggerRailId;
      if (exports) {
        for (const auto& e : *exports) {
          if (e.sourceDeviceId == d.id && !e.railId.empty()) {
            railId = e.railId;
            break;
          }
        }
      }
      const std::string key =
          isClip ? clipInstanceKey(ownerId, d.id) : trackInstanceKey(ownerId, d.id);
      triggerRoutes_[key] = {d.moduleType, std::move(railId)};
    }
  };
  for (const auto& t : doc_.tracks) {
    // Track-hosted sources always write global in v1 (exports are clip-level).
    routeSketch(t.sketch, nullptr, t.id, /*isClip=*/false);
    for (const auto& c : t.clips) {
      routeSketch(c.sketch, &c.triggerExports, c.id, /*isClip=*/true);
    }
  }
  // Drop stale seq baselines (deleted devices). Live keys keep theirs.
  for (auto it = triggerSeqSeen_.begin(); it != triggerSeqSeen_.end();) {
    if (!triggerRoutes_.count(it->first)) it = triggerSeqSeen_.erase(it);
    else ++it;
  }
}

void CompExecutor::readTriggerSignals() {
  if (triggerRoutes_.empty()) return;
  // 1. Consume new events from every routed live trigger source, in route order
  //    (stable across frames — std::map). A source only ticks while its owning
  //    chain is in the BUILT sketch (no live instance ⇒ nothing to read).
  struct Ev {
    std::string railId;
    int channel = 0;
  };
  std::vector<Ev> fired;
  for (const auto& [key, route] : triggerRoutes_) {
    const int32_t inst =
        effrt_instance_for(route.moduleType.data(), static_cast<int32_t>(route.moduleType.size()),
                           key.data(), static_cast<int32_t>(key.size()));
    if (inst < 0) continue;
    // Numeric ring read (effrt.h layout: seq/on/channel/velocity/deadline per
    // event). Ring caps are ≤16; 32 leaves headroom. -1 = no ring published
    // yet (defer watermarking); 0 = ring exists but empty (still baselines the
    // watermark below, so the FIRST event isn't swallowed as "first sight").
    double buf[32 * 5];
    const int32_t n = effrt_read_triggers(inst, buf, 32);
    if (n < 0) continue;
    long long maxSeq = 0;
    for (int32_t k = 0; k < n; ++k)
      maxSeq = std::max(maxSeq, static_cast<long long>(buf[k * 5]));
    auto seen = triggerSeqSeen_.find(key);
    if (seen == triggerSeqSeen_.end()) {
      // First sight: baseline at the ring's max — never replay history (a clip
      // re-entering the composite must not re-fire its old events).
      triggerSeqSeen_[key] = maxSeq;
      continue;
    }
    if (maxSeq < seen->second) seen->second = 0;  // instance reset → resync
    long long last = seen->second;
    for (int32_t k = 0; k < n; ++k) {
      const double* ev = buf + k * 5;
      const long long seq = static_cast<long long>(ev[0]);
      if (seq <= last) continue;
      seen->second = std::max(seen->second, seq);
      // `on` + `channel` required (NaN channel = unpublished → skip, watermark
      // already advanced); velocity/precision ride along for future consumers —
      // web/comp does not enforce strict precision, so scenes ignore
      // off/velocity/precision and launch immediately.
      if (ev[1] == 0.0) continue;
      if (std::isnan(ev[2])) continue;
      fired.push_back({route.railId, static_cast<int>(std::lround(ev[2]))});
    }
  }
  if (fired.empty()) return;
  // 2. Match against scene tracks: effective listen rail = scene ?? track ??
  //    global; channel via the lock-step auto-assignment; the FIRST matching
  //    scene in array order wins one event; a LATER event overwrites the slot.
  for (const auto& t : doc_.tracks) {
    if (t.kind != TrackKind::Scene || t.bypassed) continue;
    const std::vector<int> channels = sceneChannelAssignments(t);
    for (const auto& ev : fired) {
      for (size_t i = 0; i < t.clips.size(); ++i) {
        const auto& scene = t.clips[i];
        if (scene.bypassed) continue;
        if (!comp::clipHasContent(scene)) continue;  // empty
        const std::string& rail = !scene.triggerReadRailId.empty() ? scene.triggerReadRailId
                                  : !t.triggerReadRailId.empty()   ? t.triggerReadRailId
                                                                   : kGlobalTriggerRailId;
        if (rail != ev.railId || channels[i] != ev.channel) continue;
        launchScene(t.id, scene.id);
        break;
      }
    }
  }
}

void CompExecutor::readRailBypassSignals() {
  railBypassDecisions_.clear();
  for (const auto& t : doc_.tracks) {
    if (t.kind == TrackKind::Rail || t.bypassed) continue;
    for (const auto& read : t.reads) {
      if (read.targetDeviceId != kLayerTargetId || read.targetField != "bypass") continue;
      const std::string key = "rail_" + read.railId;
      static constexpr const char* kRailType = "mod.shaper.remap";
      const int32_t inst = effrt_instance_for(kRailType,
                                              static_cast<int32_t>(std::strlen(kRailType)),
                                              key.data(), static_cast<int32_t>(key.size()));
      bool on = false;
      if (inst >= 0) {
        // The rail relay's live `output`, via the same numeric published-state
        // seam foldPublishedOutputs reads producers through.
        double v = 0.0;
        if (effrt_published_scalar(inst, "output", 6, &v)) on = v >= 0.5;
      }
      auto it = railBypassDecisions_.find(t.id);
      railBypassDecisions_[t.id] = (it != railBypassDecisions_.end() && it->second) || on;
    }
  }
}

const std::string& CompExecutor::requiredJson() {
  nlohmann::json req = nlohmann::json::array();
  if (cleanSketch_.is_object() && cleanSketch_.contains("chain")) {
    for (const auto& e : cleanSketch_["chain"]) {
      req.push_back({{"moduleType", e.value("module_type", std::string())},
                     {"instanceKey", e.value("instance_key", std::string())}});
    }
  }
  // Transport-section instances ride the same ensure/prune contract (the web
  // creates them + compRequiredKeys protects them). chainKeysJson (trace
  // remap) deliberately stays pixel-only.
  if (transportCleanSketch_.is_object() && transportCleanSketch_.contains("chain")) {
    for (const auto& e : transportCleanSketch_["chain"]) {
      req.push_back({{"moduleType", e.value("module_type", std::string())},
                     {"instanceKey", e.value("instance_key", std::string())}});
    }
  }
  // Pending handovers + primed precache candidates: the post-commit worlds'
  // chains pre-instantiate so a commit's first frame renders complete
  // (dedupe: unchanged tracks repeat).
  {
    std::set<std::string> have;
    for (const auto& e : req) have.insert(e["instanceKey"].get<std::string>());
    for (const nlohmann::json* sk : {&pendingSketch_, &candidateSketch_}) {
      if (!sk->is_object() || !sk->contains("chain")) continue;
      for (const auto& e : (*sk)["chain"]) {
        const std::string key = e.value("instance_key", std::string());
        if (!have.insert(key).second) continue;
        req.push_back({{"moduleType", e.value("module_type", std::string())},
                       {"instanceKey", key}});
      }
    }
  }
  requiredScratch_ = req.dump();
  return requiredScratch_;
}

const std::string& CompExecutor::chainKeysJson() {
  nlohmann::json keys = nlohmann::json::array();
  if (cleanSketch_.is_object() && cleanSketch_.contains("chain")) {
    for (const auto& e : cleanSketch_["chain"]) {
      keys.push_back(e.value("instance_key", std::string()));
    }
  }
  chainKeysScratch_ = keys.dump();
  return chainKeysScratch_;
}

const std::string& CompExecutor::videoDescsJson() {
  videoDescsScratch_ = pumpDescs_.dump();
  return videoDescsScratch_;
}

const std::string& CompExecutor::layerTargetsJson() {
  layerTargetsScratch_ = layerTargets_.dump();
  return layerTargetsScratch_;
}

const std::string& CompExecutor::streamsJson() {
  streamsScratch_ = streamsTableJson(streamsTable_);
  return streamsScratch_;
}

const std::string& CompExecutor::transportOrderJson() {
  nlohmann::json order = nlohmann::json::array();
  for (const auto& r : transportRows_) order.push_back(r.clipId);
  transportOrderScratch_ = order.dump();
  return transportOrderScratch_;
}

const std::string& CompExecutor::sceneStatesJson() {
  nlohmann::json out = nlohmann::json::object();
  for (const auto& [trackId, l] : sceneLaunch_) {
    // launchSec is SHIPPED so the web registry anchors with the identical
    // double (never re-derives seconds from the beat — warp-sin ulp trap).
    out[trackId] = {{"sceneId", l.sceneId},
                    {"launchBeat", l.launchBeat},
                    {"launchSec", l.launchSec}};
  }
  // A live fork rides its track's entry: the web registry re-applies the
  // frozen anchors so the outgoing playback survives doc reloads mid-fade.
  for (const auto& [trackId, f] : fork_) {
    out[trackId]["fork"] = {{"clipId", f.clipId},
                            {"anchorBeat", f.anchorBeat},
                            {"anchorSec", f.anchorSec}};
  }
  sceneStatesScratch_ = out.dump();
  return sceneStatesScratch_;
}

const std::string& CompExecutor::pendingScenesJson() {
  // Deferred handovers (gapless): shipped beside sceneStatesJson so the UI can
  // highlight the INCOMING scene through the pending window (matching the
  // store's optimistic click state) — the streams registry keeps reading the
  // LIVE map only (committed semantics).
  nlohmann::json out = nlohmann::json::object();
  for (const auto& [trackId, p] : pendingLaunch_) {
    out[trackId] = {{"sceneId", p.sceneId},
                    {"launchBeat", p.requestBeat},
                    {"launchSec", p.requestSec},
                    {"cls", p.cls}};
  }
  pendingScenesScratch_ = out.dump();
  return pendingScenesScratch_;
}

}  // namespace comp
