// sketch_build.h — fold a composite tree into ONE executor sketch.
//
// This is the ONLY implementation: the TS twin (clip-sketch.ts) was retired
// once executor.wasm ran this code on the web too. Its output is still pinned
// byte-for-byte by the frozen goldens it was ported against
// (native/tests/fixtures/comp/build*.json, replayed by test_comp_build.cpp), so
// wire-id counters and array order are a contract: do not "clean up" iteration
// order, and new behaviour must leave every existing golden identical.
//
// The instance-key strings are a cross-boundary CONTRACT: the TS video decode
// pump injects frames by `clipInstanceKey(clipId, deviceId)`, and engine
// telemetry (pluginStates / modulationData) is keyed by these.

#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "comp_catalog.h"
#include "comp_model.h"

namespace comp {

/**
 * Re-point a wire ENDPOINT at its composite instance key, keeping everything
 * else the endpoint carries.
 *
 * The five rewrite sites below used to build a fresh {instanceKey, field}
 * object, which silently dropped `lane` — the component of a vector field the
 * wire drives — so a per-lane clip wire arrived in the executor addressing the
 * whole field and broadcast across every component. Copying the endpoint and
 * overwriting one key keeps that (and anything added later) by construction.
 */
inline nlohmann::json remapEndpoint(const nlohmann::json& ep,
                                    std::string instanceKey) {
  nlohmann::json out = ep.is_object() ? ep : nlohmann::json::object();
  out["instanceKey"] = std::move(instanceKey);
  return out;
}

/** clip-sketch.ts clipInstanceKey — `clip_<clipId>_<suffix>`. */
inline std::string clipInstanceKey(const std::string& clipId, const std::string& suffix) {
  return "clip_" + clipId + "_" + suffix;
}

/** clip-sketch.ts trackInstanceKey — `track_<trackId>_<suffix>` (per-track FX bus). */
inline std::string trackInstanceKey(const std::string& trackId, const std::string& suffix) {
  return "track_" + trackId + "_" + suffix;
}

/** clip-sketch.ts transportInstanceKey — `clip_<clipId>_transport_<devId>`.
 *  The `transport_` infix keeps section devices disjoint from pixel-sketch
 *  device keys (still `clip_`-prefixed, so streams self-scoping resolves). */
inline std::string transportInstanceKey(const std::string& clipId, const std::string& devId) {
  return "clip_" + clipId + "_transport_" + devId;
}

/** `track_<trackId>_transport_<devId>` — a TRACK transport-section device
 *  (transition effects). `track_`-prefixed so streams self-scoping resolves
 *  parent() to the track's own stream (trackIdForInstanceKey). */
inline std::string trackTransportInstanceKey(const std::string& trackId,
                                             const std::string& devId) {
  return "track_" + trackId + "_transport_" + devId;
}

/**
 * The device DRIVING a clip's content time: the LAST catalog-known
 * transport-controller device in the clip's transport section, or nullptr —
 * in which case ClipLoopConfig (the built-in play modes) drives. Engine-side
 * twin of composition.ts clipTransportDevice (which reads the doc's device
 * capabilities; this reads the catalog — the same split trigger routing has).
 */
inline const DeviceM* transportDeviceOf(const ClipM& clip, const Catalog& catalog) {
  if (!clip.hasTransport) return nullptr;
  for (auto it = clip.transport.devices.rbegin(); it != clip.transport.devices.rend(); ++it) {
    if (catalog.hasCapability(it->moduleType, "transport_controller")) return &*it;
  }
  return nullptr;
}

/**
 * Does the clip's transport section hold ANY member the engine must execute —
 * a driving controller OR a non-driving section effect (follower/autopilot)?
 * CATALOG-KNOWN only: an unloaded module must never claim the section (it
 * would disable the scene auto-stop without anyone owning the end). A section
 * member (either kind) OWNS its clip's end-of-life — healSceneLaunches defers
 * to it.
 */
inline bool clipHasTransportSection(const ClipM& clip, const Catalog& catalog) {
  if (!clip.hasTransport) return false;
  for (const auto& d : clip.transport.devices) {
    if (catalog.hasCapability(d.moduleType, "transport_controller") ||
        catalog.hasCapability(d.moduleType, "transport_section"))
      return true;
  }
  return false;
}

/**
 * Build the merged TRANSPORT sketch over the given clips: one chain entry per
 * catalog-known transport-SECTION device (keyed transportInstanceKey), plus
 * the section's intra-clip wires (ids remapped `xw<n>`). Deliberately tiny —
 * no blend/rail/layer machinery; sections never see the pixel chain. Clips
 * whose section holds NO catalog-known member (controller or section effect)
 * contribute nothing. Returns null JSON when no section executes.
 * LOCK-STEP: clip-sketch.ts buildTransportSketch (deep-equal, golden-tested).
 */
inline nlohmann::json buildTransportSketch(const std::vector<const ClipM*>& clips,
                                           const Catalog& catalog,
                                           const std::set<std::string>* controllerOnly = nullptr,
                                           const std::vector<const TrackM*>* trackSections = nullptr) {
  nlohmann::json chain = nlohmann::json::array();
  nlohmann::json wires = nlohmann::json::array();
  nlohmann::json instances = nlohmann::json::object();
  int wid = 0;
  for (const ClipM* clip : clips) {
    // SECTIONED, not just driven: a follower-only section must execute too.
    if (!clip || !clipHasTransportSection(*clip, catalog)) continue;
    // `controllerOnly` clips (live FORKS) keep their driving controller but
    // shed their SECTION members: a detached clip's follower re-arming against
    // the track's new live scene would double-drive the autopilot.
    const bool ctlOnly = controllerOnly && controllerOnly->count(clip->id) > 0;
    std::set<std::string> pushed;
    for (const auto& d : clip->transport.devices) {
      if (!catalog.has(d.moduleType)) continue;
      if (ctlOnly && !catalog.hasCapability(d.moduleType, "transport_controller")) continue;
      const std::string key = transportInstanceKey(clip->id, d.id);
      if (instances.contains(key)) continue;  // duplicate device id: keep first
      nlohmann::json s = catalog.defaultStateFor(d.moduleType);
      if (d.state.is_object()) s.update(d.state);
      chain.push_back({{"type", "module"},
                       {"module_type", d.moduleType},
                       {"instance_key", key}});
      instances[key] = {{"module_type", d.moduleType}, {"state", std::move(s)}};
      pushed.insert(d.id);
    }
    for (const auto& w : clip->transport.wires) {
      if (!w.is_object() || !w.contains("src") || !w.contains("dest")) continue;
      const std::string srcKey = w["src"].value("instanceKey", std::string());
      const std::string destKey = w["dest"].value("instanceKey", std::string());
      if (!pushed.count(srcKey) || !pushed.count(destKey)) continue;
      nlohmann::json w2 = w;  // {...w} — spread keeps mod/combine/magnitude/...
      w2["id"] = "xw" + std::to_string(wid++);
      w2["src"] = remapEndpoint(w["src"], transportInstanceKey(clip->id, srcKey));
      w2["dest"] = remapEndpoint(w["dest"], transportInstanceKey(clip->id, destKey));
      wires.push_back(std::move(w2));
    }
  }
  // TRACK transport sections (transition effects on scene tracks): member
  // devices only — a track has no content clock, so nothing here ever drives
  // a times-channel row. Keys are track_<trackId>_transport_<devId>.
  if (trackSections) {
    for (const TrackM* track : *trackSections) {
      if (!track || !track->hasTransport) continue;
      std::set<std::string> pushed;
      for (const auto& d : track->transport.devices) {
        if (!catalog.has(d.moduleType)) continue;
        const std::string key = trackTransportInstanceKey(track->id, d.id);
        if (instances.contains(key)) continue;  // duplicate device id: keep first
        nlohmann::json s = catalog.defaultStateFor(d.moduleType);
        if (d.state.is_object()) s.update(d.state);
        chain.push_back({{"type", "module"},
                         {"module_type", d.moduleType},
                         {"instance_key", key}});
        instances[key] = {{"module_type", d.moduleType}, {"state", std::move(s)}};
        pushed.insert(d.id);
      }
      for (const auto& w : track->transport.wires) {
        if (!w.is_object() || !w.contains("src") || !w.contains("dest")) continue;
        const std::string srcKey = w["src"].value("instanceKey", std::string());
        const std::string destKey = w["dest"].value("instanceKey", std::string());
        if (!pushed.count(srcKey) || !pushed.count(destKey)) continue;
        nlohmann::json w2 = w;
        w2["id"] = "xw" + std::to_string(wid++);
        w2["src"] = remapEndpoint(w["src"], trackTransportInstanceKey(track->id, srcKey));
        w2["dest"] = remapEndpoint(w["dest"], trackTransportInstanceKey(track->id, destKey));
        wires.push_back(std::move(w2));
      }
    }
  }
  if (chain.empty()) return nlohmann::json();
  return {{"anchor", nullptr},
          {"chain", std::move(chain)},
          {"wires", std::move(wires)},
          {"instances", std::move(instances)}};
}

/** One node of the active composite tree (clip-sketch.ts CompositeNode). */
struct CompNode {
  bool isGroup = false;
  // Clip leaf:
  const ClipM* clip = nullptr;
  const TrackM* track = nullptr;  // owning track (its FX bus runs over the clip)
  /** Local-time anchor: clip.startBeat for arrangement clips, the LAUNCH beat
   *  for scenes. Feeds startSec, clip-relative lane timing, and the video-desc
   *  startBeat. Set by the tree builder (comp_eval.h). */
  double anchorBeat = 0;
  double startSec = 0;
  bool hasStartSec = false;
  // Group:
  const TrackM* group = nullptr;
  GroupInputM input;
  // Shared:
  double opacity = 1;
  int blendMode = 0;
  /** The owner (track/group) has a lane/read/wire targeting `__layer__`
   *  opacity — forces a blend node where the static build would elide one, so
   *  the modulation has a target. Set by the tree builder (comp_eval.h). */
  bool layerOpacityModulated = false;
  /** FORK leaf (scene tracks): the OUTGOING clip riding this track through a
   *  crossfade — rendered standalone beside the incoming clip and fed into
   *  the track's xfade blend. Anchors are the fork slot's FROZEN launch
   *  anchors (adopted identity). Set by the tree builder. */
  const ClipM* forkClip = nullptr;
  double forkAnchorBeat = 0;
  double forkStartSec = 0;
  bool hasFork = false;
  /** SEQUENCE leaf: a clip that ALSO owns children. It keeps every clip-leaf
   *  field (`clip`/`track`/`anchorBeat` — its own chain and layer are owned by
   *  its arrangement track like any clip), and `children` holds the interior
   *  sub-clip leaves evaluated at the INTERIOR beat, owned by `lane`. A `bool`
   *  rather than a third enum value so `isGroup ? group : clip-leaf` stays true
   *  everywhere. Exactly one level: a child is never itself a sequence. */
  bool isSequence = false;
  const TrackM* lane = nullptr;   // &clip->sequence.front()
  double interiorBeat = 0;        // sampled at EVAL time (structural use only)
  double interiorDurSec = 0;      // sequenceInteriorSec(lane, baseBPM)
  double interiorBpm = 120;       // doc.baseBPM (the interior is unwarped)
  bool interiorLive = false;      // false ⇒ contentSec was nullopt (transparent)
  std::vector<CompNode> children;
  /** CLIPLESS leaf: a timeline track with no clips at all, whose own sketch IS
   *  its content (generators included) and runs continuously. `track` is set,
   *  `clip` is null — every leaf walk must check `clip` before dereferencing.
   *  Keys are the track's own (`track_<trackId>_<devId>`), the same keys its FX
   *  bus would use, so telemetry and automation resolve unchanged. */
  bool clipless = false;
  /** SEND NOWHERE (composition.ts Track.output.mode 'none', or forced by the
   *  solo closure): the node renders — its I/O ports and side effects stay
   *  live — but never composites into its parent's accumulator. */
  bool outputNone = false;
  /** Kept in the tree ONLY because a route carries its output into a track
   *  solo lets through (comp_eval.h's solo closure). A group whose every child
   *  is solo-forced is itself forced. */
  bool soloForced = false;
};

/** Build result: hasContent=false ⇔ the TS build returned null. */
struct SketchBuild {
  bool hasContent = false;
  nlohmann::json sketch;  // { anchor:null, chain, wires, instances }
  /**
   * Composition-param resolution map: ownerId (track/group id) →
   * {instanceKey, field} — where that owner's LAYER OPACITY lives in THIS
   * build (a blend node's `opacity` param, or the top/adjustment layer's
   * reserved `__opacity__`). A SIBLING of the sketch (never serialized into
   * it — the frozen build goldens stay byte-identical). Consumed by the
   * automation emitter, rail-read wiring, own-layer clip wires, and shipped
   * to the UI (comp_layer_targets_json) so modulation bands can resolve the
   * per-build key churn.
   */
  nlohmann::json layerTargets = nlohmann::json::object();
  /**
   * Composition I/O route status: routeId → {live, delayed}. `live` = both
   * ends resolved in THIS build (a route whose source track isn't rendering,
   * or whose field's device isn't pushed, is inert); `delayed` = the source's
   * chain position is at/after the destination's, so the executor delivers it
   * one frame late. A sibling of the sketch like layerTargets (never
   * serialized into it), shipped to the UI for the route markers.
   */
  nlohmann::json routeStatus = nlohmann::json::object();
  /**
   * Light devices fed by a route: placementId → {instanceKey, field} — the
   * built stage whose texture that light samples (live routes only). A light
   * with no entry samples the composite. A sibling of the sketch: a device
   * route emits NO wire, so it never reaches the goldens.
   */
  nlohmann::json lightSources = nlohmann::json::object();
};

namespace build_detail {

// The LAYER COMPOSITOR effect (full-strength blend at opacity 1). NOT
// composite.blend — that node became an A/B crossfader (fader 1 = pure B),
// which would gut per-layer blend modes here.
inline constexpr const char* kBlend = "composite.layer";
/** effect-catalog.ts IMPLICIT_ANCHOR — solid stand-in for generator-less chains. */
inline constexpr const char* kImplicitAnchor = "source.solid_color";

inline int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/** Parse '#rgb' / '#rrggbb' → normalized [r,g,b] in 0..1 (black on failure).
 *  Mirrors clip-sketch.ts hexToRgb01, incl. parseInt's prefix-parse semantics. */
inline std::array<double, 3> hexToRgb01(const std::string& hex) {
  std::string h = hex;
  const auto hash = h.find('#');
  if (hash != std::string::npos) h.erase(hash, 1);  // JS .replace('#','') — first only
  std::string n;
  if (h.size() == 3) {
    for (const char c : h) { n.push_back(c); n.push_back(c); }
  } else {
    n = h;
  }
  auto v = [&](size_t i) -> double {
    // parseInt(n.slice(i, i+2), 16) / 255, NaN → 0.
    int digits = 0;
    int val = 0;
    for (size_t k = i; k < n.size() && k < i + 2; k++) {
      const int d = hexDigit(n[k]);
      if (d < 0) break;
      val = val * 16 + d;
      digits++;
    }
    if (digits == 0) return 0;  // NaN
    return val / 255.0;
  };
  if (n.size() >= 6) return {v(0), v(2), v(4)};
  return {0, 0, 0};
}

/** The whole TS buildCompositeSketch closure set, as a builder object. */
struct Builder {
  const Catalog& cat;
  const std::map<std::string, double>& railBases;
  const std::map<std::string, bool>& railSigned;

