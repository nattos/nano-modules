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

/** One node of the active composite tree (clip-sketch.ts CompositeNode). */
struct CompNode {
  bool isGroup = false;
  // Clip leaf:
  const ClipM* clip = nullptr;
  const TrackM* track = nullptr;  // owning track (its FX bus runs over the clip)
  double startSec = 0;
  bool hasStartSec = false;
  // Group:
  const TrackM* group = nullptr;
  GroupInputM input;
  // Shared:
  double opacity = 1;
  int blendMode = 0;
  std::vector<CompNode> children;
};

/** Build result: hasContent=false ⇔ the TS build returned null. */
struct SketchBuild {
  bool hasContent = false;
  nlohmann::json sketch;  // { anchor:null, chain, wires, instances }
};

namespace build_detail {

inline constexpr const char* kBlend = "composite.blend";
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

  /** Composite ONE clip leaf over `acc` (source clip → wired blend; effect-only
   *  clip → inline adjustment layer). Returns the new accumulator key. */
  std::optional<std::string> compositeClip(const CompNode& node,
                                           std::optional<std::string> acc) {
    const ClipM& clip = *node.clip;
    std::vector<const DeviceM*> catDevs;
    for (const auto& d : clip.sketch.devices) {
      if (cat.has(d.moduleType)) catDevs.push_back(&d);
    }
    const DeviceM* gen = nullptr;
    for (const DeviceM* d : catDevs) {
      if (cat.isGenerator(d->moduleType)) { gen = d; break; }
    }
    std::vector<const DeviceM*> fx;
    for (const DeviceM* d : catDevs) {
      if (!cat.isGenerator(d->moduleType)) fx.push_back(d);
    }
    const double* startSec = node.hasStartSec ? &node.startSec : nullptr;

    if (gen || catDevs.empty()) {
      // ── SOURCE clip: render standalone, then composite OVER the accumulator ──
      std::string firstKey;
      std::string lastKey;
      if (gen) {
        std::vector<const DeviceM*> segment{gen};
        segment.insert(segment.end(), fx.begin(), fx.end());
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

      if (!lastKey.empty()) {
        lastKey = pushTrackFx(node.track, lastKey);  // track FX bus over the clip output
        if (!acc) {
          // First (top) layer becomes the accumulator; sub-1 opacity fades via the
          // reserved wet/dry key.
          if (node.opacity < 1) instances[firstKey]["state"]["__opacity__"] = node.opacity;
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
          acc = b;
        }
      }
    } else {
      // ── EFFECT-only clip: process the accumulator inline (adjustment layer) ──
      bool appliedOpacity = false;
      for (const DeviceM* d : fx) {
        nlohmann::json state = defaultsPlus(*d);
        if (!isMod(d->moduleType) && !appliedOpacity && node.opacity < 1) {
          state["__opacity__"] = node.opacity;
          appliedOpacity = true;
        }
        push(d->moduleType, clipInstanceKey(clip.id, d->id), std::move(state), startSec);
        if (!isMod(d->moduleType)) acc = clipInstanceKey(clip.id, d->id);
      }
      if (acc) acc = pushTrackFx(node.track, *acc);  // track FX bus over the adjustment
    }

    // Fold this clip's modulation wires in, remapping device ids → composite keys.
    std::set<std::string> pushed;
    for (const DeviceM* d : catDevs) pushed.insert(d->id);
    for (const auto& w : clip.sketch.wires) {
      if (!w.is_object() || !w.contains("src") || !w.contains("dest")) continue;
      const std::string srcKey = w["src"].value("instanceKey", std::string());
      const std::string destKey = w["dest"].value("instanceKey", std::string());
      if (!pushed.count(srcKey) || !pushed.count(destKey)) continue;
      nlohmann::json w2 = w;
      w2["id"] = "cw" + std::to_string(wid++);
      w2["src"] = {{"instanceKey", clipInstanceKey(clip.id, srcKey)},
                   {"field", w["src"].value("field", std::string())}};
      w2["dest"] = {{"instanceKey", clipInstanceKey(clip.id, destKey)},
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
    return acc;
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
    const bool needBlend = acc.has_value() && !(mode == "underlying" && node.opacity >= 1);
    if (!needBlend) return inner;
    const std::string b = "group_" + node.group->id + "_blend";
    push(kBlend, b, {{"mode", node.blendMode}, {"opacity", node.opacity}});
    wires.push_back({{"id", "gw" + std::to_string(wid++)},
                     {"src", {{"instanceKey", *acc}, {"field", "tex_out"}}},
                     {"dest", {{"instanceKey", b}, {"field", "0"}}}});
    wires.push_back({{"id", "gw" + std::to_string(wid++)},
                     {"src", {{"instanceKey", *inner}, {"field", "tex_out"}}},
                     {"dest", {{"instanceKey", b}, {"field", "1"}}}});
    return b;
  }

  /** Fold an ordered node list (top → bottom) into `acc` — the downward sum. */
  std::optional<std::string> compositeNodes(const std::vector<CompNode>& ns,
                                            std::optional<std::string> acc) {
    for (const auto& n : ns) acc = n.isGroup ? compositeGroup(n, acc) : compositeClip(n, acc);
    return acc;
  }
};

inline void collectClips(const std::vector<CompNode>& ns, std::vector<const ClipM*>& out) {
  for (const auto& n : ns) {
    if (n.isGroup) collectClips(n.children, out);
    else out.push_back(n.clip);
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
                                        const TrackM* mainBus, const Catalog& cat) {
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
  for (const ClipM* clip : flatClips) {
    std::set<std::string> catIds;
    for (const auto& d : clip->sketch.devices) {
      if (cat.has(d.moduleType)) catIds.insert(d.id);
    }
    for (const auto& read : clip->reads) {
      if (!catIds.count(read.targetDeviceId)) continue;
      const std::string key = "rail_" + read.railId;
      if (b.railNodeKeys.count(key)) continue;
      b.railNodeKeys.insert(key);
      const auto baseIt = railBases.find(read.railId);
      nlohmann::json railState = {
          {"input", baseIt != railBases.end() ? nlohmann::json(baseIt->second)
                                              : nlohmann::json(0)}};
      const auto signedIt = railSigned.find(read.railId);
      if (signedIt != railSigned.end() && signedIt->second) {
        railState.update({{"in_min", -1}, {"in_max", 1}, {"out_min", -1}, {"out_max", 1}});
      }
      b.push("mod.shaper.remap", key, std::move(railState));
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
  return out;
}

}  // namespace comp
