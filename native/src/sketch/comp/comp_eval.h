// comp_eval.h — timeline evaluation at a beat: the composite tree, automation
// entries, and rail bases.
//
// LOCK-STEP with two TS sources (shared goldens: test_comp_build.cpp ↔
// comp-goldens.test.ts):
//   - web/src/views/arrangement/state/store.ts — compositeTreeAtBeat /
//     pickActiveClip / solo+bypass propagation (store.ts:1693-1790).
//   - web/src/views/arrangement/engine/composite-frame.ts — the shared
//     "timeline at a beat → engine commands" seam (buildCompositeRenderAtBeat,
//     automationEntriesAtBeat, railBasesAtBeat) + automation-eval.ts.
//
// Curve values evaluate through the native envelope math (envelope.h — the
// same code the executor's tap_mod uses), which runs in float; the TS twin
// (editors/envelope-math.ts) runs in double, so golden comparisons use a small
// relative tolerance on numbers.

#pragma once

#include <algorithm>
#include <limits>
#include <map>
#include <set>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "../envelope.h"
#include "comp_catalog.h"
#include "comp_model.h"
#include "sketch_build.h"
#include "warp_curve.h"

namespace comp {

// ── Automation / rail-curve evaluation (engine/automation-eval.ts) ──────────

/** Evaluate an automation/base curve at normalized x (eased envelope math).
 *  Clamps flat outside the point range; 0 for an empty curve. */
inline double evalCurveAt(const std::vector<EnvPointM>& points, double xNorm) {
  if (points.empty()) return 0;
  // toEnvPoints: {x,y,bend}→{x,y,ease}, sorted by x (stable, like JS sort).
  std::vector<envelope::Point> pts;
  pts.reserve(points.size());
  for (const auto& p : points) {
    pts.push_back({static_cast<float>(p.x), static_cast<float>(p.y), static_cast<float>(p.bend)});
  }
  std::stable_sort(pts.begin(), pts.end(),
                   [](const envelope::Point& a, const envelope::Point& b) { return a.x < b.x; });
  return envelope::eval(pts.data(), static_cast<int>(pts.size()), static_cast<float>(xNorm));
}

/** Owner context for a lane (automation-eval.ts LaneOwnerCtx). */
struct LaneOwnerCtx {
  bool isClip = false;
  double startBeat = 0;
  double spanBeats = 0;
  bool loopMode = false;
};

/** Evaluate a lane at an absolute arrangement beat. Track lanes' points carry
 *  absolute beats; clip lanes are normalized [0,1] over the clip span. */
inline double evalLaneAtBeat(const std::vector<EnvPointM>& points, const LaneOwnerCtx& ctx,
                             double arrangementBeat) {
  if (!ctx.isClip) return evalCurveAt(points, arrangementBeat);  // points ARE beats
  const double span = std::max(1e-6, ctx.spanBeats);
  const double elapsed = arrangementBeat - ctx.startBeat;
  if (elapsed <= 0) return evalCurveAt(points, 0);
  const double local = ctx.loopMode ? std::fmod(elapsed, span) : std::min(elapsed, span);
  return evalCurveAt(points, local / span);  // clip points are normalized [0,1]
}

// ── Composite tree (store.compositeTreeAtBeat) ──────────────────────────────

/** Pick the single active clip on a track at `beat` (latest-started on overlap),
 *  or nullptr. Skips empty + bypassed clips. */
inline const ClipM* pickActiveClip(const TrackM& track, double beat) {
  const ClipM* pick = nullptr;
  for (const auto& c : track.clips) {
    if (beat < c.startBeat || beat >= c.startBeat + c.lengthBeat) continue;
    if (!c.hasSourceUrl && c.sketch.devices.empty()) continue;  // empty clip
    if (!pick || c.startBeat >= pick->startBeat) pick = &c;     // latest-started wins
  }
  return (!pick || pick->bypassed) ? nullptr : pick;
}

namespace eval_detail {

inline double clamp01(double v) { return std::max(0.0, std::min(1.0, v)); }

struct TreeBuilder {
  const CompositionM& comp;
  bool anySolo;

  std::vector<const TrackM*> childrenOf(const std::string& parentId) const {
    std::vector<const TrackM*> out;
    for (const auto& t : comp.tracks) {
      if (t.parentId == parentId) out.push_back(&t);
    }
    return out;
  }