  nlohmann::json chain = nlohmann::json::array();
  nlohmann::json wires = nlohmann::json::array();
  nlohmann::json instances = nlohmann::json::object();
  int wid = 0;

  /** An out-of-chain wire source: a MIDI device control (`midi:<uuid>`). A
   *  sketch wire from one keeps its src verbatim — the executor seeds it from
   *  the host's external-scalar table (unseeded: the dest keeps its authored
   *  value). */
  static bool isExternalSrc(const std::string& srcKey) {
    return srcKey.rfind("midi:", 0) == 0;
  }

  /** A wire's src is foldable: a device pushed in this sketch, or a device
   *  control. */
  bool srcFoldable(const std::string& srcKey, const std::set<std::string>& pushed) const {
    return pushed.count(srcKey) || isExternalSrc(srcKey);
  }
  /** The folded src endpoint: a device control verbatim, a local device
   *  re-keyed to `localKey`. */
  nlohmann::json foldSrc(const nlohmann::json& src, const std::string& localKey) const {
    if (isExternalSrc(src.value("instanceKey", std::string()))) return src;
    return remapEndpoint(src, localKey);
  }

  struct Writer {
    std::string key;
    std::string field;
    const RailExportM* tap;
    double srcMin;
    double srcMax;
  };
  struct Reader {
    std::string railId;
    std::string key;
    std::string field;
    const RailReadM* tap;
  };
  // TS Map — iteration follows first-insertion order.
  std::vector<std::pair<std::string, std::vector<Writer>>> railWriters;
  std::map<std::string, size_t> railWriterIdx;
  std::vector<Reader> railReaders;
  std::set<std::string> railNodeKeys;
  /** ownerId → {instanceKey, field}: where each layer's opacity landed. */
  nlohmann::json layerTargets = nlohmann::json::object();

