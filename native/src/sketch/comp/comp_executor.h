// comp_executor.h — the composition executor: the arrangement compositor's
// engine core, running inside the sketch_executor dual-compile source set
// (native in the barrel; part of executor.wasm on web).
//
// Owns the mirrored composition DOCUMENT (comp_model), the warp-aware
// TRANSPORT, timeline evaluation at the playhead (comp_eval), the cached
// composite sketch (sketch_build), and an internal SketchExecutor it drives
// with the in-memory JSON — no per-frame serialization anywhere. The host
// (web engine worker / native barrel) sends edits as document loads + cheap
// ops, transport commands, and video-frame readiness; steady-state playback
// needs NO host messages.
//
// Per-frame contract (mirrors the async-instance seam the web host needs):
//   update(dt)  — advance transport, evaluate the timeline, (re)build the
//                 cached sketch. NEVER calls effrt (instances may not exist
//                 yet); returns flags telling the host what changed.
//   render(...) — fold live producer outputs into the sketch (effrt), then
//                 drive the internal executor synchronously.
//
// The Precise transport gate lives here (decision native; readiness facts
// pushed by the host's decode pump via setVideoReady) — see precise_gate.h
// and engine-bridge.ts showComposite for the TS twin being inverted.

#pragma once

#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "../sketch_executor.h"
#include "comp_catalog.h"
#include "comp_model.h"
#include "comp_transport.h"
#include "sketch_build.h"
#include "streams_table.h"
#include "warp_curve.h"

namespace effect_runtime { class EffectRuntime; }
namespace gpu { class GPUBackend; }

namespace comp {

/** comp_update() result bits. */
enum CompUpdateFlags : uint32_t {
  /** Chain topology changed — the host must re-ensure instances
   *  (comp_required_json) and refresh trace keys (comp_chain_keys_json). */
  kCompStructureChanged = 1u << 0,
  /** The composite has content (false ⇒ host clears/plays the backdrop). */
  kCompHasContent = 1u << 1,
  /** Precise gate is HOLDING — render() re-issues the held sketch. */
  kCompHoldingPrecise = 1u << 2,
  /** The decode pump's active set changed (comp_video_descs_json). */
  kCompVideoSetChanged = 1u << 3,
  /** Launched-scene state changed (comp_scene_states_json). */
  kCompScenesChanged = 1u << 4,
  /** The transport pre-pass's driven-clip row set changed
   *  (comp_transport_order_json). */
  kCompTransportSetChanged = 1u << 5,
};

class CompExecutor {
 public:
  /** Backend pointers may all be null in the wasm build (the internal
   *  SketchExecutor reaches its runtime through the effrt/gpu imports). */
  CompExecutor(effect_runtime::EffectRuntime* rt, sketch_executor::ModuleRegistry* registry,
               gpu::GPUBackend* gpuBackend);
  ~CompExecutor();

  CompExecutor(const CompExecutor&) = delete;
  CompExecutor& operator=(const CompExecutor&) = delete;

  /** The internal executor — the host reuses executor_debug_stats /
   *  executor_modulation_json / executor_set_fusion_enabled against it.
   *  NOTE: invalidated by resetInternalExecutor(); don't cache across frames. */
  sketch_executor::SketchExecutor* sketchExecutor() { return ex_.get(); }

  /** Editor-preview hooks, retained so a reset re-wires them (comp_api routes
   *  these to the "trace" host imports on web). */
  void setTraceHooks(sketch_executor::SketchExecutor::ChainEntryHook chainEntry,
                     sketch_executor::SketchExecutor::SketchOutputHook output,
                     sketch_executor::SketchExecutor::BarrierPredicate barrier);

  /**
   * Rebuild the internal SketchExecutor from scratch (schemas re-seeded from the
   * catalog, hooks re-wired, next render dirty). The web host calls this when a
   * previously-applied instance was pruned and re-enters the chain — a fresh web
   * instance holds DEFAULT params while the old executor's lastAppliedState_
   * still matches the sketch, so the per-key apply would be skipped (the exact
   * revive bug the plain path fixes by rebuilding its slot). Document, transport,
   * and gate state all live HERE, so the reset is render-state-only.
   */
  void resetInternalExecutor();

