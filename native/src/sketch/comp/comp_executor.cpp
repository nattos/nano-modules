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
  for (const auto& [trackId, l] : sceneLaunch_) {
    auto it = streamsTable_.contentByClipId.find(l.sceneId);
    if (it == streamsTable_.contentByClipId.end()) continue;
    if (StreamInfo* s = streamsTable_.findMutable(it->second)) s->anchorBeat = l.launchBeat;
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
    if (s.kind == kStreamKindSceneTrack)
      s.liveOrdinal = std::numeric_limits<double>::quiet_NaN();
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
    if (t.id == ownerId && patch(t.sketch)) return;
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

void CompExecutor::launchScene(const std::string& trackId, const std::string& sceneId) {
  SceneLaunch& l = sceneLaunch_[trackId];
  l.sceneId = sceneId;
  l.launchBeat = state_.positionBeat;  // immediate: anchor at the current beat
  l.launchSec = clock_.secondsAt(l.launchBeat);
  // A (re)launch clears any latched transport_ended for this scene — else a
  // controller's stale latch (still live in the effect instance) would let
  // the next heal kill the relaunch before the effect re-arms.
  transportEnded_.erase(sceneId);
  // The scene's content stream re-anchors too: its lazy position mapping runs
  // from the launch beat, exactly like the tree's anchorBeat.
  auto it = streamsTable_.contentByClipId.find(sceneId);
  if (it != streamsTable_.contentByClipId.end()) {
    if (StreamInfo* s = streamsTable_.findMutable(it->second)) s->anchorBeat = l.launchBeat;
  }
  scenesDirty_ = true;
  invalidateEval();
}

void CompExecutor::stopScene(const std::string& trackId) {
  if (!sceneLaunch_.erase(trackId)) return;
  scenesDirty_ = true;
  invalidateEval();
}

void CompExecutor::stopAllScenes() {
  if (sceneLaunch_.empty()) return;
  sceneLaunch_.clear();
  scenesDirty_ = true;
  invalidateEval();
}

void CompExecutor::healSceneLaunches() {
  for (auto it = sceneLaunch_.begin(); it != sceneLaunch_.end();) {
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
          if (!d.is_null()) descs.push_back(std::move(d));
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

  // Span hit: the evaluation at evalBeat_ is valid for [evalBeat_, boundary).
  // Backward motion (seek/loop wrap) falls out of the half-open interval and
  // re-evaluates — even landing back inside a previously-evaluated span, one
  // conservative re-eval beats tracking span history.
  if (evalValid_ && beat >= evalBeat_ && beat < evalNextBoundary_) return false;

  evalCount_++;
  evalBypassDecisions_ = std::move(bypassDec);
  evalRailBypass_ = railBypassDecisions_;
  evalTree_ = compositeTreeAtBeat(doc_, beat, ignoreSolo_, &evalRailBypass_, &sceneLaunch_);
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
  std::function<void(const std::vector<CompNode>&)> walk =
      [&](const std::vector<CompNode>& nodes) {
        for (const auto& n : nodes) {
          if (n.isGroup) {
            walk(n.children);
            continue;
          }
          if (!n.clip || seen.count(n.clip->id)) continue;
          if (!clipHasTransportSection(*n.clip, catalog_)) continue;
          seen.insert(n.clip->id);
          clips.push_back(n.clip);
        }
      };
  walk(evalTree_);
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

  nlohmann::json built = buildTransportSketch(clips, catalog_);
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

  static constexpr const char* kFields[8] = {
      "transport_time_sec",      "transport_active",
      "transport_rate",          "transport_next_jump_sec",
      "transport_jump_target_sec", "transport_loop_start_sec",
      "transport_loop_end_sec",  "transport_ended"};
  for (size_t i = 0; i < transportRows_.size(); ++i) {
    const TransportRow& row = transportRows_[i];
    const int32_t inst =
        effrt_instance_for(row.moduleType.data(), static_cast<int32_t>(row.moduleType.size()),
                           row.instanceKey.data(), static_cast<int32_t>(row.instanceKey.size()));
    if (inst < 0) continue;  // pre-instance frame → invalid row → fallback
    TransportResolved r;
    double* slots[8] = {&r.timeSec,       &r.active,       &r.rate,       &r.nextJumpSec,
                        &r.jumpTargetSec, &r.loopStartSec, &r.loopEndSec, &r.ended};
    for (int f = 0; f < 8; ++f) {
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
  }
  for (auto it = transportEnded_.begin(); it != transportEnded_.end();) {
    if (!liveIds.count(*it)) it = transportEnded_.erase(it);
    else ++it;
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
    if (!s || s->kind != kStreamKindSceneTrack) continue;  // seekable timelines: future
    if (op.kind == 1) {
      stopScene(s->ownerId);
      continue;
    }
    const int32_t ord = static_cast<int32_t>(std::floor(op.t));
    if (ord < 0 || ord >= static_cast<int32_t>(s->byOrdinalClipId.size())) continue;
    // Launchable = has a START event (the event list already excludes
    // bypassed/empty scenes — the trigger matcher's rules; a raw seek must
    // not create a phantom playing state). LOCK-STEP: the web drain applies
    // the same events-based check.
    bool launchable = false;
    for (const auto& e : s->events) {
      if (e.kind == 0 && e.clipOrdinal == ord) { launchable = true; break; }
    }
    if (!launchable) continue;
    launchScene(s->ownerId, s->byOrdinalClipId[static_cast<size_t>(ord)]);
  }
}

uint32_t CompExecutor::update(double dtSec) {
  uint32_t flags = 0;
  if (!docLoaded_) return 0;

  // Scene lifecycle first: elapsed one-shots auto-stop (and dangling entries
  // drop) before this frame's eval, so the launch map the tree sees is current.
  healSceneLaunches();
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
        if (!scene.hasSourceUrl && scene.sketch.devices.empty()) continue;  // empty
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
    out[trackId] = {{"sceneId", l.sceneId}, {"launchBeat", l.launchBeat}};
  }
  sceneStatesScratch_ = out.dump();
  return sceneStatesScratch_;
}

}  // namespace comp
