// sketch_build.h — fold a composite tree into ONE executor sketch.
//
// LOCK-STEP: web/src/views/arrangement/engine/clip-sketch.ts
// (buildCompositeSketch + clipInstanceKey/trackInstanceKey). The emitted sketch
// JSON must DEEP-EQUAL the TS build for the same inputs — including wire-id
// counters and array order — since byte-equal sketch in ⇒ identical pixels out
// (the same executor consumes it). Shared goldens: test_comp_build.cpp ↔
// comp-goldens.test.ts. Every traversal below deliberately mirrors the TS
// closure structure; do not "clean up" iteration order.
//
// The instance-key strings are a cross-boundary CONTRACT: the TS video decode
// pump injects frames by `clipInstanceKey(clipId, deviceId)`, and engine
// telemetry (pluginStates / modulationData) is keyed by these.

#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "comp_catalog.h"
#include "comp_model.h"

namespace comp {

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
      w2["src"] = {{"instanceKey", transportInstanceKey(clip->id, srcKey)},
                   {"field", w["src"].value("field", std::string())}};
      w2["dest"] = {{"instanceKey", transportInstanceKey(clip->id, destKey)},
                    {"field", w["dest"].value("field", std::string())}};
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
        w2["src"] = {{"instanceKey", trackTransportInstanceKey(track->id, srcKey)},
                     {"field", w["src"].value("field", std::string())}};
        w2["dest"] = {{"instanceKey", trackTransportInstanceKey(track->id, destKey)},
                      {"field", w["dest"].value("field", std::string())}};
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
    for (const DeviceM* d : tcat) {
      if (cat.isGenerator(d->moduleType)) continue;  // tfx = role 'effect' only
      const std::string key = trackInstanceKey(track->id, d->id);
      push(d->moduleType, key, defaultsPlus(*d));
      if (!isMod(d->moduleType)) last = key;
    }
    std::set<std::string> tpushed;
    for (const DeviceM* d : tcat) tpushed.insert(d->id);
    for (const auto& w : track->sketch.wires) {
      if (!w.is_object() || !w.contains("src") || !w.contains("dest")) continue;
      const std::string srcKey = w["src"].value("instanceKey", std::string());
      const std::string destKey = w["dest"].value("instanceKey", std::string());
      if (!tpushed.count(srcKey) || !tpushed.count(destKey)) continue;
      nlohmann::json w2 = w;  // {...w} — spread keeps mod/combine/magnitude/...
      w2["id"] = "tw" + std::to_string(wid++);
      w2["src"] = {{"instanceKey", trackInstanceKey(track->id, srcKey)},
                   {"field", w["src"].value("field", std::string())}};
      w2["dest"] = {{"instanceKey", trackInstanceKey(track->id, destKey)},
                    {"field", w["dest"].value("field", std::string())}};
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
      if (!tpushed.count(srcKey)) continue;
      nlohmann::json w2 = w;
      w2["id"] = "tw" + std::to_string(wid++);
      w2["src"] = {{"instanceKey", trackInstanceKey(owner->id, srcKey)},
                   {"field", w["src"].value("field", std::string())}};
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
            if (!fpushed.count(srcKey) || !fpushed.count(destKey)) continue;
            nlohmann::json w2 = w;
            w2["id"] = "fw" + std::to_string(wid++);
            w2["src"] = {{"instanceKey", clipInstanceKey(fc.id, srcKey)},
                         {"field", w["src"].value("field", std::string())}};
            w2["dest"] = {{"instanceKey", clipInstanceKey(fc.id, destKey)},
                          {"field", w["dest"].value("field", std::string())}};
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
        if (!acc) {
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
    } else {
      // ── EFFECT-only clip: process the accumulator inline (adjustment layer) ──
      bool appliedOpacity = false;
      for (const DeviceM* d : fx) {
        nlohmann::json state = defaultsPlus(*d);
        if (!isMod(d->moduleType) && !appliedOpacity) {
          if (node.opacity < 1) state["__opacity__"] = node.opacity;
          layerKey = clipInstanceKey(clip.id, d->id);
          layerField = "__opacity__";
          appliedOpacity = true;
        }
        push(d->moduleType, clipInstanceKey(clip.id, d->id), std::move(state), startSec);
        if (!isMod(d->moduleType)) acc = clipInstanceKey(clip.id, d->id);
      }
      if (acc) acc = pushTrackFx(node.track, *acc);  // track FX bus over the adjustment
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
      if (!pushed.count(srcKey) || (!destIsLayer && !pushed.count(destKey))) continue;
      if (destIsLayer &&
          (w["dest"].value("field", std::string()) != "opacity" || layerKey.empty())) {
        continue;
      }
      nlohmann::json w2 = w;
      w2["id"] = "cw" + std::to_string(wid++);
      w2["src"] = {{"instanceKey", clipInstanceKey(clip.id, srcKey)},
                   {"field", w["src"].value("field", std::string())}};
      w2["dest"] = destIsLayer
          ? nlohmann::json{{"instanceKey", layerKey}, {"field", layerField}}
          : nlohmann::json{{"instanceKey", clipInstanceKey(clip.id, destKey)},
                           {"field", w["dest"].value("field", std::string())}};
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

  /** Composite a GROUP over `acc`: children → sub-image over the group's input
   *  base, group FX over that, result blends up (group blend + opacity). */
  std::optional<std::string> compositeGroup(const CompNode& node,
                                            std::optional<std::string> acc) {
    const std::string& mode = node.input.mode;

    std::optional<std::string> sub;
    if (mode == "underlying") {
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

    // `underlying` at full opacity already CONTAINS the below content — it just
    // replaces the accumulator. Otherwise composite the group OVER the parent.
    // A modulated layer opacity FORCES the blend (the modulation needs a
    // target even while the static value would elide it).
    const bool needBlend =
        acc.has_value() &&
        (node.layerOpacityModulated || !(mode == "underlying" && node.opacity >= 1));
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
    } else {
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
                                        const std::set<std::string>* keepAliveRails = nullptr) {
  using namespace build_detail;
  Builder b{cat, railBases, railSigned};
  std::optional<std::string> accKey;

  // Flatten to clip leaves for the rail pre-pass + background gate.
  std::vector<const ClipM*> flatClips;
  collectClips(nodes, flatClips);

  // Background base: an opaque solid-color layer UNDER all clips — only when
  // there IS content; `transparent` keeps the old transparent base.
  const std::string& bgMode = bg.mode;
  if (!flatClips.empty() && bgMode != "transparent") {
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

  if (b.chain.empty()) return {};
  SketchBuild out;
  out.hasContent = true;
  out.sketch = {{"anchor", nullptr},
                {"chain", std::move(b.chain)},
                {"wires", std::move(b.wires)},
                {"instances", std::move(b.instances)}};
  out.layerTargets = std::move(b.layerTargets);
  return out;
}

}  // namespace comp