  // ── Composition I/O ──
  /** Track ids whose `__in__` port has a legal route into it: their chain
   *  starts from an input relay instead of the stack. */
  std::set<std::string> inRouted;
  /** Track/group id → its `__out__` key: the post-FX output, before blend and
   *  opacity. Recorded for every owner that renders. */
  std::map<std::string, std::string> outKeys;
  /** The LAST non-mod stage pushed: what the executor's column cursor (the
   *  next linear stage's `tex_in`) will hold. Equal to the accumulator in
   *  every flow without I/O; a send-nowhere track makes them diverge. */
  std::string cursor;
  int relayN = 0;

  static bool isMod(const std::string& t) { return t.rfind("mod.", 0) == 0; }

  void push(const std::string& moduleType, const std::string& key, nlohmann::json state,
            const double* startSec = nullptr) {
    // A key must appear ONCE (duplicate device ids within a clip are a data bug —
    // keep the first, drop the collision; see the TS comment).
    if (instances.contains(key)) return;
    nlohmann::json entry = {
        {"type", "module"}, {"module_type", moduleType}, {"instance_key", key}};
    if (startSec) entry["startSec"] = *startSec;
    chain.push_back(std::move(entry));
    instances[key] = {{"module_type", moduleType}, {"state", std::move(state)}};
    if (!isMod(moduleType)) cursor = key;
  }

  /** A RELAY stage re-emitting `srcKey`: composite.blend at opacity 1 is pure
   *  B. It renders only with BOTH slots bound, so both carry the source. The
   *  wires are written at once unless `deferWire` (an input relay, whose
   *  source is only known once every track has composited). */
  void pushRelay(const std::string& key, const std::string& srcKey) {
    push("composite.blend", key, {{"mode", 0}, {"opacity", 1.0}});
    if (srcKey.empty()) return;
    for (const char* slot : {"0", "1"}) {
      wires.push_back({{"id", "iow" + std::to_string(wid++)},
                       {"src", {{"instanceKey", srcKey}, {"field", "tex_out"}}},
                       {"dest", {{"instanceKey", key}, {"field", slot}}}});
    }
  }

  /** Before a stage that reads the column cursor as "what's below": if a
   *  send-nowhere track left the cursor on ITS output, re-emit `accKey` so the
   *  stage processes the stack, not the hidden track. A no-op in every flow
   *  without I/O (the cursor already is the accumulator). */
  void ensureCursor(const std::string& accKey) {
    if (accKey.empty() || cursor == accKey) return;
    pushRelay("io_resync_" + std::to_string(relayN++), accKey);
  }

  /** The owner's INPUT relay, when its `__in__` has a route: pushed at the
   *  head of its chain (its wires are emitted with the routes, at the end).
   *  Empty when the input isn't routed. */
  std::string inRelay(const TrackM* owner) {
    if (!owner || !inRouted.count(owner->id)) return std::string();
    const std::string key = trackInstanceKey(owner->id, "in");
    pushRelay(key, std::string());
    return key;
  }

  /** Composite a finished layer image [firstKey..lastKey] over `acc` — the
   *  source-clip rule: the top layer becomes the accumulator (its opacity on
   *  the reserved `__opacity__`), any later one blends over it. */
  std::optional<std::string> blendOver(std::optional<std::string> acc, const CompNode& node,
                                       const std::string& firstKey, const std::string& lastKey,
                                       const std::string& blendKey, std::string& layerKey,
                                       std::string& layerField) {
    if (!acc) {
      if (node.opacity < 1) instances[firstKey]["state"]["__opacity__"] = node.opacity;
      layerKey = firstKey;
      layerField = "__opacity__";
      return lastKey;
    }
    push(kBlend, blendKey, {{"mode", node.blendMode}, {"opacity", node.opacity}});
    wires.push_back({{"id", "w" + std::to_string(wid++)},
                     {"src", {{"instanceKey", *acc}, {"field", "tex_out"}}},
                     {"dest", {{"instanceKey", blendKey}, {"field", "0"}}}});
    wires.push_back({{"id", "w" + std::to_string(wid++)},
                     {"src", {{"instanceKey", lastKey}, {"field", "tex_out"}}},
                     {"dest", {{"instanceKey", blendKey}, {"field", "1"}}}});
    layerKey = blendKey;
    layerField = "opacity";
    return blendKey;
  }

  /** { ...defaultStateFor(type), ...(device.state ?? {}) } */
  nlohmann::json defaultsPlus(const DeviceM& d) const {
    nlohmann::json s = cat.defaultStateFor(d.moduleType);
    if (d.state.is_object()) s.update(d.state);
    return s;
  }

  /** Track FX bus: the track's own effect chain run over `startKey` (per-TRACK
   *  keys, one stable instance across the track's clips). */
  std::string pushTrackFx(const TrackM* track, std::string startKey) {
    if (!track) return startKey;
    std::vector<const DeviceM*> tcat;
    for (const auto& d : track->sketch.devices) {
      if (cat.has(d.moduleType)) tcat.push_back(&d);
    }
    std::string last = std::move(startKey);
    bool ensured = false;
    for (const DeviceM* d : tcat) {
      if (cat.isGenerator(d->moduleType)) continue;  // tfx = role 'effect' only
      const std::string key = trackInstanceKey(track->id, d->id);
      if (!ensured && !isMod(d->moduleType)) {
        ensureCursor(last);  // the bus processes `startKey`, whatever came last
        ensured = true;
      }
      push(d->moduleType, key, defaultsPlus(*d));
      if (!isMod(d->moduleType)) last = key;
    }
    std::set<std::string> tpushed;
    for (const DeviceM* d : tcat) tpushed.insert(d->id);
    for (const auto& w : track->sketch.wires) {
      if (!w.is_object() || !w.contains("src") || !w.contains("dest")) continue;
      const std::string srcKey = w["src"].value("instanceKey", std::string());
      const std::string destKey = w["dest"].value("instanceKey", std::string());
      if (!srcFoldable(srcKey, tpushed) || !tpushed.count(destKey)) continue;
      nlohmann::json w2 = w;  // {...w} — spread keeps mod/combine/magnitude/...
      w2["id"] = "tw" + std::to_string(wid++);
      w2["src"] = foldSrc(w["src"], trackInstanceKey(track->id, srcKey));
      w2["dest"] = remapEndpoint(w["dest"], trackInstanceKey(track->id, destKey));
      wires.push_back(std::move(w2));
    }
    return last;
  }

  /** Record where owner `ownerId`'s layer opacity lives in this build. */
  void recordLayerTarget(const std::string& ownerId, const std::string& instanceKey,
                         const std::string& field) {
    if (ownerId.empty()) return;
    layerTargets[ownerId] = {{"instanceKey", instanceKey}, {"field", field}};
  }

  /** Fold an owner's (track/group) FX-bus sketch wires whose dest is
   *  `__layer__`/opacity — a mod source ON THE TRACK driving its own layer.
   *  Emitted here (not pushTrackFx) because the layer slot resolves only after
   *  the layer composites. `__layer__`/bypass wires are self-killing → dropped.
   *  Non-layer track wires were already folded by pushTrackFx. */
  void pushOwnerLayerWires(const TrackM* owner, const std::string& layerKey,
                           const std::string& layerField) {
    if (!owner || layerKey.empty()) return;
    std::set<std::string> tpushed;
    for (const auto& d : owner->sketch.devices) {
      if (cat.has(d.moduleType)) tpushed.insert(d.id);
    }
    for (const auto& w : owner->sketch.wires) {
      if (!w.is_object() || !w.contains("src") || !w.contains("dest")) continue;
      if (w["dest"].value("instanceKey", std::string()) != kLayerTargetId) continue;
      if (w["dest"].value("field", std::string()) != "opacity") continue;
      const std::string srcKey = w["src"].value("instanceKey", std::string());
      if (!srcFoldable(srcKey, tpushed)) continue;
      nlohmann::json w2 = w;
      w2["id"] = "tw" + std::to_string(wid++);
      w2["src"] = foldSrc(w["src"], trackInstanceKey(owner->id, srcKey));
      w2["dest"] = {{"instanceKey", layerKey}, {"field", layerField}};
      wires.push_back(std::move(w2));
    }
  }

  /** Collect an owner's (track/group) rail READS: `__layer__` targets resolve
   *  to the owner's layer-opacity slot (`layerKey`/`layerField`, when this
   *  build produced one); device targets resolve to the owner's FX-bus keys.
   *  `__layer__`/bypass reads are eval-level (a structural drop) — never an
   *  executor wire — so they're skipped here. */
  void collectOwnerReads(const TrackM* owner, const std::string& layerKey,
                         const std::string& layerField) {
    if (!owner) return;
    for (const auto& read : owner->reads) {
      if (read.targetDeviceId == kLayerTargetId) {
        if (read.targetField == "opacity" && !layerKey.empty()) {
          railReaders.push_back({read.railId, layerKey, layerField, &read});
        }
        continue;
      }
      for (const auto& d : owner->sketch.devices) {
        if (d.id != read.targetDeviceId) continue;
        if (cat.has(d.moduleType) && !cat.isGenerator(d.moduleType)) {
          railReaders.push_back({read.railId, trackInstanceKey(owner->id, d.id),
                                 read.targetField, &read});
        }
        break;
      }
    }
  }