  /** Register a module's schema: feeds the role/defaults catalog AND the
   *  internal executor. Must cover every referenced module type before the
   *  first update() (unknown types degrade to "not in catalog": skipped). */
  void registerSchema(const std::string& moduleType, const nlohmann::json& fields);
  void registerCapabilities(const std::string& moduleType, const nlohmann::json& caps);

  // ── Document ──
  /** Full document replace: open/new/undo/redo/any structural edit. */
  void loadDocument(const nlohmann::json& doc);
  /** Bumps on loadDocument only (cheap ops don't) — mirrors store.warpEpoch. */
  int32_t docEpoch() const { return docEpoch_; }

  /** Cheap op (drag fast path): merge ONE field into a device's state. The
   *  device is found on any clip or track sketch owned by `ownerId` (a clip id
   *  or track id). Never replaces the whole state object. */
  void setDeviceParam(const std::string& ownerId, const std::string& deviceId,
                      const std::string& field, const nlohmann::json& value);
  void setTrackLevel(const std::string& trackId, double level);
  /** Cheap op: replace a video clip's source placement transform (anchor /
   *  scale / rotation / flip) — the xform-drag fast path. Reaches the built
   *  sketch AND the pump descs, so it invalidates the eval. */
  void setSourceTransform(const std::string& clipId, const nlohmann::json& transform);
  /** Replace a lane's points ((x,y,bend) triples). Owner = clip or track id. */
  void setLanePoints(const std::string& ownerId, const std::string& laneId,
                     const double* xyBend, int32_t nPoints);
  /** Replace a rail track's base curve ((x,y,bend) triples). */
  void setRailBase(const std::string& railTrackId, const double* xyBend, int32_t nPoints);

  // ── Transport ──
  void play();
  void pause();
  bool playing() const { return state_.playing; }
  void seekBeat(double beat);
  void setLoop(bool enabled, double startBeat, double endBeat);
  /** Precise (true, default) stalls on unready video; live free-runs. */
  void setTransportMode(bool precise) { precise_ = precise; }
  void setClipAutoTiming(bool loopMode) { clipLoopMode_ = loopMode; }
  void setIgnoreSolo(bool on);
  double positionBeat() const { return state_.positionBeat; }
  double positionSec() const;
  /** The composition's base tempo (frameState.bpm for comp-mode instances). */
  double bpm() const { return doc_.baseBPM; }

  /** Edge-triggered readiness from the host's decode pump (Precise gate +
   *  pending-launch commits). */
  void setVideoReady(const std::string& clipId, bool ready);
  /** One-shot handshake: the host DOES run a readiness feed (the web bridge
   *  sends it at comp boot). Without it every launch commits immediately —
   *  the native barrel has no feed, so its behavior is unchanged. */
  void setVideoReadyFeed() { readyFeedAlive_ = true; }

  /** Launch deadline class carried by the launch intent (gapless handover):
   *  Instant = commit now in Live mode (a played stab — keep pumping frames);
   *  Loose = the switch may LINGER on the outgoing scene while the incoming
   *  video warms (autopilot/follow default). Precise mode defers both. */
  enum LaunchClass : int32_t { kLaunchInstant = 0, kLaunchLoose = 1 };

  // ── Scenes (transient launch state — the "session-view live clip trigger"
  // the invalidateEval doc-comment anticipated; never a document reload) ──
  /** Launch `sceneId` on scene track `trackId`, anchored at the REQUEST beat.
   *  Re-launching the active scene RETRIGGERS (re-anchors) it. When a
   *  readiness feed is alive and the incoming video isn't decoded yet, the
   *  commit DEFERS (per the class/mode policy) — the outgoing scene keeps
   *  playing while the pump warms the incoming one (gapless handover). */
  void launchScene(const std::string& trackId, const std::string& sceneId,
                   int32_t cls = kLaunchInstant);
  /** Stop the playing scene on `trackId` (the track leaves the composite). */
  void stopScene(const std::string& trackId);
  /** Stop every playing scene (document open). */
  void stopAllScenes();

