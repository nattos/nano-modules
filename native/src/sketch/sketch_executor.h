// sketch_executor.h — host-agnostic sketch graph runner.
//
// Walks an editor-shaped sketch graph one frame at a time, dispatching
// each module's compute kernels through the EffectRuntime, plumbing
// data between modules via the explicit + augmentation-synthesized
// taps the sketch carries on its `taps` arrays.
//
// Reusable wherever Metal-backed effects need to run against a
// JSON-shaped graph: the FFGL barrel plugin owns one of these and
// feeds it the sketch mirrored from its WebSocket bridge; the
// in-process bridge_server dylib will own one of these once it grows
// native-effect support; future CLI tools likewise.
//
// What the executor owns:
//   - a small pool of intermediate Metal textures, recycled across
//     frames and resized when the viewport changes;
//   - the per-frame tap/rail routing state.
//
// What the host owns (and passes in):
//   - the EffectRuntime and the ModuleRegistry built against it;
//   - the GPUBackend (Metal today; abstract for future portability);
//   - the input/output texture handles for the frame (typically
//     adopted-from-interop handles in the FFGL host's case).
//
// What the executor does NOT do:
//   - GL/Metal interop (host concern — `InteropTexture` in the FFGL
//     plugin);
//   - texture format conversion (Metal handles RGBA↔BGRA channel
//     semantics);
//   - state persistence (host pulls the sketch JSON from wherever it
//     lives and passes it in);
//   - logging (silent by design; host wraps if it wants traces).

#pragma once

#include "sketch/module_registry.h"

#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <unordered_map>
#include <vector>
#include <string>
#include <tuple>

namespace gpu { class GPUBackend; }
namespace effect_runtime {
class EffectRuntime;
class EffectInstance;
}  // namespace effect_runtime

namespace sketch_executor {

class WetDryBlend;  // host-side opacity wet/dry blend (host_blend.h)

class SketchExecutor {
 public:
  /**
   * Hook fired after each chain entry's render encodes (but before the
   * next entry runs). The handles point at the textures feeding into
   * the stage (`inputHandle`) and the texture it just wrote
   * (`outputHandle`). Both are live for the rest of the frame; the host
   * is expected to issue any downscale+readback before the next frame's
   * `execute()` rotates the intermediate pool.
   *
   * `colIdx`/`chainIdx` match the editor's `chain_entry` trace-point
   * shape so the host can filter against active preview requests.
   */
  using ChainEntryHook = std::function<void(
      int colIdx, int chainIdx,
      int32_t inputHandle, int32_t outputHandle,
      int W, int H)>;

  /**
   * Hook fired after the final chain entry, identifying the texture
   * the host can blit to its surface. Only fires when the sketch
   * actually dispatched something (mirrors execute()'s return value).
   */
  using SketchOutputHook = std::function<void(int32_t handle, int W, int H)>;

  SketchExecutor(effect_runtime::EffectRuntime* rt,
                 ModuleRegistry* registry,
                 gpu::GPUBackend* gpu);
  ~SketchExecutor();

  SketchExecutor(const SketchExecutor&) = delete;
  SketchExecutor& operator=(const SketchExecutor&) = delete;

  /** Set (or clear with empty) the per-chain-entry capture hook. */
  void setChainEntryHook(ChainEntryHook hook) { chainEntryHook_ = std::move(hook); }
  /** Set (or clear with empty) the sketch-output hook. */
  void setSketchOutputHook(SketchOutputHook hook) { sketchOutputHook_ = std::move(hook); }

  /**
   * Predicate that lets a host force a chain entry's output to land in
   * a real intermediate texture (i.e., act as a fusion barrier). The
   * executor calls this for every chain entry during planning; when
   * true, the fusion planner splits the group there so the entry's
   * output is a real readable texture.
   *
   * The barrel uses this to materialise textures that have active
   * preview-monitor subscriptions — without it, fused intermediate
   * stages have no separate texture to read back from.
   */
  using BarrierPredicate = std::function<bool(int colIdx, int chainIdx)>;
  void setBarrierPredicate(BarrierPredicate p) {
    barrierPredicate_ = std::move(p);
  }

  /**
   * Force-disable GPU fusion (every stage takes the standalone path). The
   * production default is on (`auto`: any run of 2+ fusion-eligible effects
   * fuses into one dispatch). Tests flip this to compare the standalone vs
   * fused paths for byte-identity. Invalidates the compiled plan (eligibility
   * is cached there).
   */
  void setFusionEnabled(bool enabled) {
    if (fusionEnabled_ != enabled) { fusionEnabled_ = enabled; planValid_ = false; }
  }

