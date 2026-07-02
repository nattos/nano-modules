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
#include <memory>
#include <set>
#include <string>

#include <nlohmann/json.hpp>

#include "../sketch_executor.h"
#include "comp_catalog.h"
#include "comp_model.h"
#include "comp_transport.h"
#include "sketch_build.h"
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

  /** Edge-triggered readiness from the host's decode pump (Precise gate). */
  void setVideoReady(const std::string& clipId, bool ready);

  // ── Per frame ──
  /** Phase 1: advance + evaluate + (re)build. No effrt calls. Returns
   *  CompUpdateFlags. */
  uint32_t update(double dtSec);
  /** Phase 2: fold producer outputs + drive the internal executor. Returns the
   *  output texture handle (or inTex when there is nothing to render). */
  int32_t render(int32_t inTex, int32_t outTex, int32_t W, int32_t H, double dt);

  // ── Readbacks (epoch-gated; each returns a persistent scratch string) ──
  /** Ordered (moduleType, instanceKey) pairs of the active chain. */
  const std::string& requiredJson();
  /** Ordered instance keys of the active chain (trace remap). */
  const std::string& chainKeysJson();
  /** The decode pump's active set (VideoClipDesc[]; target ∪ displayed while
   *  holding — see precise_gate.pumpActiveSet). */
  const std::string& videoDescsJson();

 private:
  void rebuildClock();
  nlohmann::json videoDescFor(const ClipM& clip) const;
  /** Active video-clip descs at `beat` (composite-tree leaves with media). */
  nlohmann::json activeVideoDescsAtBeat(double beat) const;
  /** Active + lookahead-window descs (the pump warm set). */
  nlohmann::json warmVideoDescsAtBeat(double beat) const;
  bool videoReady(const nlohmann::json& descs) const;
  void foldPublishedOutputs(nlohmann::json& sketch);
  static std::string chainSigOf(const nlohmann::json& sketch);
  static nlohmann::json pumpUnion(const nlohmann::json& target, const nlohmann::json& displayed);

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
  bool hasContent_ = false;
  bool dirty_ = false;  // consumed by the next render()
  std::string chainSig_;
  nlohmann::json automation_ = nlohmann::json::array();
  double transportSec_ = 0;

  // Precise gate state.
  std::set<std::string> readyClips_;
  bool holding_ = false;
  double holdClock_ = 0;      // accumulated dt while holding (the force backstop)
  bool forceBypass_ = false;  // set when holdClock_ exceeds the fail-safe timeout
  nlohmann::json pumpDescs_ = nlohmann::json::array();      // what the pump should keep alive
  nlohmann::json displayedDescs_ = nlohmann::json::array(); // active set of the COMMITTED composite

  // Persistent readback scratch (member strings, never inline-static).
  std::string requiredScratch_;
  std::string chainKeysScratch_;
  std::string videoDescsScratch_;
  std::string publishedScratch_;
};

}  // namespace comp