  /**
   * Drop the cached timeline evaluation (the eval-skip span) so the next
   * update() re-evaluates the world. Called internally by loadDocument and by
   * every cheap op that can reach the BUILT sketch (params, track levels, rail
   * bases, ignoreSolo). This is THE hook for future incremental mutations —
   * e.g. a session-view live clip trigger should mutate the mirror and call
   * this (one re-eval next frame), never reload the document. If some future
   * feature automates document-shaped state per frame, each tick invalidates
   * and performance degrades to the old eval-every-frame behavior — correct,
   * just slower.
   */
  void invalidateEval() { evalValid_ = false; }

  /** Real (non-skipped) timeline evaluations so far (test/diagnostic). */
  int64_t evalCount() const { return evalCount_; }
  /** The cached span's end (the next beat needing re-eval; test/diagnostic). */
  double evalBoundaryBeat() const { return evalNextBoundary_; }

  // ── Per frame ──
  /** Phase 1: advance + evaluate + (re)build. No effrt calls. Returns
   *  CompUpdateFlags. */
  uint32_t update(double dtSec);
  /**
   * Phase 1.5 — the transport PRE-PASS: execute the merged transport-section
   * sketch (its own tiny internal executor, 1x1 dummy textures, all-identity)
   * and read each driven clip's published transport_* scalars into the
   * per-clip resolved rows. Call between update() and render(), AFTER the
   * host has ensured this frame's instances (the web seam) — so plugin timing
   * lands SAME-FRAME in the video pump and the streams content positions.
   * While Precise-holding it runs on the frozen beat (targets stay live).
   * Rows whose instance doesn't exist yet resolve invalid → consumers fall
   * back to ClipLoopConfig for that frame.
   */
  void transportResolve(double dtSec);
  /** Phase 2: fold producer outputs + drive the internal executor. Returns the
   *  output texture handle (or inTex when there is nothing to render). */
  int32_t render(int32_t inTex, int32_t outTex, int32_t W, int32_t H, double dt);

  /** One resolved transport row (the 8 published transport_* scalars). */
  struct TransportResolved {
    double timeSec = 0;
    double active = 1;
    double rate = std::numeric_limits<double>::quiet_NaN();
    double nextJumpSec = std::numeric_limits<double>::quiet_NaN();
    double jumpTargetSec = std::numeric_limits<double>::quiet_NaN();
    double loopStartSec = std::numeric_limits<double>::quiet_NaN();
    double loopEndSec = std::numeric_limits<double>::quiet_NaN();
    double ended = 0;
    /** Declared future (streams events): REMAINING seconds until content end,
     *  -1 = none declared. The default must stay -1 — a missing field means
     *  "no prediction", never "ends now". */
    double nextEndSec = -1;
    /** Declared completed-pass count (integer; increments append 'looped'). */
    double loopCount = 0;
    /** False until the effect instance exists AND published transport_time_sec. */
    bool valid = false;
  };
  /** Resolved rows, index-aligned with transportOrder(). */
  const std::vector<TransportResolved>& transportResolved() const { return transportResolved_; }
  /** Driven clip ids in row order (the times-channel key list). */
  std::vector<std::string> transportOrder() const;

  // ── Readbacks (epoch-gated; each returns a persistent scratch string) ──
  /** Ordered (moduleType, instanceKey) pairs of the active chain. */
  const std::string& requiredJson();
  /** Ordered instance keys of the active chain (trace remap). */
  const std::string& chainKeysJson();
  /** The decode pump's active set (VideoClipDesc[]; target ∪ displayed while
   *  holding — see precise_gate.pumpActiveSet). */
  const std::string& videoDescsJson();
  /** The build's `__layer__` resolution: ownerId → {instanceKey, field} where
   *  each layer's opacity lives (SketchBuild.layerTargets). Refreshed per eval;
   *  the UI resolves modulation bands through it across per-clip key churn. */
  const std::string& layerTargetsJson();
  /** Launched scenes: {trackId: {sceneId, launchBeat}} (UI playing highlight). */
  const std::string& sceneStatesJson();
  /** Deferred handovers (trackId → incoming {sceneId, launchBeat, launchSec}). */
  const std::string& pendingScenesJson();
  /** The STATIC seekable-streams registry (streams_table.h) — the web engine
   *  worker mirrors it into its StreamsRegistry on doc-epoch change only. */
  const std::string& streamsJson();
  /** Driven clip ids in times-channel row order (kCompTransportSetChanged). */
  const std::string& transportOrderJson();