  bool build(const TrackM& track, bool ancestorSoloed, double beat, CompNode& out) const {
    if (track.bypassed) return false;  // bypassed track/group → drop the subtree
    const bool soloedHere = ancestorSoloed || track.soloed;
    if (track.kind == TrackKind::Group) {
      if (isMainBus(track)) return false;  // master bus isn't a content group
      std::vector<CompNode> children;
      for (const TrackM* c : childrenOf(track.id)) {
        CompNode n;
        if (build(*c, soloedHere, beat, n)) children.push_back(std::move(n));
      }
      if (children.empty()) return false;  // nothing to composite → omit the group
      out.isGroup = true;
      out.group = &track;
      out.opacity = clamp01(track.level.value_or(1));
      out.blendMode = track.blendMode.value_or(0);
      out.input = track.groupInput.present ? track.groupInput : GroupInputM{};
      out.children = std::move(children);
      return true;
    }
    if (track.kind != TrackKind::Track) return false;  // rails aren't composite layers
    if (anySolo && !soloedHere) return false;          // solo restricts to soloed lineages
    const ClipM* clip = pickActiveClip(track, beat);
    if (!clip) return false;
    out.isGroup = false;
    out.clip = clip;
    out.track = &track;
    out.opacity = clamp01(track.level.value_or(1));
    out.blendMode = track.blendMode ? *track.blendMode : clip->blendMode.value_or(0);
    return true;
  }
};

/** Every clip leaf in a composite tree (depth-first). */
inline void flattenLeaves(std::vector<CompNode>& tree, std::vector<CompNode*>& out) {
  for (auto& n : tree) {
    if (n.isGroup) flattenLeaves(n.children, out);
    else out.push_back(&n);
  }
}

}  // namespace eval_detail

/** The active composite as a tree, top → bottom (downward sum). Main bus
 *  excluded. `ignoreSolo` (the exporter) renders the full mix. */
inline std::vector<CompNode> compositeTreeAtBeat(const CompositionM& comp, double beat,
                                                 bool ignoreSolo = false) {
  bool anySolo = false;
  if (!ignoreSolo) {
    for (const auto& t : comp.tracks) {
      if (t.soloed) { anySolo = true; break; }
    }
  }
  eval_detail::TreeBuilder builder{comp, anySolo};
  std::vector<CompNode> roots;
  for (const TrackM* t : builder.childrenOf(std::string())) {
    CompNode n;
    if (builder.build(*t, false, beat, n)) roots.push_back(std::move(n));
  }
  return roots;
}

// ── The shared per-frame seam (composite-frame.ts) ──────────────────────────

/** Per-rail base value + signed flag at `beat` (railBasesAtBeat). */
inline void railBasesAtBeat(const CompositionM& comp, const std::vector<CompNode*>& leaves,
                            double beat, std::map<std::string, double>& railBases,
                            std::map<std::string, bool>& railSigned) {
  const double totalBeats = compositionLengthBeats(comp);
  for (const CompNode* leaf : leaves) {
    for (const auto& read : leaf->clip->reads) {
      if (railBases.count(read.railId)) continue;
      const TrackM* rt = railTrackFor(comp, read.railId);
      railBases[read.railId] =
          rt && rt->hasBaseCurve
              ? evalCurveAt(rt->baseCurve, totalBeats > 0 ? beat / totalBeats : 0)
              : 0;
      railSigned[read.railId] = rt ? rt->railSigned : false;
    }
  }
}

/**
 * Fold an already-evaluated composite tree into ONE composite sketch — group FX
 * over composited children, rail bases + per-clip start-seconds baked in
 * (warp-aware; startSec is baked onto the tree nodes in place). The tree must
 * come from compositeTreeAtBeat over the SAME comp/beat/ignoreSolo.
 */
inline SketchBuild buildCompositeRenderFromTree(const CompositionM& comp, const Catalog& cat,
                                                const WarpClock& clock,
                                                std::vector<CompNode>& tree, double beat) {
  if (tree.empty()) return {};
  // Bake each clip leaf's absolute start time (s) onto its node, for effect seeks.
  std::vector<CompNode*> leaves;
  eval_detail::flattenLeaves(tree, leaves);
  for (CompNode* leaf : leaves) {
    leaf->startSec = clock.secondsAt(leaf->clip->startBeat);
    leaf->hasStartSec = true;
  }
  std::map<std::string, double> railBases;
  std::map<std::string, bool> railSigned;
  railBasesAtBeat(comp, leaves, beat, railBases, railSigned);
  // The main bus runs its FX chain over the final composite unless bypassed.
  const TrackM* bus = mainBusTrack(comp);
  const TrackM* masterBus = bus && !bus->bypassed ? bus : nullptr;
  return buildCompositeSketch(tree, comp.background, railBases, railSigned, masterBus, cat);
}

/**
 * Fold the active composite tree at `beat` into ONE composite sketch —
 * see buildCompositeRenderFromTree. (The goldens replay this entry point.)
 */
inline SketchBuild buildCompositeRenderAtBeat(const CompositionM& comp, const Catalog& cat,
                                              const WarpClock& clock, double beat,
                                              bool ignoreSolo = false) {
  std::vector<CompNode> tree = compositeTreeAtBeat(comp, beat, ignoreSolo);
  return buildCompositeRenderFromTree(comp, cat, clock, tree, beat);
}

/**
 * The earliest beat at which the composite tree, the pump's active set, or the
 * warm lookahead window can change again given a STATIC document — i.e. how far
 * an evaluation at `beat` stays valid (the eval-skip span end). Candidates per
 * clip: its start (activates at start, inclusive), its end (deactivates /
 * leaves the warm window at start+length), and its warm-window entry
 * (start - lookahead; STRICT predicate `beat > start-lookahead`, so an eval
 * exactly ON that edge yields a zero-length span — re-evaluated next frame,
 * correct but unskipped). Solo/bypass/lanes are beat-independent; rail BASE
 * values vary continuously but are re-asserted per frame through the
 * automation channel, so they deliberately do NOT bound the span. Returns
 * +inf past the last edge. Anything that mutates the document must invalidate
 * separately (CompExecutor::invalidateEval).
 */
inline double nextEvalBoundary(const CompositionM& comp, double beat, double lookaheadBeats) {
  double next = std::numeric_limits<double>::infinity();
  for (const auto& t : comp.tracks) {
    if (t.kind != TrackKind::Track) continue;
    for (const auto& c : t.clips) {
      const double start = c.startBeat;
      const double end = c.startBeat + c.lengthBeat;
      const double warmEnter = start - lookaheadBeats;
      if (start > beat) next = std::min(next, start);
      if (end > beat) next = std::min(next, end);
      if (warmEnter >= beat) next = std::min(next, warmEnter);
    }
  }
  return next;
}

/**
 * Evaluate this beat's parameter automation over an already-evaluated composite
 * tree: every active clip lane (clip-relative), track/group lane (absolute
 * beats), plus a `replace` re-assertion of each active rail's base onto its
 * accumulator `input`. Lane/curve VALUES vary continuously with the beat, so
 * this runs every frame — but the walked TREE only changes at eval boundaries,
 * so a caller holding a cached tree skips the per-frame tree rebuild.
 * Returns the AutomationEntry[] as JSON (the executor's setAutomation shape).
 */
inline nlohmann::json automationEntriesForTree(const CompositionM& comp,
                                               const std::vector<CompNode>& tree, double beat,
                                               bool clipLoopMode = true) {
  const double totalBeats = compositionLengthBeats(comp);
  nlohmann::json entries = nlohmann::json::array();
  std::set<std::string> seenRail;

  auto pushTrackLanes = [&](const TrackM& track) {
    for (const auto& lane : track.automation) {
      LaneOwnerCtx ctx;  // kind 'track'
      entries.push_back({{"instance", trackInstanceKey(track.id, lane.targetDeviceId)},
                         {"field", lane.targetField},
                         {"value", evalLaneAtBeat(lane.points, ctx, beat)},
                         {"combine", lane.combine.value_or("replace")},
                         {"magnitude", lane.magnitude.value_or("unsigned")}});
    }
  };

  std::function<void(const std::vector<CompNode>&)> walk =
      [&](const std::vector<CompNode>& nodes) {
        for (const auto& n : nodes) {
          if (n.isGroup) {
            pushTrackLanes(*n.group);
            walk(n.children);
            continue;
          }
          const ClipM& clip = *n.clip;
          for (const auto& lane : clip.automation) {
            LaneOwnerCtx ctx;
            ctx.isClip = true;
            ctx.startBeat = clip.startBeat;
            ctx.spanBeats = clip.lengthBeat;
            ctx.loopMode = clipLoopMode;
            entries.push_back({{"instance", clipInstanceKey(clip.id, lane.targetDeviceId)},
                               {"field", lane.targetField},
                               {"value", evalLaneAtBeat(lane.points, ctx, beat)},
                               {"combine", lane.combine.value_or("replace")},
                               {"magnitude", lane.magnitude.value_or("unsigned")}});
          }
          if (n.track) pushTrackLanes(*n.track);
          for (const auto& read : clip.reads) {
            if (seenRail.count(read.railId)) continue;
            seenRail.insert(read.railId);
            const TrackM* rt = railTrackFor(comp, read.railId);
            const double base =
                rt && rt->hasBaseCurve
                    ? evalCurveAt(rt->baseCurve, totalBeats > 0 ? beat / totalBeats : 0)
                    : 0;
            entries.push_back({{"instance", std::string("rail_") + read.railId},
                               {"field", "input"},
                               {"value", base},
                               {"combine", "replace"},
                               {"magnitude", "unsigned"}});
          }
        }
      };
  walk(tree);
  // The main bus isn't in the composite tree, but its master-FX chain does run
  // over the final composite, so emit its lanes too.
  const TrackM* bus = mainBusTrack(comp);
  if (bus && !bus->bypassed) pushTrackLanes(*bus);
  return entries;
}

/** automationEntriesForTree over a freshly-evaluated tree (the goldens replay
 *  this entry point). */
inline nlohmann::json automationEntriesAtBeat(const CompositionM& comp, double beat,
                                              bool ignoreSolo = false, bool clipLoopMode = true) {
  const std::vector<CompNode> tree = compositeTreeAtBeat(comp, beat, ignoreSolo);
  return automationEntriesForTree(comp, tree, beat, clipLoopMode);
}

}  // namespace comp