  /** Composite ONE clip leaf over `acc` (source clip → wired blend; effect-only
   *  clip → inline adjustment layer). Returns the new accumulator key. */
  std::optional<std::string> compositeClip(const CompNode& node,
                                           std::optional<std::string> acc) {
    const ClipM& clip = *node.clip;
    std::vector<const DeviceM*> catDevs;
    for (const auto& d : clip.sketch.devices) {
      if (cat.has(d.moduleType)) catDevs.push_back(&d);
    }
    // The FIRST generator anchors the layer (it heads the chain, so the clip has
    // something to draw); `rest` is every OTHER catalog device in declaration
    // order — including any FURTHER generators, which used to be dropped on the
    // floor. A second source therefore renders as a normal chain entry: one that
    // reads tex_in composites over what came before (two source.text.plain
    // overlay), one that ignores it simply wins. `fx` (the non-generators) is
    // still what the effect-only/adjustment-layer path below wants.
    const DeviceM* gen = nullptr;
    for (const DeviceM* d : catDevs) {
      if (cat.isGenerator(d->moduleType)) { gen = d; break; }
    }
    std::vector<const DeviceM*> fx;
    std::vector<const DeviceM*> rest;
    for (const DeviceM* d : catDevs) {
      if (!cat.isGenerator(d->moduleType)) fx.push_back(d);
      if (d != gen) rest.push_back(d);
    }
    const double* startSec = node.hasStartSec ? &node.startSec : nullptr;

    // Where this LAYER's opacity lands in the build (the `__layer__` target):
    // the blend node's real `opacity` param when the layer composites over
    // content below, else the top/adjustment layer's reserved `__opacity__`.
    std::string layerKey;
    std::string layerField;

    if (gen || catDevs.empty()) {
      // ── SOURCE clip: render standalone, then composite OVER the accumulator ──
      // A routed input heads the chain (a generator that reads tex_in draws
      // over it); otherwise the generator sees what's below, as always.
      const std::string relay = inRelay(node.track);
      if (relay.empty() && acc) ensureCursor(*acc);
      std::string firstKey;
      std::string lastKey;
      if (gen) {
        std::vector<const DeviceM*> segment{gen};
        segment.insert(segment.end(), rest.begin(), rest.end());
        for (const DeviceM* d : segment) {
          const std::string key = clipInstanceKey(clip.id, d->id);
          push(d->moduleType, key, defaultsPlus(*d), startSec);
          if (!isMod(d->moduleType)) {
            if (firstKey.empty()) firstKey = key;
            lastKey = key;
          }
        }
      } else {
        // Legacy / non-catalog clip → a solid stand-in so the layer still draws.
        firstKey = lastKey = clipInstanceKey(clip.id, "src");
        push(kImplicitAnchor, firstKey, nlohmann::json::object());
      }

      // ── FORK crossfade: the OUTGOING clip renders STANDALONE beside the
      // incoming and both feed the track xfade blend (composite.blend — the
      // A/B crossfader: fader 0 = pure A/outgoing, 1 = pure B/incoming). The
      // transition effect's published fade reaches its opacity through the
      // automation fold (CompExecutor::transportResolve). Only a source-type
      // outgoing fades — an effect-only outgoing has nothing standalone to
      // draw and keeps the plain path.
      if (!lastKey.empty() && node.hasFork && node.forkClip && node.track) {
        const ClipM& fc = *node.forkClip;
        std::vector<const DeviceM*> fdevs;
        for (const auto& d : fc.sketch.devices) {
          if (cat.has(d.moduleType)) fdevs.push_back(&d);
        }
        const DeviceM* fgen = nullptr;
        for (const DeviceM* d : fdevs) {
          if (cat.isGenerator(d->moduleType)) { fgen = d; break; }
        }
        std::string fLast;
        if (fgen) {
          // Same rule as the incoming clip: everything after the anchoring
          // generator stays in the chain, extra generators included.
          std::vector<const DeviceM*> seg{fgen};
          for (const DeviceM* d : fdevs) {
            if (d != fgen) seg.push_back(d);
          }
          for (const DeviceM* d : seg) {
            const std::string key = clipInstanceKey(fc.id, d->id);
            push(d->moduleType, key, defaultsPlus(*d), &node.forkStartSec);
            if (!isMod(d->moduleType)) fLast = key;
          }
        } else if (fdevs.empty()) {
          fLast = clipInstanceKey(fc.id, "src");
          push(kImplicitAnchor, fLast, nlohmann::json::object());
        }
        if (!fLast.empty()) {
          // The outgoing's internal modulation wires keep running — its look
          // must not change at the detach instant. `__layer__` wires drop
          // (the fork has no layer slot of its own).
          std::set<std::string> fpushed;
          for (const DeviceM* d : fdevs) fpushed.insert(d->id);
          for (const auto& w : fc.sketch.wires) {
            if (!w.is_object() || !w.contains("src") || !w.contains("dest")) continue;
            const std::string srcKey = w["src"].value("instanceKey", std::string());
            const std::string destKey = w["dest"].value("instanceKey", std::string());
            if (!srcFoldable(srcKey, fpushed) || !fpushed.count(destKey)) continue;
            nlohmann::json w2 = w;
            w2["id"] = "fw" + std::to_string(wid++);
            w2["src"] = foldSrc(w["src"], clipInstanceKey(fc.id, srcKey));
            w2["dest"] = remapEndpoint(w["dest"], clipInstanceKey(fc.id, destKey));
            wires.push_back(std::move(w2));
          }
          const std::string x = trackInstanceKey(node.track->id, "xfade");
          push("composite.blend", x, {{"mode", 0}, {"opacity", 0.0}});
          wires.push_back({{"id", "w" + std::to_string(wid++)},
                           {"src", {{"instanceKey", fLast}, {"field", "tex_out"}}},
                           {"dest", {{"instanceKey", x}, {"field", "0"}}}});
          wires.push_back({{"id", "w" + std::to_string(wid++)},
                           {"src", {{"instanceKey", lastKey}, {"field", "tex_out"}}},
                           {"dest", {{"instanceKey", x}, {"field", "1"}}}});
          firstKey = x;  // the layer's opacity rides the xfade node's wet/dry
          lastKey = x;
        }
      }

      if (!lastKey.empty()) {
        lastKey = pushTrackFx(node.track, lastKey);  // track FX bus over the clip output
        if (node.track) outKeys[node.track->id] = lastKey;
        if (node.outputNone) {
          // SEND NOWHERE: rendered (its ports read `lastKey`), never composited.
        } else if (!acc) {
          // First (top) layer becomes the accumulator; sub-1 opacity fades via the
          // reserved wet/dry key.
          if (node.opacity < 1) instances[firstKey]["state"]["__opacity__"] = node.opacity;
          layerKey = firstKey;
          layerField = "__opacity__";
          acc = lastKey;
        } else {
          const std::string b = clipInstanceKey(clip.id, "blend");
          push(kBlend, b, {{"mode", node.blendMode}, {"opacity", node.opacity}});
          // 0 = A (the accumulator / tracks above), 1 = B (this clip, drawn on top).
          wires.push_back({{"id", "w" + std::to_string(wid++)},
                           {"src", {{"instanceKey", *acc}, {"field", "tex_out"}}},
                           {"dest", {{"instanceKey", b}, {"field", "0"}}}});
          wires.push_back({{"id", "w" + std::to_string(wid++)},
                           {"src", {{"instanceKey", lastKey}, {"field", "tex_out"}}},
                           {"dest", {{"instanceKey", b}, {"field", "1"}}}});
          layerKey = b;
          layerField = "opacity";
          acc = b;
        }
      }
    } else if (const std::string relay = inRelay(node.track); !relay.empty()) {
      // ── EFFECT-only clip with a ROUTED INPUT: it processes the route, not
      // the stack — so it is a source layer, composited over `acc` like one.
      std::string firstKey;
      std::string lastKey = relay;
      for (const DeviceM* d : fx) {
        const std::string key = clipInstanceKey(clip.id, d->id);
        push(d->moduleType, key, defaultsPlus(*d), startSec);
        if (!isMod(d->moduleType)) {
          if (firstKey.empty()) firstKey = key;
          lastKey = key;
        }
      }
      if (firstKey.empty()) firstKey = relay;
      lastKey = pushTrackFx(node.track, lastKey);
      if (node.track) outKeys[node.track->id] = lastKey;
      if (!node.outputNone) {
        acc = blendOver(acc, node, firstKey, lastKey, clipInstanceKey(clip.id, "blend"),
                        layerKey, layerField);
      }
    } else {
      // ── EFFECT-only clip: process the accumulator inline (adjustment layer) ──
      if (acc) ensureCursor(*acc);
      const std::optional<std::string> below = acc;
      bool appliedOpacity = false;
      for (const DeviceM* d : fx) {
        nlohmann::json state = defaultsPlus(*d);
        if (!isMod(d->moduleType) && !appliedOpacity && !node.outputNone) {
          if (node.opacity < 1) state["__opacity__"] = node.opacity;
          layerKey = clipInstanceKey(clip.id, d->id);
          layerField = "__opacity__";
          appliedOpacity = true;
        }
        push(d->moduleType, clipInstanceKey(clip.id, d->id), std::move(state), startSec);
        if (!isMod(d->moduleType)) acc = clipInstanceKey(clip.id, d->id);
      }
      if (acc) acc = pushTrackFx(node.track, *acc);  // track FX bus over the adjustment
      if (node.track && acc) outKeys[node.track->id] = *acc;
      // SEND NOWHERE: it processed a COPY of the stack; the stack is untouched.
      if (node.outputNone) acc = below;
    }

    if (node.track && !layerKey.empty()) {
      recordLayerTarget(node.track->id, layerKey, layerField);
    }
    foldClipModulation(clip, catDevs, node.track, layerKey, layerField);
    return acc;
  }