  /** The live streams registry — the effect-facing `streams` import module
   *  reads it (natively via WasmContext.streams_table; the table's `frame`
   *  sample is mutated in place per update()). */
  const StreamsTable& streamsTable() const { return streamsTable_; }
  StreamsTable& streamsTableMutable() { return streamsTable_; }
  /** The beat→seconds clock the lazy content-position eval needs. */
  const WarpClock& warpClock() const { return clock_; }

 private:
  void rebuildClock();
  /** Rebuild the seekable-streams registry (doc-shaped; loadDocument only).
   *  Live scene anchors survive: re-applied from sceneLaunch_ after a build. */
  void rebuildStreamsTable();
  /** (Re)build the merged transport-section sketch + row list for the current
   *  eval (sectioned active leaves + the lookahead window; ROWS stay
   *  driven-only). Called from ensureEvalAt; a chain-sig change raises
   *  kCompStructureChanged + kCompTransportSetChanged. */
  void rebuildTransportSketch(double beat, uint32_t& flags);
  /** Apply queued streams.seek/stop write verbs (validated: scene tracks
   *  only, bypassed/empty targets dropped — the trigger matcher's rules).
   *  Runs at transportResolve entry (render-fired ops from last frame; works
   *  with no section at all) AND exit (section fires apply same-frame). */
  void drainStreamOps();
  /** Refresh streamsTable_.frame from the current transport state (both
   *  update() exits — the import handlers read it directly). */
  void sampleStreamsFrame();
  /** Drop launch entries whose track/scene vanished from the (re)loaded doc —
   *  a delete lands as a doc reload, so this IS delete-playing-scene-stops-it.
   *  Also auto-stops elapsed one-shot scenes when called per frame. Sets
   *  scenesDirty_ + invalidateEval() on any change. */
  void healSceneLaunches();
  /** `unbounded`: launched scenes play until stopped/replaced — their desc
   *  window must not end at the grid cell's lengthBeat (the pump treats the
   *  window end as "clip over": frames freeze + the Precise gate flickers). */
  nlohmann::json videoDescFor(const ClipM& clip, double anchorBeat, bool unbounded = false) const;
  /** Active video-clip descs of an evaluated tree (leaves with media). */
  nlohmann::json videoDescsForTree(const std::vector<CompNode>& tree) const;
  /** Active + lookahead-window descs at `beat` (the pump warm set). */
  nlohmann::json warmVideoDescs(const std::vector<CompNode>& tree, double beat) const;
  /**
   * Make the cached evaluation current for `beat`: skip when the span still
   * covers it (evalValid_ && evalBeat_ <= beat < evalNextBoundary_), else
   * re-evaluate the tree/sketch/descs, recompute the span, and fold any
   * structure flags into `flags`. Returns true when a real eval ran.
   */
  bool ensureEvalAt(double beat, uint32_t& flags);
  bool videoReady(const nlohmann::json& descs) const;
  void foldPublishedOutputs(nlohmann::json& sketch);
  /** Rebuild the trigger routing map (instanceKey → {moduleType, railId}) from
   *  the document: every device whose type declares `trigger_source`, routed to
   *  its clip's matching triggerExport or the global trigger rail. Doc-shaped
   *  → recomputed on loadDocument only. */
  void rebuildTriggerRoutes();
  /** Post-render: consume new trigger EVENTS from every routed live trigger
   *  source's published "triggers" ring (seq > lastSeen; a seq regression =
   *  instance reset → resync) and launch matching scenes: effective listen rail
   *  (scene ?? track ?? global) + channel via sceneChannelAssignments; first
   *  matching scene in order wins, a later same-frame event overwrites the
   *  slot. 1-frame latency, like the rail-bypass readback. */
  void readTriggerSignals();
  /** Post-render: read each structural-bypass rail's live `output` (published-
   *  state mirror), threshold >= 0.5, and store per-track decisions. Next
   *  update() compares against the vector used at eval → invalidateEval on a
   *  flip (the 1-frame "iterative update" readback loop). */
  void readRailBypassSignals();
  static std::string chainSigOf(const nlohmann::json& sketch);
  static nlohmann::json pumpUnion(const nlohmann::json& target, const nlohmann::json& displayed);
  /** Drop ready latches for clips no longer in the pump set (their decoders
   *  are disposed — stale readiness would defeat handover deferral). */
  void pruneReadyClips();

