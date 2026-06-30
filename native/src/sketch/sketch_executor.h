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

// Only the pure RegisteredModule struct — NOT module_registry.h (which pulls
// the ModuleRegistry class + native effect_runtime/wasm refs). The executor
// forward-declares ModuleRegistry for its native-only constructor arg/member;
// the .cpp includes the full header under #ifndef __wasm__ for the seed.
#include "sketch/registered_module.h"
#include "sketch/param_smoothing.h"
#include "sketch/delay_line.h"

#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <string>
#include <tuple>

namespace gpu { class GPUBackend; }
namespace effect_runtime {
class EffectRuntime;
class EffectInstance;
}  // namespace effect_runtime

namespace sketch_executor {

class ModuleRegistry;  // native registry (full def in module_registry.h)
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

  /**
   * Register (or replace) a module's schema in the executor's own cache. The
   * executor derives the texture-leaf paths + positional input-slot order from
   * `schemaFields` and uses them for wire routing / slot binding — it does NOT
   * consult the ModuleRegistry at run time. The native host seeds this from the
   * registry; the wasm host pushes each effect's schema here before execute().
   */
  void registerModuleSchema(const std::string& moduleType,
                            const nlohmann::json& schemaFields);

  /**
   * Attach a module's declarative `capabilities` tags to its cached schema
   * entry (must be called after registerModuleSchema for that type). The
   * executor gates modulation auto-connect on these (modulation_source /
   * modulation_shaper). Native seeds them from the registry; the wasm host
   * pushes them via executor_register_capabilities. Forces a plan rebuild
   * since capabilities change the implicit-wire topology.
   */
  void registerModuleCapabilities(const std::string& moduleType,
                                  std::vector<std::string> capabilities);

  /**
   * Per-frame parameter AUTOMATION side-channel. The host (arrangement) draws
   * automation curves over time, evaluates them at the playhead each frame, and
   * pushes the normalized values here as a JSON array
   * `[{ "instance": <instanceKey>, "field": <fieldPath>, "value": <0..1>,
   *     "combine": "replace|mix|add|mul", "magnitude": "signed|unsigned" }, …]`.
   * execute() folds each into its target field through the SAME tap_mod range-map
   * + combine the wire system uses (applyMagnitude against the field's schema
   * [min,max]) — so the math isn't duplicated in TS and the sketch JSON / its
   * cached plan are untouched. Replaces the previous frame's set; empty clears.
   */
  void setAutomation(const nlohmann::json& entries);

  /**
   * Prefix applied to every effect instance_key before it reaches the shared
   * EffectRuntime instance pool (via effrt_instance_for). Lets many executors
   * share ONE runtime without colliding: the FFGL barrel sets this to its
   * stable per-instance UUID so two barrels' identical bare keys ("inv@0") map
   * to distinct EffectInstances/user_state_. Default empty → single-runtime
   * hosts (executor.wasm web, one-barrel) behave exactly as before. Only the
   * shared-pool lookup is namespaced; the executor's own per-(bare-key) maps
   * stay bare (they're already per-executor objects).
   */
  void setKeyNamespace(std::string ns) { keyNamespace_ = std::move(ns); }

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

  /** Test-only: total buildPlan() calls so far. A param-only dirty frame must
   *  NOT bump this (cached plan reused); a topology change must. */
  int planBuildCountForTest() const { return planBuildCount_; }

  /**
   * Number of fused-group GPU dispatches the LAST execute() actually issued
   * (i.e. groups that compiled + dispatched as one kernel, not fell back to
   * per-stage). 0 means nothing fused — the signal a fusion test asserts on so
   * a silently-broken fused kernel (which still renders correctly via the
   * fallback) is caught.
   */
  int fusedRunCount() const { return stats_.fusedRuns; }

  /**
   * Per-frame debug counters for the LAST execute(). Drives the editor's "Debug
   * Info" panel — the host reads these after each frame (web: via the
   * `executor_debug_stats` export). Writes 7 int32s in this fixed order:
   * [effectsExecuted, standaloneDispatches, fusedRuns, fusedStages,
   *  dispatchesSaved, gpuDispatches, identitySkipped]. The last two are derived
   * (gpuDispatches = standalone + fusedRuns; dispatchesSaved = fusedStages −
   * fusedRuns) so the host doesn't recompute them.
   */
  void fillDebugStats(int32_t* out) const {
    out[0] = stats_.effectsExecuted;
    out[1] = stats_.standaloneDispatches;
    out[2] = stats_.fusedRuns;
    out[3] = stats_.fusedStages;
    out[4] = stats_.fusedStages - stats_.fusedRuns;            // dispatchesSaved
    out[5] = stats_.standaloneDispatches + stats_.fusedRuns;   // gpuDispatches
    out[6] = stats_.identitySkipped;
  }

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

