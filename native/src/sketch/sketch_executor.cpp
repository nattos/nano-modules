#include "sketch/sketch_executor.h"

#include "sketch/sketch_augment.h"
#include "sketch/tap_mod.h"
#include "sketch/host_blend.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "runtime/fusion_codegen.h"

#include <memory>
#include <utility>

namespace sketch_executor {

using nlohmann::json;

namespace {

/**
 * Visit each texture-leaf path in a rail's dataType. Texture rails
 * yield a single empty-string leaf; struct rails walk their schema's
 * nested texture fields and yield slash-joined sub-paths. Float and
 * other dataTypes yield nothing — texture flow only.
 */
template <class F>
void forEachRailLeafTexture(const json& dataType, F&& f) {
  if (dataType.is_string()) {
    if (dataType.get<std::string>() == "texture") f(std::string());
    return;
  }
  if (dataType.is_object() &&
      dataType.value("kind", std::string()) == "struct") {
    const auto& schema = dataType.value("schema", json());
    std::vector<std::string> leaves;
    sketch_augment::collectTextureLeaves(schema, "", leaves);
    for (auto& l : leaves) f(l);
  }
}

// --- Tap mod parsing (lock-step with web/src/tap-mod.ts via tap_mod.h) ---

tap_mod::Curve parseCurve(const json& v) {
  if (!v.is_string()) return tap_mod::Curve::Linear;
  const std::string s = v.get<std::string>();
  if (s == "quad")     return tap_mod::Curve::Quad;
  if (s == "circular") return tap_mod::Curve::Circular;
  if (s == "power")    return tap_mod::Curve::Power;
  if (s == "foldback") return tap_mod::Curve::Foldback;
  return tap_mod::Curve::Linear;
}

tap_mod::Combine parseCombine(const json& tap) {
  const json& v = tap.contains("combine") ? tap["combine"] : json();
  if (!v.is_string()) return tap_mod::Combine::Replace;
  const std::string s = v.get<std::string>();
  if (s == "add") return tap_mod::Combine::Add;
  if (s == "mul") return tap_mod::Combine::Mul;
  if (s == "mix") return tap_mod::Combine::Mix;
  return tap_mod::Combine::Replace;
}

// Build a tap_mod::Mod from a tap's optional "mod" object. Absent fields keep
// the struct's pass-through defaults.
tap_mod::Mod parseMod(const json& tap) {
  tap_mod::Mod m;
  if (!tap.contains("mod") || !tap["mod"].is_object()) return m;
  const json& mod = tap["mod"];
  m.scale = mod.value("scale", 1.0f);
  if (mod.contains("remap") && mod["remap"].is_object()) {
    const json& r = mod["remap"];
    m.hasRemap = true;
    m.inMin    = r.value("inMin", 0.0f);
    m.inMax    = r.value("inMax", 1.0f);
    m.outMin   = r.value("outMin", 0.0f);
    m.outMax   = r.value("outMax", 1.0f);
    m.saturate = r.value("saturate", false);
    m.exponent = r.value("exponent", 2.0f);
    m.curveIn  = parseCurve(r.contains("curveIn")  ? r["curveIn"]  : json());
    m.curveOut = parseCurve(r.contains("curveOut") ? r["curveOut"] : json());
  }
  return m;
}

// --- Reserved per-effect engine state keys (device on/off + opacity) ---

// Find an instance's "state" object WITHOUT copying it. `.value("state", {})`
// deep-copies the whole state subtree (incl. multi-KB text fields) on every
// call — at 60fps × per-entry that was a big slice of the JSON churn. These
// return a pointer into `instances` (null if absent / not an object).
const json* findState(const json& instances, const std::string& instKey) {
  if (!instances.is_object()) return nullptr;
  auto iit = instances.find(instKey);
  if (iit == instances.end()) return nullptr;
  auto sit = iit->find("state");
  if (sit == iit->end() || !sit->is_object()) return nullptr;
  return &*sit;
}

bool readBypass(const json& instances, const std::string& instKey) {
  const json* st = findState(instances, instKey);
  if (!st) return false;
  auto it = st->find("__bypass__");
  if (it == st->end()) return false;
  if (it->is_boolean()) return it->get<bool>();
  if (it->is_number())  return it->get<double>() != 0.0;
  return false;
}

float readOpacity(const json& instances, const std::string& instKey) {
  const json* st = findState(instances, instKey);
  if (!st) return 1.0f;
  auto it = st->find("__opacity__");
  if (it == st->end() || !it->is_number()) return 1.0f;
  return (float)it->get<double>();
}

// Shared empty fallbacks + a no-copy subtree accessor. `value(key, default)`
// deep-copies the matched subtree (and constructs the default container as a
// temporary every call); refOr returns a reference instead.
const json kEmptyArr = json::array();
const json kEmptyObj = json::object();
const json& refOr(const json& parent, const char* key, const json& fallback,
                  bool wantArray) {
  auto it = parent.find(key);
  if (it == parent.end()) return fallback;
  if (wantArray ? !it->is_array() : !it->is_object()) return fallback;
  return *it;
}

}  // namespace

SketchExecutor::SketchExecutor(effect_runtime::EffectRuntime* rt,
                               ModuleRegistry* registry,
                               gpu::GPUBackend* gpu)
  : rt_(rt), registry_(registry), gpu_(gpu) {}

SketchExecutor::~SketchExecutor() {
  for (int32_t h : intermediates_) {
    if (h > 0 && gpu_) gpu_->release(h);
  }
  for (auto& [_, pso] : fusedPSOs_) {
    if (pso > 0 && gpu_) gpu_->release(pso);
  }
  for (int32_t sm : fusedShaderModules_) {
    if (sm > 0 && gpu_) gpu_->release(sm);
  }
}

void SketchExecutor::buildPlan(const json& columns, const json& instances,
                               const json& sketchRails) {
  plan_.clear();
  plan_.resize(columns.size());
  for (size_t colIdx = 0; colIdx < columns.size(); ++colIdx) {
    PlanColumn& pc = plan_[colIdx];
    const json& col = columns[colIdx];
    // Rail-by-id index: column-local then sketch-wide (sketch wins on id clash,
    // matching the former per-frame build order).
    auto indexRails = [&](const json& rails) {
      if (!rails.is_array()) return;
      for (const auto& r : rails) {
        if (!r.is_object()) continue;
        std::string id = r.value("id", std::string());
        if (!id.empty()) pc.railsById[id] = r;
      }
    };
    indexRails(refOr(col, "rails", kEmptyArr, true));
    indexRails(sketchRails);

    const json& chain = refOr(col, "chain", kEmptyArr, true);
    for (size_t i = 0; i < chain.size(); ++i) {
      const auto& entry = chain[i];
      std::string mt = entry.value("module_type", std::string());
      const RegisteredModule* reg = registry_->find(mt);
      if (!reg) continue;  // unknown module_type → silent passthrough
      std::string instKey = entry.value("instance_key", std::string());
      // Fusion eligibility — structural (fusion kind/fragment/prepare, tap-free)
      // plus bypass/opacity, which are sketch state and thus only change on a
      // dirty frame. instanceFor materialises the per-key instance here.
      auto* inst = rt_ ? rt_->instanceFor(mt, instKey) : nullptr;
      bool e = false;
      if (inst) {
        const auto& fi = inst->fusionInfo();
        e = (fi.kind == 1) && !fi.fragmentName.empty() && fi.hasPrepare();
        if (e && entry.contains("taps") && entry["taps"].is_array() &&
            !entry["taps"].empty()) {
          e = false;
        }
        if (e && (readBypass(instances, instKey) ||
                  readOpacity(instances, instKey) != 1.0f)) {
          e = false;
        }
      }
      if (!fusionEnabled_) e = false;   // force-off (test hook)
      pc.resolvable.push_back({i, std::move(mt), std::move(instKey), reg, e});
    }
  }
}

int32_t SketchExecutor::execute(
    const json& rawSketch,
    int32_t inputHandle, int32_t outputHandle,
    int W, int H, double dt, bool sketchDirty) {
  if (!rawSketch.is_object() || !registry_ || !gpu_) return inputHandle;

  // Augment with implicit struct-rail connections. Schemas are
  // immutable after the host's one-shot registerEffect calls, so build
  // the map once and reuse.
  if (!cachedSchemasValid_) {
    cachedSchemas_ = registry_->schemas();
    cachedSchemasValid_ = true;
  }
  // The augmenter deep-clones the whole sketch. For chains with only
  // texture-typed I/O (eg N×brightness_contrast) the augmenter is a
  // no-op anyway, so skip the clone entirely in that case. Detected
  // by `sketchNeedsAugmentation` walking the chain in O(N) and
  // checking whether any module's schema has a structured field.
  json augmentedStorage;
  const json* sketchPtr = &rawSketch;
  if (sketch_augment::sketchNeedsAugmentation(rawSketch, cachedSchemas_)) {
    augmentedStorage = sketch_augment::augmentSketchWithImplicitConnections(
        rawSketch, cachedSchemas_);
    sketchPtr = &augmentedStorage;
  }
  const json& sketch = *sketchPtr;

  const json& columns      = refOr(sketch, "columns",   kEmptyArr, true);
  if (columns.empty()) return inputHandle;
  const json& instances    = refOr(sketch, "instances", kEmptyObj, false);
  const json& sketchRails  = refOr(sketch, "rails",     kEmptyArr, true);

  // Compile-once: rebuild the structural plan only when the host says the sketch
  // changed (or first run). In standalone / steady state nothing edits the
  // sketch, so every frame after the first reuses the cached plan — no per-frame
  // chain filtering, eligibility probing, registry lookups, rail indexing, or
  // module_type/instance_key string churn. See buildPlan + the PlanColumn cache.
  if (sketchDirty || !planValid_) {
    buildPlan(columns, instances, sketchRails);
    planValid_ = true;
  }

  intermediate_cursor_ = 0;
  int32_t finalHandle = inputHandle;
  bool anyDispatched = false;
  fusedRunCount_ = 0;           // counted in runFusedGroup; read by tests
  railState_ = json::object();  // rebuilt per frame; published by the host

  // Coalesce the whole frame's stages into ONE command buffer. Every effect's
  // render() ends in gpu::submit() (commit + waitUntilCompleted) — left alone,
  // an N-stage chain blocks the CPU on GPU completion N times per frame, the
  // dominant cost for non-fusable chains (a 16-stage chain measured ~12 ms/frame
  // wall, almost all of it parked in waitUntilCompleted). beginSubmitBatch makes
  // those per-stage submits defer; endSubmitBatch commits + waits once. The
  // chain-entry capture hooks only RECORD texture handles (readback is deferred
  // to after execute()), so monitored intermediates stay correct.
  gpu_->beginSubmitBatch();

  for (size_t colIdx = 0; colIdx < columns.size(); ++colIdx) {
    // Cached structural plan for this column (resolvable entries + rail index).
    const PlanColumn& pc = plan_[colIdx];
    const std::vector<PlanEntry>& R = pc.resolvable;
    if (R.empty()) continue;
    const auto& col = columns[colIdx];
    const json& chain = refOr(col, "chain", kEmptyArr, true);
    const std::unordered_map<std::string, json>& railsById = pc.railsById;

    // Per-column rail VALUE tables (rebuilt per frame — these change every
    // frame). Texture handles keyed by leafPath (empty string for single-
    // texture rails); float scalars keyed by railId.
    std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>> railTextures;
    std::unordered_map<std::string, float> railFloats;

    int32_t colInput = inputHandle;
    const bool isLastCol = (colIdx == columns.size() - 1);

    // ----- Plan groups ---------------------------------------------
    // Each group is a run of consecutive chain entries (indices into
    // resolvable[]) processed together. A group is "fused" iff every
    // entry in it is fusion-eligible AND it has 2+ entries. The
    // barrier predicate forces the host's requested chain-entry
    // outputs into real intermediate textures by splitting the
    // would-be fused group there.
    struct Group { size_t firstK; size_t lastK; bool fused; };
    std::vector<Group> groups;
    {
      // Metal's compute-stage [[buffer(N)]] indices cap at 30. We bind
      // one uniform per fused stage starting at slot 2, so the group
      // size cap is 28. Beyond that, the planner just starts a new
      // group; no observable behavior change.
      static constexpr size_t kMaxFusionStages = 28;
      // Eligibility is cached in the plan (structural + bypass/opacity, all
      // dirty-gated). Only the barrier predicate is re-evaluated per frame — the
      // host flips it as preview-monitor subscriptions change, independent of any
      // sketch edit — and group splitting is re-derived from both.
      std::vector<char> eligibleK(R.size(), 0);
      std::vector<char> isBarrier(R.size(), 0);
      for (size_t k = 0; k < R.size(); ++k) {
        eligibleK[k] = R[k].eligible ? 1 : 0;
        isBarrier[k] = (barrierPredicate_
                        && barrierPredicate_((int)colIdx,
                                              (int)R[k].chainIdx)) ? 1 : 0;
      }
      size_t start = 0;
      while (start < R.size()) {
        if (!eligibleK[start]) {
          groups.push_back({start, start, false});
          ++start; continue;
        }
        size_t end = start;
        // Extend while the next entry is also eligible AND the current
        // entry isn't a barrier (a barrier forces its output into a
        // real texture, ending the group).
        while (end + 1 < R.size()
               && !isBarrier[end]
               && eligibleK[end + 1]
               && (end + 1 - start + 1) <= kMaxFusionStages) {
          ++end;
        }
        groups.push_back({start, end, end > start});
        start = end + 1;
      }
    }

    // ----- Helpers --------------------------------------------------
    // Apply the persisted instance state. Two layers of work-skipping:
    //   1. Whole-state fast path — if nothing changed since last frame,
    //      skip entirely (the common case at steady state).
    //   2. Per-field diff — when something DID change, only fire patches
    //      for the fields that actually changed vs. the last applied
    //      state. A single moving slider then fires one setParam* instead
    //      of re-patching every field (each patch is a firePatched →
    //      on_state_patched → val_blobs + json::dump cascade).
    // Each chain entry has its own EffectInstance, so the cache keys purely
    // on instance_key — no cross-instance file-static aliasing to guard.
    auto maybeApplyState = [&](effect_runtime::EffectInstance* inst,
                               const std::string& instKey,
                               const json& state) {
      // Persisted params only change when the sketch is edited. When the host
      // tells us it didn't change, skip the per-instance whole-state compare
      // (multi-KB for rich text) entirely — they were applied on the last dirty
      // frame and read taps re-drive any modulated params separately below.
      if (!sketchDirty) return;
      auto& cachedState = lastAppliedState_[instKey];
      if (cachedState == state) return;
      applyState(inst, cachedState, state);
      cachedState = state;
    };

    auto runStandalone = [&](size_t k, bool isLastGroupInCol) {
      const PlanEntry& pe = R[k];
      size_t i = pe.chainIdx;
      const auto& entry = chain[i];
      const std::string& mt      = pe.moduleType;
      const std::string& instKey = pe.instanceKey;

      const RegisteredModule* reg = pe.reg;
      auto* inst = rt_ ? rt_->instanceFor(mt, instKey) : nullptr;
      if (!inst) return;

      // For a passthrough stage that is the column's FINAL output, the result
      // must land in `outputHandle` (the caller's bound output texture) — the
      // barrel blits that texture, not an arbitrary intermediate. Mid-chain
      // passthroughs just alias colInput (the next stage reads it directly).
      const bool isFinalStage = isLastCol && isLastGroupInCol;
      auto passthroughOutput = [&](int32_t src) -> int32_t {
        // No real input (e.g. a bypassed generator with nothing above): emit a
        // clean cleared frame so the next stage / column output isn't a stale
        // pooled texture.
        if (src < 0 && gpu_) {
          src = nextIntermediate(W, H);
          gpu_->clearTexture(src, 0.0f, 0.0f, 0.0f, 0.0f);
        }
        if (isFinalStage && src != outputHandle && gpu_) {
          gpu_->copyTexture(src, outputHandle);
          return outputHandle;
        }
        return src;
      };

      // -- Device on/off ("bypass"): when off, fire the on_active transition
      // then go fully dormant — no state, no taps, no tick/render — and alias
      // the column input straight through as this stage's output. --
      const bool bypass = readBypass(instances, instKey);
      inst->doSetActive(!bypass);
      if (bypass) {
        int32_t out = passthroughOutput(colInput);
        if (chainEntryHook_) {
          chainEntryHook_((int)colIdx, (int)i, colInput, out, W, H);
        }
        finalHandle = out;
        colInput = out;   // next stage reads the passthrough result
        return;
      }

      // -- Zero stale per-field state from the previous frame --
      for (const auto& path : reg->inputTexturePaths) {
        inst->setTextureField(path, 0);
        inst->setFieldConnected(path, false, false);
      }
      for (const auto& path : reg->outputTexturePaths) {
        inst->setFieldConnected(path, false, false);
      }

      // -- Apply persisted instance state from the sketch (no-copy lookup) --
      if (const json* st = findState(instances, instKey)) {
        maybeApplyState(inst, instKey, *st);
      }

      // -- Identity skip: stateless passthrough → alias input as this
      // stage's output, no dispatch, no intermediate consumed. Gated on
      // tap-free entries: read taps can drive params from rails (which
      // changes identity, and is applied below — after this point) and
      // write taps publish this stage's output texture; the alias path
      // handles neither. Tap-bearing entries are also never fusion-
      // eligible, so this mirrors the fused path's contract. Checked
      // after applyState so the predicate sees current params. --
      const bool hasTaps = entry.contains("taps") && entry["taps"].is_array()
                           && !entry["taps"].empty();
      if (!hasTaps && inst->isIdentity()) {
        int32_t out = passthroughOutput(colInput);
        if (chainEntryHook_) {
          chainEntryHook_((int)colIdx, (int)i, colInput, out, W, H);
        }
        finalHandle = out;
        colInput = out;   // next stage reads the passthrough result
        return;
      }

      // -- Opacity (Resolume-style wet/dry) --
      // 0   → skip render (alias input through), but tick() still runs so the
      //       sim advances; the effect sees state::willRender()==false.
      // 1   → normal full-strength render.
      // 0<o<1 → render into a scratch texture, then host-blend it with the
      //       column input: out = mix(colInput, fx, opacity).
      const float opacity = readOpacity(instances, instKey);
      const bool willRender = opacity > 0.0f;
      inst->setWillRender(willRender);

      if (!willRender) {
        inst->setTextureField("tex_in", colInput);
        inst->setFieldConnected("tex_in", true, false);
        applyReadTaps(inst, entry, railsById, railTextures, railFloats, instances, instKey);
        markWriteTapOutputsConnected(inst, entry);
        inst->doTick(dt);
        captureWriteTaps(inst, entry, instKey, instances,
                         railsById, railTextures, railFloats);
        int32_t out = passthroughOutput(colInput);
        if (chainEntryHook_) {
          chainEntryHook_((int)colIdx, (int)i, colInput, out, W, H);
        }
        finalHandle = out;
        colInput = out;   // next stage reads the passthrough result
        return;
      }

      int32_t outHandle = isFinalStage ? outputHandle : nextIntermediate(W, H);
      // Partial opacity renders to a scratch texture first, then blends.
      const bool partial = opacity < 1.0f;
      int32_t fxHandle = partial ? nextIntermediate(W, H) : outHandle;

      // -- Wire primary channels --
      inst->setTextureField("tex_in",  colInput);
      inst->setTextureField("tex_out", fxHandle);
      inst->setFieldConnected("tex_in",  true,  false);
      inst->setFieldConnected("tex_out", false, true);

      applyReadTaps(inst, entry, railsById, railTextures, railFloats, instances, instKey);
      markWriteTapOutputsConnected(inst, entry);

      inst->doTick(dt);
      inst->doRender(W, H);

      captureWriteTaps(inst, entry, instKey, instances,
                       railsById, railTextures, railFloats);

      if (partial) {
        if (!blend_) blend_ = std::make_unique<WetDryBlend>();
        if (!blend_->encode(gpu_, colInput, fxHandle, outHandle, opacity, W, H)) {
          // Couldn't build the blend pass — show the effect at full strength
          // rather than nothing.
          if (gpu_) gpu_->copyTexture(fxHandle, outHandle);
        }
      }

      if (chainEntryHook_) {
        chainEntryHook_((int)colIdx, (int)i, colInput, outHandle, W, H);
      }

      anyDispatched = true;
      finalHandle = outHandle;
      colInput = outHandle;
    };

    auto runFusedGroup = [&](const Group& g, bool isLastGroupInCol) {
      // Resolve every stage's instance and apply its state + tick FIRST,
      // so the identity predicate below sees current params.
      std::vector<effect_runtime::EffectInstance*> allStages;
      allStages.reserve(g.lastK - g.firstK + 1);
      bool stagesOK = true;
      for (size_t k = g.firstK; k <= g.lastK; ++k) {
        const std::string& instKey = R[k].instanceKey;
        auto* inst = rt_ ? rt_->instanceFor(R[k].moduleType, instKey) : nullptr;
        if (!inst) { stagesOK = false; break; }
        if (const json* st = findState(instances, instKey)) {
          maybeApplyState(inst, instKey, *st);
        }
        inst->doTick(dt);
        allStages.push_back(inst);
      }
      if (!stagesOK) {
        for (size_t k = g.firstK; k <= g.lastK; ++k) {
          bool last = (k == g.lastK) && isLastGroupInCol;
          runStandalone(k, last);
        }
        return;
      }

      // Drop identity stages: a passthrough mapper f(x)=x contributes
      // nothing to the fused composition, so exclude it from the codegen
      // + dispatch entirely. The surviving chain is mathematically
      // identical (point-op composition). If EVERY stage is identity the
      // group is a pure no-op → alias group input as output (no GPU work).
      std::string cacheKey;
      std::vector<std::string> fragments;
      std::vector<effect_runtime::EffectInstance*> stages;
      bool fragsOK = true;
      for (size_t idx = 0; idx < allStages.size(); ++idx) {
        auto* inst = allStages[idx];
        if (inst->isIdentity()) continue;
        if (!cacheKey.empty()) cacheKey += '|';
        cacheKey += R[g.firstK + idx].moduleType;
        stages.push_back(inst);
        // Resolve the fragment by a STABLE per-effect key first
        // ("<module_type>::<name>"), falling back to the bare name. The bare
        // names ("pixel") are shared across all effects and overwritten at
        // registration, so a bare lookup here (render time) would return some
        // OTHER effect's fragment — the cause of the fused kernel failing to
        // compile. See gen_barrel_effects.py's qualified registerShaderMSL alias.
        const std::string& fragName = inst->fusionInfo().fragmentName;
        std::string msl;
        if (!rt_->lookupMSL(R[g.firstK + idx].moduleType + "::" + fragName, &msl)
            && !rt_->lookupMSL(fragName, &msl)) {
          fragsOK = false; break;
        }
        fragments.push_back(std::move(msl));
      }

      const bool isFinalStage = isLastCol && isLastGroupInCol;
      const int32_t groupInput = colInput;

      // Whole group is identity → passthrough.
      if (fragsOK && stages.empty()) {
        if (chainEntryHook_) {
          chainEntryHook_((int)colIdx, (int)R[g.firstK].chainIdx,
                          groupInput, groupInput, W, H);
          if (g.lastK != g.firstK) {
            chainEntryHook_((int)colIdx, (int)R[g.lastK].chainIdx,
                            groupInput, groupInput, W, H);
          }
        }
        finalHandle = groupInput;   // alias; colInput unchanged
        return;
      }

      int32_t pso = -1;
      if (fragsOK) {
        auto it = fusedPSOs_.find(cacheKey);
        if (it != fusedPSOs_.end()) {
          pso = it->second;   // may be -1: a previously-failed compile (cached!)
        } else {
          std::string src = fusion_codegen::generateFusedMSL(fragments);
          if (!src.empty()) {
            int32_t sm = gpu_->createShaderModule(src);
            if (sm > 0) {
              fusedShaderModules_.push_back(sm);
              pso = gpu_->createComputePSO(sm, "fused_main");
            }
          }
          // Cache the result for this group shape — SUCCESS *or* FAILURE. A
          // failed fused codegen/compile is deterministic for a given cacheKey,
          // so caching -1 makes us fall back to the per-stage path exactly once
          // instead of re-running the (blocking, ~tens-of-ms) Metal shader
          // compile every single frame. This was the dominant cost for any
          // chain of 2+ fusion-eligible effects.
          fusedPSOs_[cacheKey] = pso;
        }
      }
      if (pso <= 0) {
        // Codegen / compile failed — fall back to per-entry path for
        // every stage in this group so we at least produce output.
        for (size_t k = g.firstK; k <= g.lastK; ++k) {
          bool last = (k == g.lastK) && isLastGroupInCol;
          runStandalone(k, last);
        }
        return;
      }

      // Per-stage prep — only the surviving (non-identity) stages. Each
      // has its own uniform buffer (created in its create()/init()), so
      // doPrepare writes a distinct buffer per stage; we bind those
      // directly to the fused dispatch below.
      for (auto* inst : stages) inst->doPrepare(W, H);

      const int32_t groupOutput = isFinalStage
                                  ? outputHandle
                                  : nextIntermediate(W, H);

      int32_t pass = gpu_->beginComputePass();
      gpu_->computeSetPSO(pass, pso);
      gpu_->computeSetTexture(pass, groupInput,  0, /*read */ 0);
      gpu_->computeSetTexture(pass, groupOutput, 1, /*write*/ 1);
      for (size_t idx = 0; idx < stages.size(); ++idx) {
        // Each stage binds its own per-instance uniform buffer.
        int32_t ub = stages[idx]->fusionInfo().uniformBufferHandle;
        gpu_->computeSetBuffer(pass, ub, 0, (int32_t)(2 + idx));
      }
      gpu_->computeDispatch(pass,
                            ((uint32_t)W + 7) / 8,
                            ((uint32_t)H + 7) / 8, 1);
      gpu_->endComputePass(pass);

      // Hook firing for fused groups: only the LAST stage's output is
      // materialised, so we only fire its hook with output =
      // groupOutput. We also fire the FIRST stage's hook with
      // input = groupInput (the upstream's real texture) so that
      // `ce:<col>/<first>/input` previews land. Middle stages don't
      // have real textures — they're computed in-register inside the
      // fused kernel — and intentionally skip the hook. Hosts that
      // need a middle-stage preview should provoke a barrier via the
      // BarrierPredicate, which will split the group there.
      if (chainEntryHook_) {
        chainEntryHook_((int)colIdx, (int)R[g.firstK].chainIdx,
                        groupInput, /*output=*/-1, W, H);
        if (g.lastK != g.firstK) {
          chainEntryHook_((int)colIdx, (int)R[g.lastK].chainIdx,
                          /*input=*/-1, groupOutput, W, H);
        }
      }

      anyDispatched = true;
      ++fusedRunCount_;          // a real fused-kernel dispatch (not a fallback)
      finalHandle = groupOutput;
      colInput = groupOutput;
    };

    for (size_t gi = 0; gi < groups.size(); ++gi) {
      const Group& g = groups[gi];
      const bool isLastGroupInCol = (gi == groups.size() - 1);
      if (g.fused) {
        runFusedGroup(g, isLastGroupInCol);
      } else {
        // size 1 — non-eligible or single-eligible (no fusion savings)
        runStandalone(g.firstK, isLastGroupInCol);
      }
    }

    // Snapshot this column's float-rail values for editor telemetry. The host
    // (barrel plugin) publishes lastRailState() so the web's rail spark charts
    // can display live values — the native mirror of the web executor's
    // /sketch_state publish (railValuesToJson). Keyed "columns/<col>" to match
    // the web shape: sketchState[id]["columns/<col>"][railId].value.
    if (!railFloats.empty()) {
      json colRails = json::object();
      for (const auto& [railId, v] : railFloats) {
        colRails[railId] = json{{"value", (double)v}};
      }
      railState_["columns/" + std::to_string(colIdx)] = std::move(colRails);
    }
  }

  // Flush the batched frame: commit + wait once. All GPU work (including any
  // monitored intermediate textures) is complete when this returns, so the
  // host's downstream consumers — the output-hook readback below and the FFGL
  // interop blit — see finished pixels exactly as they did under per-stage waits.
  gpu_->endSubmitBatch();

  if (anyDispatched && sketchOutputHook_) {
    sketchOutputHook_(finalHandle, W, H);
  }
  return anyDispatched ? finalHandle : inputHandle;
}

int32_t SketchExecutor::nextIntermediate(int W, int H) {
  if (W != intermediates_w_ || H != intermediates_h_) {
    for (int32_t h : intermediates_) { if (h > 0 && gpu_) gpu_->release(h); }
    intermediates_.clear();
    intermediates_w_ = W; intermediates_h_ = H;
  }
  if (intermediate_cursor_ >= (int)intermediates_.size()) {
    // RGBA8 (format code 1) matches what every effect's compute
    // dispatch is writing today.
    int32_t h = gpu_->createTexture((uint32_t)W, (uint32_t)H, 1);
    intermediates_.push_back(h);
  }
  return intermediates_[intermediate_cursor_++];
}

void SketchExecutor::applyState(
    effect_runtime::EffectInstance* inst,
    const json& prevState,
    const json& state) {
  if (!state.is_object()) return;
  const bool havePrev = prevState.is_object();
  for (auto it = state.begin(); it != state.end(); ++it) {
    const auto& v = it.value();
    const std::string& name = it.key();
    // Reserved engine keys (e.g. __bypass__, __opacity__) are handled by the
    // executor itself — never delivered to the effect as params.
    if (name.size() >= 2 && name[0] == '_' && name[1] == '_') continue;
    // Per-field skip: only patch fields whose value differs from the last
    // applied state. Fields removed from `state` are intentionally left at
    // their last-applied value (the runtime has no "unset param").
    if (havePrev) {
      auto pit = prevState.find(name);
      if (pit != prevState.end() && *pit == v) continue;
    }
    if (v.is_number()) {
      inst->setParamFloat(name, (float)v.get<double>());
    } else if (v.is_boolean()) {
      inst->setParamFloat(name, v.get<bool>() ? 1.0f : 0.0f);
    } else if (v.is_array()) {
      std::vector<float> comps;
      for (const auto& x : v) {
        if (x.is_number()) comps.push_back((float)x.get<double>());
      }
      if (!comps.empty()) inst->setParamArray(name, comps);
    } else if (v.is_string()) {
      // dump() emits a properly-escaped JSON string literal. Naive quoting
      // ("\"" + s + "\"") produces invalid JSON the moment the value contains
      // a quote/backslash/newline — e.g. rich-text HTML (<h1 style="…">) — and
      // setParamJson then parses it as null (renders the literal "null").
      inst->setParamJson(name, v.dump());
    }
  }
}

void SketchExecutor::applyReadTaps(
    effect_runtime::EffectInstance* inst,
    const json& entry,
    const std::unordered_map<std::string, json>& railsById,
    const std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>>& railTextures,
    const std::unordered_map<std::string, float>& railFloats,
    const json& sketchInstances,
    const std::string& instanceKey) {
  if (!entry.contains("taps") || !entry["taps"].is_array()) return;
  // The reader's canonical (user-set, serialized) state — the "before
  // modulation" value a non-replace mix mode modulates from. Read from the
  // serialized JSON (NOT the plugin's runtime), so add/mul don't compound
  // frame-over-frame (applyState is cached, but this stays stable).
  const json* canonState = nullptr;
  if (sketchInstances.is_object()) {
    auto iit = sketchInstances.find(instanceKey);
    if (iit != sketchInstances.end() && iit->is_object()) {
      auto sit = iit->find("state");
      if (sit != iit->end() && sit->is_object()) canonState = &(*sit);
    }
  }
  for (const auto& tap : entry["taps"]) {
    if (tap.value("direction", std::string()) != "read") continue;
    const std::string railId    = tap.value("railId", std::string());
    const std::string fieldPath = tap.value("fieldPath", std::string());
    auto railIt = railsById.find(railId);
    if (railIt == railsById.end()) continue;
    const auto& dataType = railIt->second.value("dataType", json());

    if (dataType.is_string() && dataType.get<std::string>() == "float") {
      auto fit = railFloats.find(railId);
      if (fit != railFloats.end()) {
        // Apply the tap's range remapper (after read), then mix into the user's
        // canonical value per the mix mode (replace ignores it; add/mul/mix
        // modulate from it).
        float shaped = tap_mod::applyTapMod(fit->second, parseMod(tap));
        bool hasCanon = false;
        float canon = 0.0f;
        if (canonState && canonState->contains(fieldPath)) {
          const auto& cv = (*canonState)[fieldPath];
          if (cv.is_number())       { canon = (float)cv.get<double>(); hasCanon = true; }
          else if (cv.is_boolean()) { canon = cv.get<bool>() ? 1.0f : 0.0f; hasCanon = true; }
        }
        float combined = tap_mod::combineTap(hasCanon, canon, shaped,
            parseCombine(tap), tap.value("mixFactor", 1.0f));
        inst->setParamFloat(fieldPath, combined);
        inst->setFieldConnected(fieldPath, true, false);
      }
      continue;
    }

    auto texIt = railTextures.find(railId);
    if (texIt == railTextures.end()) continue;
    forEachRailLeafTexture(dataType, [&](const std::string& leaf) {
      auto lit = texIt->second.find(leaf);
      if (lit == texIt->second.end() || lit->second <= 0) return;
      const std::string target = leaf.empty() ? fieldPath
                                              : (fieldPath + "/" + leaf);
      inst->setTextureField(target, lit->second);
    });
    inst->setFieldConnected(fieldPath, true, false);
  }
}

void SketchExecutor::captureWriteTaps(
    effect_runtime::EffectInstance* inst,
    const json& entry,
    const std::string& producerInstanceKey,
    const json& sketchInstances,
    const std::unordered_map<std::string, json>& railsById,
    std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>>& railTextures,
    std::unordered_map<std::string, float>& railFloats) {
  if (!entry.contains("taps") || !entry["taps"].is_array()) return;
  for (const auto& tap : entry["taps"]) {
    if (tap.value("direction", std::string()) != "write") continue;
    const std::string railId    = tap.value("railId", std::string());
    const std::string fieldPath = tap.value("fieldPath", std::string());
    auto railIt = railsById.find(railId);
    if (railIt == railsById.end()) continue;
    const auto& dataType = railIt->second.value("dataType", json());

    if (dataType.is_string() && dataType.get<std::string>() == "float") {
      // Producer's current scalar lives in the sketch's instance
      // state — the editor mirrors it there each frame. The runtime
      // doesn't expose a getParamFloat, so we read the canonical
      // source rather than the in-runtime mirror.
      if (sketchInstances.is_object() &&
          sketchInstances.contains(producerInstanceKey)) {
        const auto& st = sketchInstances[producerInstanceKey]
                            .value("state", json::object());
        if (st.is_object() && st.contains(fieldPath)) {
          const auto& v = st[fieldPath];
          bool hasScalar = false;
          float raw = 0.0f;
          if (v.is_number())       { raw = (float)v.get<double>(); hasScalar = true; }
          else if (v.is_boolean()) { raw = v.get<bool>() ? 1.0f : 0.0f; hasScalar = true; }
          if (hasScalar) {
            // Apply the range remapper (before write), then fold into the rail's
            // current frame value per the combine mode. The first writer this
            // frame (railFloats has no entry yet) just seeds.
            float shaped = tap_mod::applyTapMod(raw, parseMod(tap));
            auto existing = railFloats.find(railId);
            railFloats[railId] = tap_mod::combineTap(
                existing != railFloats.end(),
                existing != railFloats.end() ? existing->second : 0.0f,
                shaped, parseCombine(tap), tap.value("mixFactor", 1.0f));
            inst->setFieldConnected(fieldPath, false, true);
          }
        }
      }
      continue;
    }

    auto& texMap = railTextures[railId];
    forEachRailLeafTexture(dataType, [&](const std::string& leaf) {
      const std::string source = leaf.empty() ? fieldPath
                                              : (fieldPath + "/" + leaf);
      int32_t h = inst->textureField(source);
      if (h > 0) texMap[leaf] = h;
    });
  }
}

void SketchExecutor::markWriteTapOutputsConnected(
    effect_runtime::EffectInstance* inst,
    const json& entry) {
  if (!entry.contains("taps") || !entry["taps"].is_array()) return;
  for (const auto& tap : entry["taps"]) {
    if (tap.value("direction", std::string()) != "write") continue;
    const std::string fieldPath = tap.value("fieldPath", std::string());
    inst->setFieldConnected(fieldPath, false, true);
  }
}

}  // namespace sketch_executor