  /**
   * Fold a clip's modulation into the build: its intra-sketch wires (device ids
   * → composite keys, `__layer__`/opacity remapped to the layer slot), its rail
   * exports/reads, and its OWNER's rail reads + own-layer wires.
   *
   * Extracted from compositeClip so compositeSequence can reuse it verbatim —
   * the two must not drift on wire-id numbering or rail-writer ordering (both
   * are golden-pinned).
   */
  void foldClipModulation(const ClipM& clip, const std::vector<const DeviceM*>& catDevs,
                          const TrackM* owner, const std::string& layerKey,
                          const std::string& layerField) {
    // Fold this clip's modulation wires in, remapping device ids → composite keys.
    // A dest of `__layer__`/opacity remaps to this layer's opacity slot (an
    // own-layer wire); `__layer__`/bypass would be self-killing (dropping the
    // subtree removes the wire's source) and is dropped.
    std::set<std::string> pushed;
    for (const DeviceM* d : catDevs) pushed.insert(d->id);
    for (const auto& w : clip.sketch.wires) {
      if (!w.is_object() || !w.contains("src") || !w.contains("dest")) continue;
      const std::string srcKey = w["src"].value("instanceKey", std::string());
      const std::string destKey = w["dest"].value("instanceKey", std::string());
      const bool destIsLayer = destKey == kLayerTargetId;
      if (!srcFoldable(srcKey, pushed) || (!destIsLayer && !pushed.count(destKey))) continue;
      if (destIsLayer &&
          (w["dest"].value("field", std::string()) != "opacity" || layerKey.empty())) {
        continue;
      }
      nlohmann::json w2 = w;
      w2["id"] = "cw" + std::to_string(wid++);
      w2["src"] = foldSrc(w["src"], clipInstanceKey(clip.id, srcKey));
      // The LAYER target is the composite's own opacity — a scalar, and a
      // different field name — so it is rebuilt rather than re-pointed.
      w2["dest"] = destIsLayer
          ? nlohmann::json{{"instanceKey", layerKey}, {"field", layerField}}
          : remapEndpoint(w["dest"], clipInstanceKey(clip.id, destKey));
      wires.push_back(std::move(w2));
    }

    // Collect this clip's rail writers/readers (only devices actually pushed).
    for (const auto& exp : clip.exports) {
      if (!pushed.count(exp.sourceDeviceId)) continue;
      const DeviceM* dev = nullptr;
      for (const auto& d : clip.sketch.devices) {
        if (d.id == exp.sourceDeviceId) { dev = &d; break; }
      }
      double srcMin = 0;
      double srcMax = 1;
      if (dev) cat.outputRange(dev->moduleType, exp.sourceField, srcMin, srcMax);
      auto it = railWriterIdx.find(exp.railId);
      if (it == railWriterIdx.end()) {
        railWriterIdx[exp.railId] = railWriters.size();
        railWriters.push_back({exp.railId, {}});
        it = railWriterIdx.find(exp.railId);
      }
      railWriters[it->second].second.push_back(
          {clipInstanceKey(clip.id, exp.sourceDeviceId), exp.sourceField, &exp, srcMin, srcMax});
    }
    for (const auto& read : clip.reads) {
      if (!pushed.count(read.targetDeviceId)) continue;
      railReaders.push_back({read.railId, clipInstanceKey(clip.id, read.targetDeviceId),
                             read.targetField, &read});
    }
    // Track-level rail reads (the owner's layer opacity / FX-bus params) +
    // the owner's own-layer sketch wires.
    collectOwnerReads(owner, layerKey, layerField);
    pushOwnerLayerWires(owner, layerKey, layerField);
  }

  /**
   * A CLIP's own effect chain run over `startKey`, with CLIP keys
   * (`clip_<clipId>_<devId>`) — the clip twin of pushTrackFx. Used by
   * compositeSequence: a sequence clip's SOURCE is its interior, so its own
   * chain is pure FX and generators in it are a data bug (filtered, exactly as
   * pushTrackFx does). Mod devices push but don't advance the accumulator.
   *
   * Reports the FIRST non-mod device into `outLayerKey`/`outLayerField` as the
   * `__opacity__` slot, for the no-blend case where the layer's opacity has
   * nowhere else to ride.
   */
  std::string pushClipFx(const ClipM& clip, std::string startKey, const double* startSec,
                         std::vector<const DeviceM*>& outCatDevs, std::string& outLayerKey,
                         std::string& outLayerField) {
    for (const auto& d : clip.sketch.devices) {
      if (cat.has(d.moduleType)) outCatDevs.push_back(&d);
    }
    std::string last = std::move(startKey);
    std::string first;
    for (const DeviceM* d : outCatDevs) {
      if (cat.isGenerator(d->moduleType)) continue;
      const std::string key = clipInstanceKey(clip.id, d->id);
      push(d->moduleType, key, defaultsPlus(*d), startSec);
      if (!isMod(d->moduleType)) {
        if (first.empty()) first = key;
        last = key;
      }
    }
    if (!first.empty()) {
      outLayerKey = first;
      outLayerField = "__opacity__";
    }
    return last;
  }

  /**
   * Composite a SEQUENCE clip over `acc`: the interior lane composites over a
   * PASS-THROUGH seed, the clip's own FX chain runs over that result, the
   * parent track's FX bus runs over that, and the whole thing blends up.
   * Modelled on compositeGroup with compositeClip's clip-key / clip-layer /
   * clip-modulation discipline.
   *
   * The seed is `underlying` (never a fresh transparent base) on purpose: a
   * sequence interior behaves like a TRACK, so an effect-only or
   * modulation-only sub-clip has the composite below it to process.
   */
  std::optional<std::string> compositeSequence(const CompNode& node,
                                               std::optional<std::string> acc) {
    const ClipM& clip = *node.clip;
    const double* startSec = node.hasStartSec ? &node.startSec : nullptr;

    // 1. Interior over the pass-through seed. Children carry `track = lane`, so
    //    compositeClip runs the LANE's FX bus (track_<laneId>_<dev>) for free.
    std::optional<std::string> inner = compositeNodes(node.children, acc);

    // 2. The sequence clip's OWN chain over the interior result.
    std::string layerKey;
    std::string layerField;
    std::vector<const DeviceM*> catDevs;
    if (inner) {
      inner = pushClipFx(clip, *inner, startSec, catDevs, layerKey, layerField);
    } else {
      for (const auto& d : clip.sketch.devices) {
        if (cat.has(d.moduleType)) catDevs.push_back(&d);
      }
    }

    // 3. The parent track's FX bus (same position as compositeClip's
    //    adjustment-layer path — an `underlying` seed makes this structurally
    //    an adjustment layer over the tracks above).
    if (inner) inner = pushTrackFx(node.track, *inner);
    if (!inner) {
      collectOwnerReads(node.track, std::string(), std::string());
      return acc;  // nothing rendered → leave the accumulator alone
    }
    if (node.track) outKeys[node.track->id] = *inner;
    if (node.outputNone) {
      // SEND NOWHERE: the interior + own chain rendered over a COPY of the
      // stack (the `underlying` seed); the accumulator is untouched.
      foldClipModulation(clip, catDevs, node.track, std::string(), std::string());
      return acc;
    }

    // 4. Blend up. PARITY with compositeGroup: an `underlying` seed at full
    //    opacity already CONTAINS the below content, so it just replaces the
    //    accumulator; a modulated or sub-1 opacity forces a real blend node
    //    (the modulation needs somewhere to land).
    const bool needBlend =
        acc.has_value() && (node.layerOpacityModulated || node.opacity < 1);
    if (needBlend) {
      // Unique by construction: a clip is never both a source clip and a
      // sequence clip, so this can't collide with compositeClip's blend key.
      const std::string b = clipInstanceKey(clip.id, "blend");
      push(kBlend, b, {{"mode", node.blendMode}, {"opacity", node.opacity}});
      wires.push_back({{"id", "qw" + std::to_string(wid++)},
                       {"src", {{"instanceKey", *acc}, {"field", "tex_out"}}},
                       {"dest", {{"instanceKey", b}, {"field", "0"}}}});
      wires.push_back({{"id", "qw" + std::to_string(wid++)},
                       {"src", {{"instanceKey", *inner}, {"field", "tex_out"}}},
                       {"dest", {{"instanceKey", b}, {"field", "1"}}}});
      layerKey = b;
      layerField = "opacity";
      inner = b;
    } else if (node.opacity < 1 && !layerKey.empty()) {
      instances[layerKey]["state"]["__opacity__"] = node.opacity;
    }

    // 5. The sequence clip's layer OWNER is its arrangement track (identical to
    //    compositeClip); the interior sub-leaf's owner is the LANE, recorded by
    //    compositeClip under the lane's globally-unique uid('track') id. No
    //    collision, and layerTargets needs no schema change.
    if (node.track && !layerKey.empty()) {
      recordLayerTarget(node.track->id, layerKey, layerField);
    }
    foldClipModulation(clip, catDevs, node.track, layerKey, layerField);
    return inner;
  }