  /**
   * The most recent frame's modulation telemetry for editor UI: for each
   * instance that has a modulated scalar INPUT (a read tap on a float field),
   * the effective resolved value plus the swing band the modulation can reach.
   * Shaped { "<instanceKey>": { "<field>": { value, min, max } } }. Rebuilt
   * each execute() and exposed so a slider can draw the band + effective marker
   * over the user's base value. Empty when nothing is modulated. The band is
   * computed by re-running the lock-step tap_mod fold over the source output's
   * declared range (recordModBand) — identical math native and web.
   */
  const nlohmann::json& lastModulationData() const { return modulationData_; }

 private:
  // Native-only seed/runtime sources, used solely under #ifndef __wasm__
  // (effrtSetRuntime + the schema seed). The executor drives the GPU + effect
  // instances through the gpu/effrt free-function ABIs, NOT these pointers — so
  // it links with no GPUBackend at all (the constructor's `gpu` arg is ignored;
  // the gpu_* ABI resolves the backend globally via currentRuntime()).
  effect_runtime::EffectRuntime* rt_;
  ModuleRegistry* registry_;

  // Intermediate Metal textures, walked from cursor 0 each frame.
  // Grown lazily up to (sketch's module count − 1); released on
  // destruction or viewport change.
  std::vector<int32_t> intermediates_;
  int intermediates_w_ = 0;
  int intermediates_h_ = 0;
  int intermediate_cursor_ = 0;

  // Per-frame float-rail values for editor telemetry (see lastRailState()).
  nlohmann::json railState_;

  // Per-frame modulation telemetry for editor UI (see lastModulationData()).
  nlohmann::json modulationData_;

  // Engine-level per-(instance,field) parameter-smoothing ramp state, persisted
  // across frames (keyed [instanceKey][fieldPath]). The built-in
  // `FieldOptions.smoothing` option linearly ramps a scalar field's final
  // (post-modulation) value toward each new target over `duration` seconds, via
  // param_smoothing.h (the lock-step twin of web/src/param-smoothing.ts). Applied
  // on the standalone path after read taps; smoothing forces an entry standalone.
  std::unordered_map<std::string,
      std::unordered_map<std::string, param_smoothing::SmoothState>> smoothState_;

  // This frame's parameter automation (setAutomation), keyed by instance key →
  // array of {field,value,combine,magnitude}. Folded in execute() after read taps.
  std::unordered_map<std::string, nlohmann::json> automationByInstance_;

  // Per-(instance,field) modulation DELAY lines (the wire's continuous-time
  // `mod.shaper.delay`, seconds), persisted across frames. A wire shaper stage parallel
  // to smoothing: it time-shifts a modulated input's final (post-fold) value by
  // `delay` seconds via delay_line.h (the same math as the mod.shaper.delay effect).
  // Transitive (doesn't change the value's range), so it runs after the pure
  // envelope/remap/scale fold and before smoothing. Advanced by modClock_.
  // NB: distinct from a tap's `delayed` flag, which is the 1-frame feedback delay
  // used for cycle breaking — this is a user-set wall-clock delay.
  std::unordered_map<std::string,
      std::unordered_map<std::string, delay_line::DelayLine<512>>> delayState_;
  // Monotonic modulation clock (seconds), advanced by the CLAMPED (≥0) `dt` once per
  // execute(). The shared time base the delay lines push/read against.
  double modClock_ = 0.0;

 public:
  // Absolute transport time (seconds) for THIS frame, pushed by the host before
  // execute() (web: executor_set_time). Drives deterministic effect seeks:
  //  - a backward jump (frameAbsSec_ < last) seeks seekable effects to the new time;
  //  - a newly-activated instance (a clip that just started playing) seeks to its
  //    CLIP-RELATIVE time (frameAbsSec_ − the chain entry's baked `startSec`), so its
  //    phase lands where a play-through would have it — not at 0 from the jump point.
  // Untouched (0) for hosts that don't push it (native barrel/tests): no jump seeks,
  // and a new instance just seeks to 0 == its fresh phase. See execute().
  void setFrameTime(double sec) { frameAbsSec_ = sec; }

 private:
  double frameAbsSec_ = 0.0;
  double prevAbsSec_ = 0.0;
  // Instance keys ticked last frame — a key absent here is newly activated this frame.
  std::unordered_set<std::string> knownKeys_;

  ChainEntryHook chainEntryHook_;
  SketchOutputHook sketchOutputHook_;
  BarrierPredicate barrierPredicate_;

  // Schemas are constant once the registry's effects are registered
  // (which the host does once at startup), but the augmenter consumes
  // them as a map every frame. Cache the snapshot — `schemas()` was
  // rebuilding ~the same map every frame, hot on the profile.
  std::unordered_map<std::string, nlohmann::json> cachedSchemas_;
  bool cachedSchemasValid_ = false;

