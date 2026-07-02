// comp_executor.cpp — see comp_executor.h. TS twins being inverted:
// engine-bridge.ts (showComposite / precise hold / pump reconcile shape),
// composite-frame.ts (videoDescFor), arrangement-app.ts (the gate-freezes-
// transport rule), executor-host.ts step 3 (producer-output mirror).

#include "comp_executor.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <vector>

#include "../effrt.h"
#include "comp_eval.h"
#include "precise_gate.h"

#ifndef __wasm__
namespace sketch_executor {
// effrt_impls.cpp — bind the effrt forwarders to `rt` and reset the frame's
// handle table. The comp executor must call this BEFORE its published-output
// fold (which uses effrt_instance_for ahead of the internal execute()).
void effrtSetRuntime(effect_runtime::EffectRuntime* rt);
}  // namespace sketch_executor
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
      ex_(std::make_unique<sketch_executor::SketchExecutor>(rt, registry, gpuBackend)) {}

CompExecutor::~CompExecutor() = default;

void CompExecutor::registerSchema(const std::string& moduleType, const nlohmann::json& fields) {
  catalog_.registerSchema(moduleType, fields);
  ex_->registerModuleSchema(moduleType, fields);
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
  ex_->registerModuleCapabilities(moduleType, std::move(tags));
}

void CompExecutor::rebuildClock() {
  clock_ = WarpClock(WarpCurve(derivedWarpSegments(doc_), compositionLengthBeats(doc_)),
                     doc_.baseBPM);
  transport_.reanchor();
}

void CompExecutor::loadDocument(const nlohmann::json& doc) {
  doc_ = parseComposition(doc);
  docLoaded_ = true;
  docEpoch_++;
  // Restore persisted loop markers when present (the store mirrors these too).
  if (doc.is_object() && doc.contains("loop") && doc["loop"].is_object()) {
    const auto& l = doc["loop"];
    state_.loopEnabled = l.value("enabled", state_.loopEnabled);
    state_.loopStartBeat = l.value("startBeat", state_.loopStartBeat);
    state_.loopEndBeat = l.value("endBeat", state_.loopEndBeat);
  }
  rebuildClock();
}

void CompExecutor::setDeviceParam(const std::string& ownerId, const std::string& deviceId,
                                  const std::string& field, const nlohmann::json& value) {
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
      if (c.id == ownerId && patch(c.sketch)) return;
    }
  }
}