  /**
   * Composite a CLIPLESS layer over `acc`: the track's own sketch is its
   * content, keyed `track_<trackId>_<devId>`.
   *   - With a generator: a SOURCE layer. The first generator anchors it (it
   *     heads the chain), every other catalog device follows in declaration
   *     order, and the result blends over `acc` — compositeClip's source path.
   *   - Without one: an ADJUSTMENT layer processing `acc` inline, the first
   *     non-mod stage carrying the layer's `__opacity__` — compositeClip's
   *     effect-only path.
   * There is no separate FX bus: the track sketch already IS the chain. Its
   * intra-sketch wires fold like pushTrackFx's (both ends pushed), and the
   * owner paths (rail reads, `__layer__` wires, layer target) run as for any
   * leaf.
   */
  std::optional<std::string> compositeClipless(const CompNode& node,
                                               std::optional<std::string> acc) {
    const TrackM* track = node.track;
    if (!track) return acc;
    std::vector<const DeviceM*> catDevs;
    for (const auto& d : track->sketch.devices) {
      if (cat.has(d.moduleType)) catDevs.push_back(&d);
    }
    // Nothing the engine can run and no routed input → no layer. (A track
    // whose ONLY content is its routed input is a layer: it shows the route.)
    if (catDevs.empty() && !inRouted.count(track->id)) return acc;
    const DeviceM* gen = nullptr;
    for (const DeviceM* d : catDevs) {
      if (cat.isGenerator(d->moduleType)) { gen = d; break; }
    }

    std::string layerKey;
    std::string layerField;
    const std::string relay = inRelay(track);
    if (gen || !relay.empty()) {
      // SOURCE layer: the generator anchors it — or, with a routed input and no
      // generator, the input relay does (the sketch processes the route).
      if (relay.empty() && acc) ensureCursor(*acc);
      std::vector<const DeviceM*> segment;
      if (gen) segment.push_back(gen);
      for (const DeviceM* d : catDevs) {
        if (d != gen) segment.push_back(d);
      }
      std::string firstKey = gen ? std::string() : relay;
      std::string lastKey = gen ? std::string() : relay;
      for (const DeviceM* d : segment) {
        const std::string key = trackInstanceKey(track->id, d->id);
        push(d->moduleType, key, defaultsPlus(*d));
        if (!isMod(d->moduleType)) {
          if (firstKey.empty() || firstKey == relay) firstKey = key;
          lastKey = key;
        }
      }
      if (!lastKey.empty()) {
        outKeys[track->id] = lastKey;
        if (!node.outputNone) {
          acc = blendOver(acc, node, firstKey, lastKey, trackInstanceKey(track->id, "blend"),
                          layerKey, layerField);
        }
      }
    } else {
      // ADJUSTMENT layer over the stack.
      if (acc) ensureCursor(*acc);
      const std::optional<std::string> below = acc;
      bool appliedOpacity = false;
      for (const DeviceM* d : catDevs) {
        nlohmann::json state = defaultsPlus(*d);
        const std::string key = trackInstanceKey(track->id, d->id);
        if (!isMod(d->moduleType) && !appliedOpacity && !node.outputNone) {
          if (node.opacity < 1) state["__opacity__"] = node.opacity;
          layerKey = key;
          layerField = "__opacity__";
          appliedOpacity = true;
        }
        push(d->moduleType, key, std::move(state));
        if (!isMod(d->moduleType)) acc = key;
      }
      if (acc) outKeys[track->id] = *acc;
      if (node.outputNone) acc = below;
    }

    // The sketch's own wires (both ends pushed; `__layer__` wires go through
    // pushOwnerLayerWires below, once the layer slot is known).
    std::set<std::string> pushedIds;
    for (const DeviceM* d : catDevs) pushedIds.insert(d->id);
    for (const auto& w : track->sketch.wires) {
      if (!w.is_object() || !w.contains("src") || !w.contains("dest")) continue;
      const std::string srcKey = w["src"].value("instanceKey", std::string());
      const std::string destKey = w["dest"].value("instanceKey", std::string());
      if (!srcFoldable(srcKey, pushedIds) || !pushedIds.count(destKey)) continue;
      nlohmann::json w2 = w;
      w2["id"] = "tw" + std::to_string(wid++);
      w2["src"] = foldSrc(w["src"], trackInstanceKey(track->id, srcKey));
      w2["dest"] = remapEndpoint(w["dest"], trackInstanceKey(track->id, destKey));
      wires.push_back(std::move(w2));
    }

    if (!layerKey.empty()) recordLayerTarget(track->id, layerKey, layerField);
    collectOwnerReads(track, layerKey, layerField);
    pushOwnerLayerWires(track, layerKey, layerField);
    return acc;
  }

  /** Composite a GROUP over `acc`: children → sub-image over the group's input
   *  base, group FX over that, result blends up (group blend + opacity). */
  std::optional<std::string> compositeGroup(const CompNode& node,
                                            std::optional<std::string> acc) {
    const std::string& mode = node.input.mode;

    std::optional<std::string> sub;
    // A ROUTED input replaces the group's base: its children draw over the
    // route instead of the stack below / a fresh backdrop.
    const std::string relay = inRelay(node.group);
    const bool passThrough = relay.empty() && mode == "underlying";
    if (!relay.empty()) {
      sub = relay;
    } else if (mode == "underlying") {
      sub = acc;  // pass-through: seed with everything composited BELOW the group
    } else if (mode == "transparent") {
      sub = std::nullopt;  // fresh transparent base
    } else {
      const auto rgb =
          mode == "custom" ? hexToRgb01(node.input.color.value_or("#000000"))
                           : std::array<double, 3>{0, 0, 0};
      const std::string bgKey = "group_" + node.group->id + "_bg";
      push(kImplicitAnchor, bgKey, {{"color", rgb}});
      sub = bgKey;
    }

    // Children composite into `sub`, then the group's FX chain runs over the result.
    std::optional<std::string> inner = compositeNodes(node.children, sub);
    if (inner) inner = pushTrackFx(node.group, *inner);
    if (!inner) return acc;  // children produced nothing → leave the parent as-is
    outKeys[node.group->id] = *inner;
    if (node.outputNone) {
      // SEND NOWHERE: rendered for its ports; the parent keeps `acc`.
      collectOwnerReads(node.group, std::string(), std::string());
      return acc;
    }

    // `underlying` at full opacity already CONTAINS the below content — it just
    // replaces the accumulator. Otherwise composite the group OVER the parent.
    // A modulated layer opacity FORCES the blend (the modulation needs a
    // target even while the static value would elide it).
    const bool needBlend =
        acc.has_value() &&
        (node.layerOpacityModulated || !(passThrough && node.opacity >= 1));
    if (!needBlend) {
      // No blend, no opacity application — a group over nothing has no layer
      // opacity even statically; group FX-bus rail reads still resolve.
      collectOwnerReads(node.group, std::string(), std::string());
      return inner;
    }
    const std::string b = "group_" + node.group->id + "_blend";
    push(kBlend, b, {{"mode", node.blendMode}, {"opacity", node.opacity}});
    wires.push_back({{"id", "gw" + std::to_string(wid++)},
                     {"src", {{"instanceKey", *acc}, {"field", "tex_out"}}},
                     {"dest", {{"instanceKey", b}, {"field", "0"}}}});
    wires.push_back({{"id", "gw" + std::to_string(wid++)},
                     {"src", {{"instanceKey", *inner}, {"field", "tex_out"}}},
                     {"dest", {{"instanceKey", b}, {"field", "1"}}}});
    recordLayerTarget(node.group->id, b, "opacity");
    collectOwnerReads(node.group, b, "opacity");
    pushOwnerLayerWires(node.group, b, "opacity");
    return b;
  }

