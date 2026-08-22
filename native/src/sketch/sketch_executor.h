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
#include <optional>
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
class WetDryBlend;      // host-side opacity wet/dry blend (host_blend.h)
class SidechannelBlit;  // host-side sidechannel scaled blit (host_sidechannel_blit.h)
class OutputBlit;       // host-side output resample/convert (host_output_blit.h)

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
   * Host-supplied EXTERNAL scalar sources for the next execute() — values for
   * wires whose `src.instanceKey` lives outside the chain (currently MIDI
   * device controls, prefix "midi:"). Shape:
   * `{ "midi:<uuid>": { "b0/e05/turn": 0.42, ... }, ... }`, values normalized
   * unsigned 0..1. The wire translation synthesizes a float rail (tagged
   * `external`) + the normal read tap for such wires, so TapMod / combine /
   * magnitude / smoothing and the modulation band all fold through the SAME
   * pipeline as module wires. A wire whose value is absent here leaves its
   * rail unseeded → its read tap is skipped → the dest keeps its authored
   * value (dormant wire: missing/deleted/disconnected device). Values ride
   * outside the sketch JSON, so per-frame changes never dirty the cached plan.
   * Replaces the previous frame's set; empty clears.
   */
  void setExternalScalars(const nlohmann::json& values);

  /**
   * Host-injected live scalar for an IN-CHAIN instance's field (e.g. the
   * barrel routing Resolume's macro knobs into a control.barrel_macros
   * instance). captureWriteTaps reads these ahead of the doc's instance
   * state, so the values flow into wires every frame WITHOUT mutating the
   * sketch doc — per-frame doc mutation would defeat the clean-frame
   * exec-doc cache (values would freeze at the last dirty frame).
   */
  void setInjectedScalar(const std::string& instanceKey,
                         const std::string& field, float value) {
    injectedScalars_[instanceKey][field] = value;
  }
  void clearInjectedScalars() { injectedScalars_.clear(); }

  /**
   * REPLACE the whole injected-scalar table at once:
   * `{"<instanceKey>": {"ch_0": 0.4, ...}, ...}`. The table-shaped sibling of
   * setInjectedScalar, for hosts that reach the executor across a boundary a
   * per-field call can't cross cheaply — the web pushes one JSON blob through
   * `executor_set_injected_scalars` rather than one call per channel per frame.
   *
   * Replace-all, so an instance that stops being fed stops injecting (with the
   * per-field setter a removed source would keep its last value forever). A
   * host uses one style or the other, not both: this clears what the per-field
   * setter wrote.
   */
  void setInjectedScalars(const nlohmann::json& table) {
    injectedScalars_.clear();
    if (!table.is_object()) return;
    for (const auto& [instanceKey, fields] : table.items()) {
      if (!fields.is_object()) continue;
      for (const auto& [field, value] : fields.items())
        if (value.is_number())
          injectedScalars_[instanceKey][field] = value.get<float>();
    }
  }

  /**
   * Host-injected FRAME texture for an in-chain instance — the video pump
   * handing a decoded frame to a `source.video.file` entry.
   *
   * Bound as the instance's numeric "0" texture field, which the slot scan
   * below turns into input slot 0 (what the effect reads via inputTexture(0)).
   * That is the same path the web worker takes (`host.textureFields.set('0',
   * handle)` in applyInstanceTextures), including the ordering: it lands
   * BEFORE read taps, so a wire bound to slot 0 still wins.
   *
   * The handle is borrowed — the pump's frame cache owns the texture and its
   * lifetime. Pass -1 to UNBIND, which stores -1 rather than forgetting the
   * key: the instance keeps whatever texture field it was last given, so
   * dropping the entry would leave the last decoded frame frozen on screen
   * instead of clearing it. `clearInjectedTextures()` is the real forget.
   */
  void setInjectedTexture(const std::string& instanceKey, int32_t textureHandle) {
    injectedTextures_[instanceKey] = textureHandle < 0 ? -1 : textureHandle;
  }
  void clearInjectedTextures() { injectedTextures_.clear(); }

  /**
   * Clean-frame fast path (executor_execute with sketch_len == 0): run from
   * the cached exec doc without any host-passed JSON — the wasm host skips
   * the stringify → copy → parse round-trip entirely on clean frames.
   * Passthrough when nothing is cached yet (host misuse guard).
   */
  int32_t executeCached(int32_t inTex, int32_t outTex, int W, int H, double dt) {
    if (!cachedExecDocValid_) return inTex;
    return execute(cachedExecDoc_, inTex, outTex, W, H, dt, /*sketchDirty=*/false);
  }

  /**
   * Forget the per-instance applied-state cache so every instance's authored
   * state re-fires on the next frame (as if freshly dirty). Hosts call this at
   * EDIT rate (e.g. on a composition document reload) to fix the pinned-param
   * lifecycle: removing a wire/lane can rebuild a byte-identical sketch, and
   * the whole-state fast path would otherwise skip re-asserting the authored
   * value the modulation had been overriding.
   */
  void forceStateReassert() { lastAppliedState_.clear(); ++stateEpoch_; }

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

  /**
   * Identity tag this executor writes onto sidechannel-bus channels it
   * publishes (see sidechannel_bus.h): the barrel sets its plugin key, the
   * web host its sketch id. Purely informational (UI channel labels) — bus
   * routing is by channel name, and reader identity is derived from the
   * executor address + instance key, not this tag.
   */
  void setBusTag(std::string tag) { busTag_ = std::move(tag); }

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
   * Number of final output-format blits (resample/convert into the caller's
   * outputHandle) the LAST execute() issued. 0 whenever the sketch has no
   * active `outputFormat` override — the identity-path guard tests assert on
   * this to prove the default path gained no extra GPU passes.
   */
  int outputBlitCount() const { return stats_.outputBlits; }

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
  // destruction or viewport/format change.
  std::vector<int32_t> intermediates_;
  int intermediates_w_ = 0;
  int intermediates_h_ = 0;
  int intermediates_fmt_ = 1;   // TextureFormat code of the pooled textures
  int intermediate_cursor_ = 0;

  // The sketch's working texture format (TextureFormat code: 1 = RGBA8,
  // 3 = RGBA16F), parsed from the sketch's top-level `outputFormat.bitDepth`
  // each execute(). Drives the intermediate pool, the SketchDefault (6)
  // resolution in the backend (gpu_set_default_texture_format), the fused-PSO
  // cache key, and the format-suffixed instance key namespace (a bit-depth
  // change mints FRESH effect instances whose PSOs/textures were created
  // under the new default — old-format instances stay pooled, so toggling
  // back is instant and growth is bounded at 2x).
  int internalFmt_ = 1;
  // Effective instance-key prefix for this frame: keyNamespace_ plus a
  // format suffix when internalFmt_ != RGBA8. Recomputed each execute().
  std::string nsPrefix_;

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

  // This frame's external scalar sources (setExternalScalars), keyed by the
  // out-of-chain instance key ("midi:<uuid>") → endpoint field → value 0..1.
  // Seeds the `external`-tagged float rails at the top of execute().
  std::unordered_map<std::string, std::unordered_map<std::string, float>>
      externalScalars_;

  // Host-injected live scalars for IN-chain instances (setInjectedScalar):
  // instance key → field → value. Read by captureWriteTaps ahead of the doc's
  // instance state so hosts can drive wire sources without doc mutation.
  std::unordered_map<std::string, std::unordered_map<std::string, float>>
      injectedScalars_;

  // Host-injected frame textures (setInjectedTexture): instance key → texture
  // handle, bound as that instance's "0" field each tick. Handles are BORROWED
  // — the pump's frame cache owns them.
  std::unordered_map<std::string, int32_t> injectedTextures_;

  // --- Clean-frame exec-doc cache -----------------------------------------
  // The final execution doc (columns-normalized, wires lowered to taps,
  // modulation auto-connects synthesised, struct rails augmented) rebuilt on
  // DIRTY frames only and reused verbatim while the sketch is clean. The
  // whole product is structural: per-frame values flow via live published
  // state / external / injected scalars, never through this doc. Before this
  // cache the pipeline deep-copied + re-lowered the entire sketch EVERY
  // frame — the dominant per-frame CPU for long chains on both platforms.
  nlohmann::json cachedExecDoc_;
  bool cachedExecDocValid_ = false;

  // Per-(instance, field+wire) modulation DELAY lines (the wire's continuous-time
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

  // Sketch-state epoch: bumped on every dirty frame (and by forceStateReassert /
  // the working-format reset). maybeApplyState stamps each instance with the
  // epoch it last applied state under, and skips only when the stamp is
  // CURRENT — not merely when the frame isn't dirty. The difference matters
  // for entries the enable gate leaves dormant: an effect whose wire-driven
  // `__enable__` was off during the dirty frame never reached maybeApplyState,
  // and the old `if (!sketchDirty) return` skip then left it running schema
  // defaults forever once the wire woke it on a later (non-dirty) frame.
  uint64_t stateEpoch_ = 1;
  std::unordered_map<std::string, uint64_t> lastAppliedEpoch_;

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
    // Sidecar-canvas node (see sketch_canvas.h): runs for its scalars/textures
    // but is OFF the linear image chain — it never advances the column's texture
    // cursor and never fuses.
    bool isCanvas;
  };
  struct PlanColumn {
    // In EXECUTION order (which is chain order unless the sketch stores an
    // override), not chain order. PlanEntry::chainIdx keeps the addressing.
    std::vector<PlanEntry> resolvable;
    // Index into `resolvable` of the last LINEAR entry — the stage that produces
    // the column's final image. npos when the column is all canvas.
    size_t lastLinearK = static_cast<size_t>(-1);
    std::unordered_map<std::string, nlohmann::json> railsById;  // column-local + sketch-wide
  };
  std::vector<PlanColumn> plan_;
  bool planValid_ = false;
  // Structural signature of the sketch the cached plan_ was built from (chain
  // topology + rail defs + bypass/opacity — NOT param values). On a dirty frame
  // the plan is rebuilt only when this changes, so param-only slider/knob drags
  // (which set the coarse value-dirty flag every frame) skip the rebuild.
  std::string planStructSig_;
  // Builds the structural signature compared against planStructSig_. Member
  // (not a free helper) for railsSigCache_: the rails-dump block is the only
  // JSON serialize in the sig and is invariant across a knob drag, so it's
  // cached keyed on structural equality of the rails themselves.
  std::string computeStructSig(const nlohmann::json& columns,
                               const nlohmann::json& instances,
                               const nlohmann::json& sketchRails);
  struct RailsSigCache {
    nlohmann::json src;  // [sketchRails, col0.rails, col1.rails, ...]
    std::string dump;
  };
  RailsSigCache railsSigCache_;
  // Test-only: counts buildPlan() invocations so a unit test can assert that a
  // param-only dirty frame reuses the cached plan while a topology change forces
  // a rebuild. Has no effect on rendering.
  int planBuildCount_ = 0;
  bool fusionEnabled_ = true;   // force-off disables GPU fusion (test hook)
  std::string keyNamespace_;    // prefix into the SHARED instance pool (per-barrel)
  std::string busTag_;          // sidechannel writer identity (see setBusTag)

  // Per-frame debug counters, reset at the top of each execute() and surfaced
  // via fillDebugStats() (see above). `fusedRuns` doubles as the fusion-test
  // signal exposed by fusedRunCount().
  struct DebugStats {
    int effectsExecuted = 0;     // resolvable chain entries processed (all columns)
    int standaloneDispatches = 0;// stages that ran their own render() dispatch
    int fusedRuns = 0;           // fused-kernel dispatches actually issued
    int fusedStages = 0;         // surviving (non-identity) stages folded into fused runs
    int identitySkipped = 0;     // stages skipped via the identity predicate
    int outputBlits = 0;         // final output-format resample/convert passes
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

  // Lazily-created scaled blit servicing util.sidechannel_in stages
  // (host_sidechannel_blit.h).
  std::unique_ptr<SidechannelBlit> sidechannelBlit_;

  // Lazily-created output resample/convert pass for the per-sketch
  // output-format override (host_output_blit.h). Only touched when the
  // override is active.
  std::unique_ptr<OutputBlit> outputBlit_;

  // Format-correct copy of src → dst (a render-pass copy via the wet/dry blend
  // at full opacity). Unlike gpu_copy_texture (a raw byte blit, correct only
  // between matching formats), this respects each texture's channel order — so
  // copying an RGBA8 intermediate into the BGRA8 output interop doesn't swap
  // R/B. Used for final passthrough/identity stages whose result must land in
  // the caller's output texture.
  void copyToOutput(int32_t src, int32_t dst, int W, int H);

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

  // Per-TriggerSource-instance seq watermark for the trigger-ring drain (see
  // drainTriggerRing). Baselined at the ring's max on first sight so a
  // re-entering instance never replays history; mirrors the compositor's
  // triggerSeqSeen_.
  std::unordered_map<std::string, long long> triggerSeqSeen_;

  // Drain a TriggerSource stage's published "triggers" ring (post-tick) onto
  // the process-global trigger_bus: numeric effrt_read_triggers read, seq-dedup
  // against triggerSeqSeen_, emit new events. No-op for non-TriggerSource
  // stages. The shared server (native) drains the bus to launch clips; the
  // editor mirrors it into the Trigger Rails cards.
  void drainTriggerRing(const RegisteredModule* reg, int32_t instHandle,
                        const std::string& instKey);

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

  // Resolve the texture a read-tap wire delivers onto `fieldPath` of this
  // entry: the first texture leaf of the first matching tap's rail, or -1
  // when nothing is wired / the rail carries no texture this frame. Delayed
  // (back-edge) taps read the 1-frame retained copies. Mirrors applyReadTaps'
  // texture-leaf resolution for callers that need a wired texture OUTSIDE the
  // stage's own tap application — the sidechannel send servicing, which
  // publishes before the render path runs.
  // Input texture for a sidecar-canvas stage: its explicitly wired texture
  // input, else the sketch's own input. See the definition for why.
  int32_t canvasStageInput(
      const nlohmann::json& entry,
      const RegisteredModule* reg,
      const std::unordered_map<std::string, nlohmann::json>& railsById,
      const std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railTextures,
      int32_t execInput);

  int32_t wireTextureForField(
      const nlohmann::json& entry,
      const char* fieldPath,
      const std::unordered_map<std::string, nlohmann::json>& railsById,
      const std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railTextures);

  void applyReadTaps(
      int32_t inst,
      const nlohmann::json& entry,
      const std::unordered_map<std::string, nlohmann::json>& railsById,
      const std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railTextures,
      const std::unordered_map<std::string, float>& railFloats,
      // Struct-rail scalar leaves captured live from producers this frame
      // (railId → leafPath → value); a leaf absent here falls back to the
      // producer's schema default.
      const std::unordered_map<std::string,
        std::unordered_map<std::string, float>>& railScalars,
      const std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railBuffers,
      const nlohmann::json& sketchInstances,
      const std::string& instanceKey,
      // When non-null, records each modulated FLOAT field's final post-fold
      // value (the target the smoothing pass ramps toward). See applySmoothing.
      std::unordered_map<std::string, float>* outModulatedScalars = nullptr);

  // Fold ONE float read-tap's rail value into its dest: polarity prescale →
  // tap_mod remap/curve → magnitude/combine fold against [destMin,destMax] →
  // wire delay; records the telemetry band. The ONLY float-wire fold — shared
  // by applyReadTaps (plugin fields) and foldReservedOverrides (engine-reserved
  // `__` keys) so the two paths can never drift.
  float foldFloatReadTap(const nlohmann::json& tap, const std::string& instanceKey,
                         const std::string& fieldPath, float railVal,
                         bool hasCanon, float canon);

  // Engine-reserved per-effect overrides (`__opacity__` / `__enable__`)
  // modulated by wires/automation THIS frame. Reserved keys are consumed by the
  // executor itself (never the plugin): readOpacity/readEnable supply the
  // authored canon; wires fold from it (and stack), automation folds from it
  // only when no wire drove the same key (wire precedence, matching
  // applyAutomation). Folded at the TOP of an entry's standalone processing —
  // BEFORE the enable gate — so a wire can wake a dormant effect. Values
  // re-fold every frame from scratch (no persistent overlay to go stale).
  struct ReservedOverrides {
    std::optional<float> opacity;
    std::optional<float> enable;  // 1 = on; thresholded >= 0.5 by the caller
  };
  ReservedOverrides foldReservedOverrides(
      const nlohmann::json& entry, const nlohmann::json& sketchInstances,
      const std::string& instanceKey,
      const std::unordered_map<std::string, nlohmann::json>& railsById,
      const std::unordered_map<std::string, float>& railFloats);

  // Fold this frame's automation entries (setAutomation) for `instanceKey` into
  // their target fields, via applyMagnitude against each field's schema range —
  // the same math applyReadTaps uses for wires. Run right after applyReadTaps.
  void applyAutomation(int32_t inst, const nlohmann::json& entry,
                       const nlohmann::json& sketchInstances,
                       const std::string& instanceKey,
                       std::unordered_map<std::string, float>* outModulatedScalars);

  // Apply a wire's continuous-time `delay` (seconds) to a modulated field's final
  // post-fold `value`, via a delay line in delayState_ keyed (instance, field+wire)
  // — per WIRE, since several wires may fold into one field and each carries its
  // own delay. The line is fed one sample per frame at modClock_; the return is the value from
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
      // Struct-rail scalar leaves: the producer's LIVE declaration (published
      // state / instance state), captured here so consumers see the values the
      // producer computed this frame — not its schema defaults. Delayed
      // (back-edge) struct taps keep default-only scalars for now.
      std::unordered_map<std::string,
        std::unordered_map<std::string, float>>& railScalars,
      std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railBuffers,
      // Read-tap-modulated scalars from applyReadTaps this frame. A field that
      // is BOTH read-tapped and write-tapped (a "relay" field, e.g. a dashboard
      // knob driven by an LFO) publishes this modulated value instead of its
      // canonical serialized state. nullptr → no relay (publish state as usual).
      const std::unordered_map<std::string, float>* modulatedScalars = nullptr,
      // Identity-skipped stage: the aliased passthrough handle standing in for
      // this stage's `tex_out` (the stage never rendered, so textureField is
      // stale/absent). Only consulted for bare-texture rails on "tex_out".
      int32_t aliasedTexOut = -1);

  void markWriteTapOutputsConnected(
      int32_t inst,
      const nlohmann::json& entry);
};

}  // namespace sketch_executor