  effect_runtime::EffectRuntime* rt_;  // native effrt rebind; null in wasm
  sketch_executor::ModuleRegistry* registry_;  // for internal-executor rebuilds
  gpu::GPUBackend* gpu_;
  sketch_executor::SketchExecutor::ChainEntryHook chainEntryHook_;
  sketch_executor::SketchExecutor::SketchOutputHook outputHook_;
  sketch_executor::SketchExecutor::BarrierPredicate barrierHook_;
  Catalog catalog_;
  CompositionM doc_;
  bool docLoaded_ = false;
  int32_t docEpoch_ = 0;
  WarpClock clock_;
  TransportController transport_;
  TransportState state_;
  bool precise_ = true;
  bool ignoreSolo_ = false;
  bool clipLoopMode_ = true;

  std::unique_ptr<sketch_executor::SketchExecutor> ex_;

  nlohmann::json cleanSketch_;  // structural basis (mirror-built, no live outputs)
  nlohmann::json execSketch_;   // clean + folded producer outputs (what execute() gets)
  nlohmann::json layerTargets_ = nlohmann::json::object();  // ownerId → {instanceKey, field}
  bool hasContent_ = false;
  bool dirty_ = false;  // consumed by the next render()
  std::string chainSig_;
  nlohmann::json automation_ = nlohmann::json::array();
  double transportSec_ = 0;

  // ── Eval-skip span (see ensureEvalAt): the timeline evaluation at evalBeat_
  // stays valid for beats in [evalBeat_, evalNextBoundary_) while the document
  // is untouched, so steady playback inside one clip span skips the tree walk,
  // sketch JSON build, desc builds, and deep compares entirely. The cached
  // tree holds pointers INTO doc_ — any doc_ mutation must invalidateEval()
  // (loadDocument additionally clears the tree; cheap ops mutate fields in
  // place so the pointers stay alive until the next eval).
  std::vector<CompNode> evalTree_;
  nlohmann::json evalActiveDescs_ = nlohmann::json::array();
  nlohmann::json evalWarmDescs_ = nlohmann::json::array();
  bool evalValid_ = false;
  double evalBeat_ = 0;
  double evalNextBoundary_ = 0;
  /** Lane-driven `__layer__`/bypass decisions captured at eval time; a flip at
   *  the current beat invalidates the span (see ensureEvalAt). */
  std::map<std::string, bool> evalBypassDecisions_;
  /** Rail-driven structural-bypass decisions: written by the post-render
   *  readback (readRailBypassSignals), consumed by the NEXT eval (1-frame
   *  latency — rails are computed during render). */
  std::map<std::string, bool> railBypassDecisions_;
  /** The rail decision snapshot the current eval's tree was built with. */
  std::map<std::string, bool> evalRailBypass_;
  /** Transient launched-scene state per scene track (comp_eval.h SceneLaunch).
   *  OUTSIDE doc_: survives cheap ops and (healed) document reloads; reset only
   *  by stopAllScenes (document open). Entries hold ids, not pointers. */
  std::map<std::string, SceneLaunch> sceneLaunch_;
  bool scenesDirty_ = true;  // ship sceneStatesJson on the next update
  /** Deferred launch commits (gapless handover): request-anchored, single
   *  slot per track (last wins). While pending, the OUTGOING scene keeps
   *  playing (heal skips its stop paths) and the incoming scene's desc ships
   *  ACTIVE-SHAPED in the warm set so the pump opens+plays+injects it — its
   *  readiness edge (or the wall-clock deadline) commits the launch. */
  struct PendingLaunch {
    std::string sceneId;
    double requestBeat = 0;
    double requestSec = 0;
    double ageSec = 0;  // wall-clock (dtSec accumulated — never transport time)
    int32_t cls = 0;
  };
  std::map<std::string, PendingLaunch> pendingLaunch_;
  /** The POST-COMMIT world's sketch while a handover is pending (identical
   *  instance keys to what the commit will build) — requiredJson ships its
   *  chain so the worker pre-instantiates the incoming scene. */
  nlohmann::json pendingSketch_;
  bool readyFeedAlive_ = false;
  void applyPendingLaunches(double dtSec);
  void commitLaunch(const std::string& trackId, const std::string& sceneId,
                    double launchBeat, double launchSec);
  const ClipM* findSceneClip(const std::string& trackId, const std::string& sceneId) const;
  /** Trigger-source routing (instanceKey → target rail), doc-shaped. */
  struct TriggerRoute {
    std::string moduleType;
    std::string railId;
  };
  std::map<std::string, TriggerRoute> triggerRoutes_;
  /** Per trigger-source instance: the last consumed event seq. First sight
   *  baselines at the ring's current max (history is never replayed). */
  std::map<std::string, long long> triggerSeqSeen_;
  /** Recheck the pump target/displayed sets on the next non-holding frame even
   *  without a re-eval (set while holding: the pump ran a displayed∪warm union
   *  that must collapse back to warm-only after the hold releases). */
  bool pumpRecheck_ = true;
  int64_t evalCount_ = 0;