void CompExecutor::setTrackLevel(const std::string& trackId, double level) {
  for (auto& t : doc_.tracks) {
    if (t.id == trackId) { t.level = level; return; }
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

void CompExecutor::setIgnoreSolo(bool on) { ignoreSolo_ = on; }

double CompExecutor::positionSec() const { return transport_.secondsAt(state_, clock_); }

void CompExecutor::setVideoReady(const std::string& clipId, bool ready) {
  if (ready) readyClips_.insert(clipId);
  else readyClips_.erase(clipId);
}

nlohmann::json CompExecutor::videoDescFor(const ClipM& clip) const {
  // composite-frame.ts videoDescFor — the instanceKey MUST match the clip's
  // source.video.file chain entry or the injected frame goes nowhere.
  if (!clip.hasSourceUrl) return nullptr;
  const DeviceM* dev = nullptr;
  for (const auto& d : clip.sketch.devices) {
    if (d.moduleType == kVideoSourceType) { dev = &d; break; }
  }
  if (!dev) return nullptr;
  const auto& src = clip.sourceJson;
  nlohmann::json d = {
      {"clipId", clip.id},
      {"instanceKey", clipInstanceKey(clip.id, dev->id)},
      {"url", src.value("url", std::string())},
      {"sourceKey", src.contains("sourceKey") && src["sourceKey"].is_string()
                        ? src["sourceKey"].get<std::string>()
                        : clip.id},
      {"startBeat", clip.startBeat},
      {"lengthBeat", clip.lengthBeat},
      {"durationFrames", src.contains("durationFrames") && src["durationFrames"].is_number()
                             ? src["durationFrames"]
                             : nlohmann::json(0)},
      {"scaleMode", src.value("scaleMode", std::string("fit"))},
      {"transform",
       resolveSourceTransform(src.contains("transform") ? src["transform"] : nlohmann::json())},
      {"loop", clip.loopJson.is_object() ? clip.loopJson : nlohmann::json::object()},
  };
  // Optionals: JS drops undefined keys — mirror by omitting absent fields.
  if (src.contains("fps") && src["fps"].is_number()) d["fps"] = src["fps"];
  if (clip.loopJson.is_object() && clip.loopJson.contains("speed") &&
      clip.loopJson["speed"].is_number()) {
    d["speed"] = clip.loopJson["speed"];
  }
  return d;
}

nlohmann::json CompExecutor::activeVideoDescsAtBeat(double beat) const {
  nlohmann::json descs = nlohmann::json::array();
  std::vector<CompNode> tree = compositeTreeAtBeat(doc_, beat, ignoreSolo_);
  std::vector<const ClipM*> clips;
  build_detail::collectClips(tree, clips);
  for (const ClipM* clip : clips) {
    nlohmann::json d = videoDescFor(*clip);
    if (!d.is_null()) descs.push_back(std::move(d));
  }
  return descs;
}

nlohmann::json CompExecutor::warmVideoDescsAtBeat(double beat) const {
  // Active + the lookahead precache window (store.videoClipsInWindow — video
  // clips overlapping [beat, beat+LOOKAHEAD) on non-bypassed tracks).
  nlohmann::json warm = activeVideoDescsAtBeat(beat);
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
      nlohmann::json d = videoDescFor(c);
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

uint32_t CompExecutor::update(double dtSec) {
  uint32_t flags = 0;
  if (!docLoaded_) return 0;

  // ── Precise gate (engine-bridge showComposite + the app's advance rule):
  // with unready active video the transport freezes AND the displayed
  // composite holds; a fail-safe timeout forces through a stuck decode.
  nlohmann::json activeDescs = activeVideoDescsAtBeat(state_.positionBeat);
  const bool ready = videoReady(activeDescs);
  holding_ = shouldHoldPrecise(precise_, forceBypass_,
                               static_cast<int>(activeDescs.size()), ready);
  if (holding_) {
    holdClock_ += std::max(0.0, dtSec);
    if (holdClock_ > kForceTimeoutSec) forceBypass_ = true;  // next frame forces through
    flags |= kCompHoldingPrecise;
    if (hasContent_) flags |= kCompHasContent;
    // Keep the on-screen clips alive alongside the (warm) target while holding.
    nlohmann::json warm = warmVideoDescsAtBeat(state_.positionBeat);
    nlohmann::json unionSet = pumpUnion(warm, displayedDescs_);
    if (unionSet != pumpDescs_) {
      pumpDescs_ = std::move(unionSet);
      flags |= kCompVideoSetChanged;
    }
    // Automation still evaluates (frozen beat → stable values).
    automation_ = automationEntriesAtBeat(doc_, state_.positionBeat, ignoreSolo_, clipLoopMode_);
    transportSec_ = transport_.secondsAt(state_, clock_);
    return flags;
  }
  holdClock_ = 0;
  forceBypass_ = false;

  transport_.advance(state_, clock_, dtSec);
  transportSec_ = transport_.secondsAt(state_, clock_);

  // ── Evaluate + (re)build at the advanced playhead.
  SketchBuild build =
      buildCompositeRenderAtBeat(doc_, catalog_, clock_, state_.positionBeat, ignoreSolo_);
  hasContent_ = build.hasContent;
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
    flags |= kCompHasContent;
  } else if (!cleanSketch_.is_null()) {
    cleanSketch_ = nlohmann::json();
    execSketch_ = nlohmann::json();
    chainSig_.clear();
    dirty_ = false;
    flags |= kCompStructureChanged;
  }

  // ── Commit: the pump follows the (warm) target; displayed = the new active set.
  nlohmann::json warm = warmVideoDescsAtBeat(state_.positionBeat);
  displayedDescs_ = activeVideoDescsAtBeat(state_.positionBeat);
  if (warm != pumpDescs_) {
    pumpDescs_ = std::move(warm);
    flags |= kCompVideoSetChanged;
  }

  automation_ = automationEntriesAtBeat(doc_, state_.positionBeat, ignoreSolo_, clipLoopMode_);
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
  // latency, matching the barrel's state-doc mirroring).
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
    if (publishedScratch_.size() < 256) publishedScratch_.resize(256);
    int32_t len = effrt_published_state_json(inst, publishedScratch_.data(),
                                             static_cast<int32_t>(publishedScratch_.size()));
    if (len <= 0) continue;
    if (len > static_cast<int32_t>(publishedScratch_.size())) {
      publishedScratch_.resize(static_cast<size_t>(len));
      len = effrt_published_state_json(inst, publishedScratch_.data(),
                                       static_cast<int32_t>(publishedScratch_.size()));
      if (len <= 0) continue;
    }
    const auto ps = nlohmann::json::parse(
        publishedScratch_.data(), publishedScratch_.data() + len, nullptr, false);
    if (ps.is_discarded() || !ps.is_object()) continue;
    for (const auto& field : outFields) {
      auto it = ps.find(field);
      if (it == ps.end()) continue;
      nlohmann::json v;
      if (it->is_number()) v = *it;
      else if (it->is_boolean()) v = it->get<bool>() ? 1 : 0;
      else continue;
      auto& instObj = instances[key];
      if (!instObj.is_object()) instObj = {{"module_type", mt}};
      auto& state = instObj["state"];
      if (!state.is_object()) state = nlohmann::json::object();
      state[field] = std::move(v);
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
#endif
  execSketch_ = cleanSketch_;  // fresh copy → last frame's folded outputs can't go stale
  foldPublishedOutputs(execSketch_);
  ex_->setFrameTime(transportSec_);
  ex_->setAutomation(automation_);
  const int32_t out = ex_->execute(execSketch_, inTex, outTex, W, H, dt, dirty_);
  dirty_ = false;
  return out;
}

const std::string& CompExecutor::requiredJson() {
  nlohmann::json req = nlohmann::json::array();
  if (cleanSketch_.is_object() && cleanSketch_.contains("chain")) {
    for (const auto& e : cleanSketch_["chain"]) {
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

}  // namespace comp