  /** Fold an ordered node list (top → bottom) into `acc` — the downward sum. */
  std::optional<std::string> compositeNodes(const std::vector<CompNode>& ns,
                                            std::optional<std::string> acc) {
    for (const auto& n : ns) {
      acc = n.isGroup      ? compositeGroup(n, acc)
            : n.clipless   ? compositeClipless(n, acc)
            : n.isSequence ? compositeSequence(n, acc)
                           : compositeClip(n, acc);
    }
    return acc;
  }
};

inline void collectClips(const std::vector<CompNode>& ns, std::vector<const ClipM*>& out) {
  for (const auto& n : ns) {
    if (n.isGroup) {
      collectClips(n.children, out);
    } else if (n.clip) {
      out.push_back(n.clip);
      // A sequence node is a leaf AND a parent: its interior sub-clips must
      // reach the background gate + the rail pre-pass like any other clip.
      if (n.isSequence) collectClips(n.children, out);
    }
  }
}

/** Every owner (clip-leaf track + group) in the tree, depth-first. */
inline void collectOwners(const std::vector<CompNode>& ns, std::vector<const TrackM*>& out) {
  for (const auto& n : ns) {
    if (n.isGroup) {
      out.push_back(n.group);
      collectOwners(n.children, out);
    } else if (n.track) {
      out.push_back(n.track);
      // Descend a sequence node so the interior LANE registers as an owner —
      // that's what pulls its rail-read rail nodes alive.
      if (n.isSequence) collectOwners(n.children, out);
    }
  }
}

/** Does the tree hold a clipless leaf anywhere? (It has no clip, so the
 *  clip-leaf walks miss it — but it is content all the same.) */
inline bool anyClipless(const std::vector<CompNode>& ns) {
  for (const auto& n : ns) {
    if (n.clipless) return true;
    if (n.isGroup && anyClipless(n.children)) return true;
  }
  return false;
}

/** A track's port: does it exist, and which way does it face? The main ports
 *  are implicit; named ones come from Track.ports. */
struct PortInfo {
  bool exists = false;
  bool isOut = false;
};

inline PortInfo portInfo(const CompositionM& comp, const std::string& trackId,
                         const std::string& portId) {
  for (const auto& t : comp.tracks) {
    if (t.id != trackId) continue;
    if (portId == kPortIn) return {true, false};
    if (portId == kPortOut) return {true, true};
    for (const auto& p : t.ports) {
      if (p.id == portId) return {true, p.isOut};
    }
    return {};
  }
  return {};
}

/**
 * Is this route one of the three legal shapes? (Ports are hubs.)
 *   feed    — a field inside T → a NAMED out port of T;
 *   send    — an out port → an input field anywhere, or an in port;
 *   receive — an in port of T → an input field inside T.
 * `__in__` is never a source; `__out__` is never a destination.
 */
inline bool routeIsLegal(const CompositionM& comp, const RouteM& r) {
  const RouteEndM& s = r.src;
  const RouteEndM& d = r.dest;
  if (s.isDevice) return false;  // a light is only ever a destination
  if (d.isDevice) {
    // send: an out port (named or __out__) → a placed LIGHT's input
    if (!s.isPort || s.portId == kPortIn) return false;
    const PortInfo sp = portInfo(comp, s.trackId, s.portId);
    if (!sp.exists || !sp.isOut) return false;
    for (const auto& p : comp.devices) {
      if (p.id == d.placementId) return p.kind == "light";
    }
    return false;
  }
  if (!s.isPort && !d.isPort) return false;  // field → field: not through a hub
  if (!s.isPort) {
    // feed
    if (d.portId == kPortOut || d.portId == kPortIn) return false;
    const PortInfo dp = portInfo(comp, d.trackId, d.portId);
    return dp.exists && dp.isOut && s.trackId == d.trackId && !s.deviceId.empty();
  }
  const PortInfo sp = portInfo(comp, s.trackId, s.portId);
  if (!sp.exists || s.portId == kPortIn) return false;
  if (!d.isPort) {
    if (d.deviceId.empty() || d.field.empty()) return false;
    // send (from an out port) or receive (an in port into its own track)
    return sp.isOut || s.trackId == d.trackId;
  }
  // port → port: an out port into an in port of another track
  if (d.portId == kPortOut) return false;
  const PortInfo dp = portInfo(comp, d.trackId, d.portId);
  return sp.isOut && dp.exists && !dp.isOut && s.trackId != d.trackId;
}

/** Owner key of a field end: its clip's device, or the track's own. */
inline std::string fieldEndKey(const RouteEndM& e) {
  return e.clipId.empty() ? trackInstanceKey(e.trackId, e.deviceId)
                          : clipInstanceKey(e.clipId, e.deviceId);
}

/**
 * Resolve every legal route against the finished build: port sources, the
 * wires that carry them, and their status. Emitted AFTER the whole tree so a
 * source can live anywhere in the chain — one below its reader is same-frame,
 * one above is the executor's delayed (1-frame) back edge, which it detects
 * from chain position on its own.
 */
inline void emitRoutes(Builder& b, const CompositionM& comp, nlohmann::json& status,
                       nlohmann::json& lightSources) {
  std::vector<const RouteM*> legal;
  for (const auto& r : comp.routes) {
    if (routeIsLegal(comp, r)) legal.push_back(&r);
  }
  std::map<std::string, size_t> chainIdx;
  for (size_t i = 0; i < b.chain.size(); i++) {
    chainIdx[b.chain[i].value("instance_key", std::string())] = i;
  }
  auto pushed = [&](const std::string& key) { return b.instances.contains(key); };

  struct Src {
    std::string key;
    std::string field;
  };
  // A port's source texture in THIS build (depth-bounded: port chains are
  // at most out → in → field, so 4 hops only guards a malformed cycle).
  std::function<std::optional<Src>(const std::string&, const std::string&, int)> portSource =
      [&](const std::string& trackId, const std::string& portId, int depth) -> std::optional<Src> {
    if (depth > 4) return std::nullopt;
    if (portId == kPortOut) {
      auto it = b.outKeys.find(trackId);
      if (it == b.outKeys.end()) return std::nullopt;
      return Src{it->second, "tex_out"};
    }
    const PortInfo pi = portInfo(comp, trackId, portId);
    if (!pi.exists) return std::nullopt;
    if (pi.isOut) {
      // A named out port: its FEED. A field in the playing clip wins over one
      // in the track sketch; the first pushed feed of each class is taken.
      std::optional<Src> trackFeed;
      for (const RouteM* r : legal) {
        if (!r->dest.isPort || r->dest.trackId != trackId || r->dest.portId != portId) continue;
        if (r->src.isPort) continue;
        const std::string key = fieldEndKey(r->src);
        if (!pushed(key)) continue;
        if (!r->src.clipId.empty()) return Src{key, r->src.field};
        if (!trackFeed) trackFeed = Src{key, r->src.field};
      }
      return trackFeed;
    }
    // An in port: whatever out port is routed into it.
    for (const RouteM* r : legal) {
      if (!r->dest.isPort || r->dest.trackId != trackId || r->dest.portId != portId) continue;
      if (r->src.isPort) return portSource(r->src.trackId, r->src.portId, depth + 1);
    }
    return std::nullopt;
  };

  auto delayedBetween = [&](const std::string& srcKey, const std::string& destKey) {
    const auto si = chainIdx.find(srcKey);
    const auto di = chainIdx.find(destKey);
    return si != chainIdx.end() && di != chainIdx.end() && si->second >= di->second;
  };

  for (const RouteM* r : legal) {
    bool live = false;
    bool delayed = false;
    if (!r->src.isPort) {
      // feed: live when its field's device is actually rendering.
      live = pushed(fieldEndKey(r->src));
    } else if (r->dest.isDevice) {
      // → a light's input: no wire — the host samples the source's texture.
      if (const auto src = portSource(r->src.trackId, r->src.portId, 0)) {
        lightSources[r->dest.placementId] = {{"instanceKey", src->key}, {"field", src->field}};
        live = true;
      }
    } else if (!r->dest.isPort) {
      // send / receive → a texture field
      const auto src = portSource(r->src.trackId, r->src.portId, 0);
      const std::string destKey = fieldEndKey(r->dest);
      if (src && pushed(destKey)) {
        nlohmann::json w = {{"id", "io" + std::to_string(b.wid++)},
                            {"src", {{"instanceKey", src->key}, {"field", src->field}}},
                            {"dest", {{"instanceKey", destKey}, {"field", r->dest.field}}}};
        b.wires.push_back(std::move(w));
        live = true;
        delayed = delayedBetween(src->key, destKey);
      }
    } else if (r->dest.portId == kPortIn) {
      // → a track's main input: its relay (pushed at the head of its chain)
      const auto src = portSource(r->src.trackId, r->src.portId, 0);
      const std::string relay = trackInstanceKey(r->dest.trackId, "in");
      if (src && pushed(relay)) {
        for (const char* slot : {"0", "1"}) {
          b.wires.push_back({{"id", "io" + std::to_string(b.wid++)},
                             {"src", {{"instanceKey", src->key}, {"field", src->field}}},
                             {"dest", {{"instanceKey", relay}, {"field", slot}}}});
        }
        live = true;
        delayed = delayedBetween(src->key, relay);
      }
    } else {
      // → a named in port: resolved through when its receive routes emit.
      live = portSource(r->src.trackId, r->src.portId, 0).has_value();
    }
    if (!r->id.empty()) status[r->id] = {{"live", live}, {"delayed", delayed}};
  }
}

}  // namespace build_detail

/**
 * Build ONE sketch compositing a node tree (top → bottom) into the final image.
 * See clip-sketch.ts buildCompositeSketch for the full semantics (source vs
 * adjustment clips, group sub-composites, two-stage rail routing, background
 * base, master FX bus).
 */
inline SketchBuild buildCompositeSketch(const std::vector<CompNode>& nodes,
                                        const BackgroundM& bg,
                                        const std::map<std::string, double>& railBases,
                                        const std::map<std::string, bool>& railSigned,
                                        const TrackM* mainBus, const Catalog& cat,
                                        // Rails to keep alive UNCONDITIONALLY: the
                                        // rail-driven structural-bypass rails, whose
                                        // reading track may currently be DROPPED from
                                        // the tree — the rail node must survive so its
                                        // value can flip the track back in (the comp
                                        // readback loop). Writers live on other tracks
                                        // by construction.
                                        const std::set<std::string>* keepAliveRails = nullptr,
                                        // The document, for Composition I/O
                                        // (ports + routes). Null ⇒ no routes.
                                        const CompositionM* comp = nullptr) {
  using namespace build_detail;
  Builder b{cat, railBases, railSigned};
  if (comp) {
    for (const auto& r : comp->routes) {
      if (r.dest.isPort && r.dest.portId == kPortIn && routeIsLegal(*comp, r))
        b.inRouted.insert(r.dest.trackId);
    }
  }
  std::optional<std::string> accKey;

  // Flatten to clip leaves for the rail pre-pass + background gate.
  std::vector<const ClipM*> flatClips;
  collectClips(nodes, flatClips);

  // Background base: an opaque solid-color layer UNDER all clips — only when
  // there IS content; `transparent` keeps the old transparent base.
  const std::string& bgMode = bg.mode;
  if ((!flatClips.empty() || anyClipless(nodes)) && bgMode != "transparent") {
    const auto rgb = bgMode == "custom" ? hexToRgb01(bg.color.value_or("#000000"))
                                        : std::array<double, 3>{0, 0, 0};
    b.push(kImplicitAnchor, "arr_bg", {{"color", rgb}});
    accKey = "arr_bg";
  }

  // Rail accumulator nodes (one per rail with an active reader), pushed BEFORE
  // the clip layers. Each is an identity mod.shaper.remap relay.
  auto pushRailNode = [&](const std::string& railId) {
    const std::string key = "rail_" + railId;
    if (b.railNodeKeys.count(key)) return;
    b.railNodeKeys.insert(key);
    const auto baseIt = railBases.find(railId);
    nlohmann::json railState = {
        {"input", baseIt != railBases.end() ? nlohmann::json(baseIt->second)
                                            : nlohmann::json(0)}};
    const auto signedIt = railSigned.find(railId);
    if (signedIt != railSigned.end() && signedIt->second) {
      railState.update({{"in_min", -1}, {"in_max", 1}, {"out_min", -1}, {"out_max", 1}});
    }
    b.push("mod.shaper.remap", key, std::move(railState));
  };
  for (const ClipM* clip : flatClips) {
    std::set<std::string> catIds;
    for (const auto& d : clip->sketch.devices) {
      if (cat.has(d.moduleType)) catIds.insert(d.id);
    }
    for (const auto& read : clip->reads) {
      if (!catIds.count(read.targetDeviceId)) continue;
      pushRailNode(read.railId);
    }
  }
  if (keepAliveRails) {
    for (const auto& railId : *keepAliveRails) pushRailNode(railId);
  }
  // Owner-level (track/group) reads pull their rails alive too. `__layer__`
  // opacity targets always resolve for a rendering layer; FX-device targets
  // need a catalog device on the owner's bus. (`__layer__`/bypass reads are
  // eval-level — no executor rail.)
  {
    std::vector<const TrackM*> owners;
    collectOwners(nodes, owners);
    for (const TrackM* o : owners) {
      for (const auto& read : o->reads) {
        if (read.targetDeviceId == kLayerTargetId) {
          if (read.targetField == "opacity") pushRailNode(read.railId);
          continue;
        }
        for (const auto& d : o->sketch.devices) {
          if (d.id != read.targetDeviceId) continue;
          if (cat.has(d.moduleType) && !cat.isGenerator(d.moduleType)) {
            pushRailNode(read.railId);
          }
          break;
        }
      }
    }
  }

  accKey = b.compositeNodes(nodes, accKey);

  // MASTER FX BUS over the finished composite (only when there IS a composite).
  if (mainBus && accKey) accKey = b.pushTrackFx(mainBus, *accKey);
  // The sketch's image is its LAST linear stage. A send-nowhere track rendered
  // after the final composite would otherwise BE the output — re-emit it.
  // (No-op without I/O: the cursor is the accumulator.)
  if (accKey) b.ensureCursor(*accKey);

  auto isRailSigned = [&](const std::string& railId) {
    const auto it = railSigned.find(railId);
    return it != railSigned.end() && it->second;
  };
  // Stage 1 — writers → the rail accumulator's `input` (per EXPORT combine).
  for (const auto& [railId, writers] : b.railWriters) {
    const std::string railKey = "rail_" + railId;
    if (!b.railNodeKeys.count(railKey)) continue;  // no active reader → nothing pulls it
    const int railMin = isRailSigned(railId) ? -1 : 0;  // rail value domain
    for (const auto& w : writers) {
      const double scale = w.tap->scale.value_or(1);
      nlohmann::json mod = {{"remap",
                             {{"inMin", w.srcMin},
                              {"inMax", w.srcMax},
                              {"outMin", railMin},
                              {"outMax", 1}}}};
      if (scale != 1) mod["scale"] = scale;
      b.wires.push_back({{"id", "rwin" + std::to_string(b.wid++)},
                         {"src", {{"instanceKey", w.key}, {"field", w.field}}},
                         {"dest", {{"instanceKey", railKey}, {"field", "input"}}},
                         {"combine", w.tap->combine},
                         {"mod", std::move(mod)}});
    }
  }
  // Stage 2 — the rail accumulator's `output` → each reader's param (per READ combine).
  for (const auto& r : b.railReaders) {
    const std::string railKey = "rail_" + r.railId;
    if (!b.railNodeKeys.count(railKey)) continue;
    nlohmann::json wire = {{"id", "rwout" + std::to_string(b.wid++)},
                           {"src", {{"instanceKey", railKey}, {"field", "output"}}},
                           {"dest", {{"instanceKey", r.key}, {"field", r.field}}},
                           {"combine", r.tap->combine},
                           {"magnitude", isRailSigned(r.railId) ? "signed" : "unsigned"}};
    if (r.tap->scale && *r.tap->scale != 1) wire["mod"] = {{"scale", *r.tap->scale}};
    b.wires.push_back(std::move(wire));
  }

  nlohmann::json routeStatus = nlohmann::json::object();
  nlohmann::json lightSources = nlohmann::json::object();
  if (comp && !comp->routes.empty()) emitRoutes(b, *comp, routeStatus, lightSources);

  if (b.chain.empty()) return {};
  SketchBuild out;
  out.hasContent = true;
  out.sketch = {{"anchor", nullptr},
                {"chain", std::move(b.chain)},
                {"wires", std::move(b.wires)},
                {"instances", std::move(b.instances)}};
  out.layerTargets = std::move(b.layerTargets);
  out.routeStatus = std::move(routeStatus);
  out.lightSources = std::move(lightSources);
  return out;
}

}  // namespace comp