  // Precise gate state.
  std::set<std::string> readyClips_;
  bool holding_ = false;
  double holdClock_ = 0;      // accumulated dt while holding (the force backstop)
  bool forceBypass_ = false;  // set when holdClock_ exceeds the fail-safe timeout
  nlohmann::json pumpDescs_ = nlohmann::json::array();      // what the pump should keep alive
  nlohmann::json displayedDescs_ = nlohmann::json::array(); // active set of the COMMITTED composite

  /** Seekable-streams registry (streams_table.h): rebuilt on loadDocument;
   *  frame sample + scene anchors mutated in place between rebuilds. */
  StreamsTable streamsTable_;

  // ── Transport pre-pass (transportResolve) ──
  /** Its own internal executor: the section sketch must run BEFORE render()'s
   *  executor sees the frame, and shares nothing with the pixel chain. */
  std::unique_ptr<sketch_executor::SketchExecutor> transportEx_;
  /** One row per DRIVEN warm clip; strings precomputed at rebuild so the
   *  per-frame resolve allocates nothing. Clip pointers live in doc_ —
   *  cleared with the eval tree on loadDocument. */
  struct TransportRow {
    const ClipM* clip = nullptr;
    std::string clipId;
    std::string moduleType;   // the winning controller device's type
    std::string instanceKey;  // transportInstanceKey(clip, device)
  };
  std::vector<TransportRow> transportRows_;
  std::vector<TransportResolved> transportResolved_;
  nlohmann::json transportCleanSketch_;
  nlohmann::json transportExecSketch_;
  std::string transportSig_;
  bool transportDirty_ = false;
  /** Clips whose controller latched transport_ended=1 (scene auto-stop input;
   *  pruned to the current row set every resolve). */
  std::set<std::string> transportEnded_;
  int32_t transportInTex_ = -1;
  int32_t transportOutTex_ = -1;

  // Persistent readback scratch (member strings, never inline-static).
  std::string requiredScratch_;
  std::string chainKeysScratch_;
  std::string videoDescsScratch_;
  std::string layerTargetsScratch_;
  std::string sceneStatesScratch_;
  std::string pendingScenesScratch_;
  std::string streamsScratch_;
  std::string transportOrderScratch_;
};

}  // namespace comp