  /**
   * Number of fused-group GPU dispatches the LAST execute() actually issued
   * (i.e. groups that compiled + dispatched as one kernel, not fell back to
   * per-stage). 0 means nothing fused — the signal a fusion test asserts on so
   * a silently-broken fused kernel (which still renders correctly via the
   * fallback) is caught.
   */
  int fusedRunCount() const { return fusedRunCount_; }

  /**
   * Execute one frame.
   *
   * `rawSketch` is the un-augmented graph (typically the editor's
   * current state, mirrored from the bridge). The executor augments
   * it internally — wires implicit struct-rail connections through
   * `sketch_augment::augmentSketchWithImplicitConnections` — before
   * walking. The original JSON is not mutated.
   *
   * `inputHandle` is the GPU texture handle of the upstream pixels
   * (eg the host's adopted GL→Metal input interop). `outputHandle`
   * is the texture handle the executor writes the *final* stage's
   * pixels into (eg the host's output interop). For sketches with
   * no resolvable modules in the chain the executor returns
   * `inputHandle` unchanged (passthrough); the host can use the
   * returned handle to choose what to blit downstream.
   *
   * `W` / `H` are the render-pass dimensions. `dt` is the wall-clock
   * delta since the previous frame, forwarded to each effect's
   * `tick`.
   *
   * `sketchDirty` tells the executor whether `rawSketch` may have changed
   * since the previous call. When false, the executor skips re-pushing each
   * instance's persisted params (applyState) — they can only change when the
   * sketch is edited, and re-applying means a whole-state JSON compare per
   * instance every frame (multi-KB for rich text). The host knows this cheaply
   * (the barrel re-fetches its sketch snapshot only on an editor patch / config
   * change). Defaults to true so callers that don't track it stay correct.
   */
  int32_t execute(const nlohmann::json& rawSketch,
                  int32_t inputHandle, int32_t outputHandle,
                  int W, int H, double dt, bool sketchDirty = true);

  /**
   * The most recent frame's float-rail values, for editor telemetry. Shaped
   * { "columns/<col>": { "<railId>": { "value": <float> } } } to match the web
   * executor's /sketch_state publish. Rebuilt each execute(); the host publishes
   * it (e.g. the barrel plugin → bridge state doc) so the web's rail spark
   * charts can display live values in barrel mode. Empty when no float rails.
   */
  const nlohmann::json& lastRailState() const { return railState_; }

 private:
  effect_runtime::EffectRuntime* rt_;
  ModuleRegistry* registry_;
  gpu::GPUBackend* gpu_;

  // Intermediate Metal textures, walked from cursor 0 each frame.
  // Grown lazily up to (sketch's module count − 1); released on
  // destruction or viewport change.
  std::vector<int32_t> intermediates_;
  int intermediates_w_ = 0;
  int intermediates_h_ = 0;
  int intermediate_cursor_ = 0;

  // Per-frame float-rail values for editor telemetry (see lastRailState()).
  nlohmann::json railState_;

  ChainEntryHook chainEntryHook_;
  SketchOutputHook sketchOutputHook_;
  BarrierPredicate barrierPredicate_;

  // Schemas are constant once the registry's effects are registered
  // (which the host does once at startup), but the augmenter consumes
  // them as a map every frame. Cache the snapshot — `schemas()` was
  // rebuilding ~the same map every frame, hot on the profile.
  std::unordered_map<std::string, nlohmann::json> cachedSchemas_;
  bool cachedSchemasValid_ = false;

  // Per-instance state JSON from the previous frame. Two uses: (1) the
  // whole-state fast path — skip applyState entirely when nothing changed;
  // (2) the per-field diff basis — applyState only fires patches for fields
  // that differ from this snapshot, so a single moving slider doesn't
  // re-patch every field (each patch is a setParam* → firePatched →
  // on_state_patched → val_blobs_ + json::dump cascade). Indexed by sketch
  // instance key. Each chain entry has its own EffectInstance (see
  // EffectRuntime::instanceFor), so the cache keys purely on instance_key.
  std::unordered_map<std::string, nlohmann::json> lastAppliedState_;