  // The executor's OWN schema cache (schemaFields + derived texture-leaf paths +
  // positional input-slot order), keyed by module_type. Populated via
  // registerModuleSchema (host push) or, natively, seeded from registry_ on the
  // first execute(). find()/wire-routing read this, not the ModuleRegistry, so
  // the executor can run with no registry in the wasm build.
  std::unordered_map<std::string, RegisteredModule> moduleSchemas_;
  const RegisteredModule* findSchema(const std::string& moduleType) const;

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
    const RegisteredModule* reg; // schema/metadata for this chain entry
    bool eligible;               // fusion-eligible at plan-build time
  };
  struct PlanColumn {
    std::vector<PlanEntry> resolvable;
    std::unordered_map<std::string, nlohmann::json> railsById;  // column-local + sketch-wide
  };
  std::vector<PlanColumn> plan_;
  bool planValid_ = false;
  // Structural signature of the sketch the cached plan_ was built from (chain
  // topology + rail defs + bypass/opacity — NOT param values). On a dirty frame
  // the plan is rebuilt only when this changes, so param-only slider/knob drags
  // (which set the coarse value-dirty flag every frame) skip the rebuild.
  std::string planStructSig_;
  // Test-only: counts buildPlan() invocations so a unit test can assert that a
  // param-only dirty frame reuses the cached plan while a topology change forces
  // a rebuild. Has no effect on rendering.
  int planBuildCount_ = 0;
  bool fusionEnabled_ = true;   // force-off disables GPU fusion (test hook)
  std::string keyNamespace_;    // prefix into the SHARED instance pool (per-barrel)

  // Per-frame debug counters, reset at the top of each execute() and surfaced
  // via fillDebugStats() (see above). `fusedRuns` doubles as the fusion-test
  // signal exposed by fusedRunCount().
  struct DebugStats {
    int effectsExecuted = 0;     // resolvable chain entries processed (all columns)
    int standaloneDispatches = 0;// stages that ran their own render() dispatch
    int fusedRuns = 0;           // fused-kernel dispatches actually issued
    int fusedStages = 0;         // surviving (non-identity) stages folded into fused runs
    int identitySkipped = 0;     // stages skipped via the identity predicate
  };
  DebugStats stats_;

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
  void applyState(int32_t inst,
                  const nlohmann::json& prevState,
                  const nlohmann::json& state);

  void applyReadTaps(
      int32_t inst,
      const nlohmann::json& entry,
      const std::unordered_map<std::string, nlohmann::json>& railsById,
      const std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railTextures,
      const std::unordered_map<std::string, float>& railFloats,
      const std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railBuffers,
      const nlohmann::json& sketchInstances,
      const std::string& instanceKey,
      // When non-null, records each modulated FLOAT field's final post-fold
      // value (the target the smoothing pass ramps toward). See applySmoothing.
      std::unordered_map<std::string, float>* outModulatedScalars = nullptr);

  // Fold this frame's automation entries (setAutomation) for `instanceKey` into
  // their target fields, via applyMagnitude against each field's schema range —
  // the same math applyReadTaps uses for wires. Run right after applyReadTaps.
  void applyAutomation(int32_t inst, const nlohmann::json& entry,
                       const nlohmann::json& sketchInstances,
                       const std::string& instanceKey,
                       std::unordered_map<std::string, float>* outModulatedScalars);

  // Apply a wire's continuous-time `delay` (seconds) to a modulated field's final
  // post-fold `value`, via a per-(instance,field) delay line in delayState_. The
  // line is fed one sample per frame at modClock_; the return is the value from
  // `delaySec` seconds ago (linearly interpolated, underrun-clamped to the start
  // value). `delaySec <= 0` is pass-through and forgets any stale line so a later
  // re-enable starts settled. Transitive — runs after the pure fold, before
  // smoothing. Shared by the standalone read-tap path and the dashboard path.
  float applyModDelay(const std::string& instanceKey, const std::string& field,
                      float value, float delaySec);

  // Apply the engine-level `FieldOptions.smoothing` option to this instance:
  // for each smoothing-enabled scalar field, linearly ramp the plugin-visible
  // value toward its target (the modulated value when a read tap drove it this
  // frame — passed in `modulatedScalars` — else the canonical serialized
  // scalar). Runs every frame on the standalone path, after applyReadTaps and
  // before doTick. State persists in smoothState_. No-op without fieldOptions.
  void applySmoothing(
      int32_t inst,
      const nlohmann::json& entry,
      const std::string& instanceKey,
      const nlohmann::json& sketchInstances,
      const std::unordered_map<std::string, float>& modulatedScalars,
      double dt);

  void captureWriteTaps(
      int32_t inst,
      const nlohmann::json& entry,
      const std::string& producerInstanceKey,
      const nlohmann::json& sketchInstances,
      const std::unordered_map<std::string, nlohmann::json>& railsById,
      std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railTextures,
      std::unordered_map<std::string, float>& railFloats,
      std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railBuffers,
      // Read-tap-modulated scalars from applyReadTaps this frame. A field that
      // is BOTH read-tapped and write-tapped (a "relay" field, e.g. a dashboard
      // knob driven by an LFO) publishes this modulated value instead of its
      // canonical serialized state. nullptr → no relay (publish state as usual).
      const std::unordered_map<std::string, float>* modulatedScalars = nullptr);

  void markWriteTapOutputsConnected(
      int32_t inst,
      const nlohmann::json& entry);
};

}  // namespace sketch_executor