  // --- Compiled per-sketch plan (the native analogue of the web's compile-once
  // GraphDefinition). Built once and reused until the host signals the sketch
  // changed (execute()'s `sketchDirty`). It caches everything STRUCTURAL — which
  // chain entries resolve to a registered effect, their module_type/instance_key
  // strings + RegisteredModule pointer, per-stage fusion eligibility (which folds
  // in bypass/opacity — both sketch state, so dirty-gated), and the rail-by-id
  // index — so the per-frame loop stops re-walking nlohmann maps and rebuilding
  // std::strings every frame. Only the changing VALUES (rail floats, tap inputs,
  // textures) are read per frame; group splitting is re-derived per frame from
  // the cached eligibility + the (host-driven) barrier predicate.
  struct PlanEntry {
    size_t chainIdx;             // index into the column's "chain" array
    std::string moduleType;
    std::string instanceKey;
    const RegisteredModule* reg; // never null (only resolvable entries are kept)
    bool eligible;               // fusion-eligible at plan-build time
  };
  struct PlanColumn {
    std::vector<PlanEntry> resolvable;
    std::unordered_map<std::string, nlohmann::json> railsById;  // column-local + sketch-wide
  };
  std::vector<PlanColumn> plan_;
  bool planValid_ = false;
  bool fusionEnabled_ = true;   // force-off disables GPU fusion (test hook)
  int  fusedRunCount_ = 0;      // fused dispatches issued in the last execute()

  // (Re)build plan_ from the (augmented) sketch. Calls instanceFor for each
  // resolvable entry, so instances are materialised here on a dirty frame.
  void buildPlan(const nlohmann::json& columns,
                 const nlohmann::json& instances,
                 const nlohmann::json& sketchRails);

  // Cached compute PSOs for fused chains. Key is the ordered list of
  // module_types joined by '|'. Created lazily on first use; released
  // in the destructor (no host can hot-add effects today, so the cache
  // never grows unboundedly under normal operation).
  std::unordered_map<std::string, int32_t> fusedPSOs_;
  // Compiled shader modules backing those PSOs, kept alive so the
  // GPUBackend doesn't free them out from under us.
  std::vector<int32_t> fusedShaderModules_;

  // Lazily-created host-side wet/dry blend pass for per-effect opacity.
  std::unique_ptr<WetDryBlend> blend_;

  // --- Positional-delay (feedback) wire state, persisted across frames. ---
  // A delayed wire's producer sits at/below its consumer in the chain, so the
  // consumer (processed first) must read the PREVIOUS frame's value. Because
  // the chain runs top-to-bottom, a single persistent map gives the 1-frame
  // delay for free: the consumer reads, then the lower producer overwrites for
  // next frame. Floats: read+write this map directly. Textures: the producer's
  // output is a recycled intermediate, so retain a 1-frame COPY — reads bind
  // the retained texture (last frame's content) and the copy is deferred to
  // frame end (after every stage commits) to avoid a same-frame GPU read/write
  // hazard, mirroring the web executor's wirePrev snapshot.
  std::unordered_map<std::string, float> delayedRailFloats_;
  std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>> delayedRailTextures_;
  // Pending retains gathered during this frame's capture, flushed at frame end:
  // (railId, leaf, producer's current output handle).
  std::vector<std::tuple<std::string, std::string, int32_t>> pendingDelayRetain_;
  int delayTexW_ = 0, delayTexH_ = 0;  // dims of the retained textures (realloc on resize)

  int32_t nextIntermediate(int W, int H);

  // Copy each delayed texture wire's producer output (gathered this frame in
  // pendingDelayRetain_) into a persistent retained texture matching its format,
  // so next frame's consumer reads a stable 1-frame-old copy. Releases + reallocs
  // the retained textures when the viewport resizes. Encoded into the frame's
  // submit batch (after every stage), then clears pendingDelayRetain_.
  void flushDelayedTextureRetains(int W, int H);

  // Apply `state` to the instance, firing setParam* only for fields that
  // differ from `prevState` (pass an empty/non-object prevState to force a
  // full apply). See lastAppliedState_.
  void applyState(effect_runtime::EffectInstance* inst,
                  const nlohmann::json& prevState,
                  const nlohmann::json& state);

  void applyReadTaps(
      effect_runtime::EffectInstance* inst,
      const nlohmann::json& entry,
      const std::unordered_map<std::string, nlohmann::json>& railsById,
      const std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railTextures,
      const std::unordered_map<std::string, float>& railFloats,
      const nlohmann::json& sketchInstances,
      const std::string& instanceKey);

  void captureWriteTaps(
      effect_runtime::EffectInstance* inst,
      const nlohmann::json& entry,
      const std::string& producerInstanceKey,
      const nlohmann::json& sketchInstances,
      const std::unordered_map<std::string, nlohmann::json>& railsById,
      std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railTextures,
      std::unordered_map<std::string, float>& railFloats);

  void markWriteTapOutputsConnected(
      effect_runtime::EffectInstance* inst,
      const nlohmann::json& entry);
};

}  // namespace sketch_executor
