#include "sketch/sketch_executor.h"

#include "sketch/sketch_augment.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "runtime/fusion_codegen.h"

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

int32_t SketchExecutor::execute(
    const json& rawSketch,
    int32_t inputHandle, int32_t outputHandle,
    int W, int H, double dt) {
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

  // Avoid value()-returned copies of large sub-objects. `value(key,
  // default)` deep-copies the matched subtree (and constructs the
  // default container as a temporary every call) — at 60 fps × per-
  // column × per-entry that adds up to a sizeable chunk of the
  // remaining JSON copy/destroy time on the profile.
  static const json EMPTY_ARR = json::array();
  static const json EMPTY_OBJ = json::object();
  auto refOr = [](const json& parent, const char* key, const json& fallback,
                  bool wantArray) -> const json& {
    auto it = parent.find(key);
    if (it == parent.end()) return fallback;
    if (wantArray  ? !it->is_array()  : !it->is_object()) return fallback;
    return *it;
  };
  const json& columns      = refOr(sketch, "columns",   EMPTY_ARR, true);
  if (columns.empty()) return inputHandle;
  const json& instances    = refOr(sketch, "instances", EMPTY_OBJ, false);
  const json& sketchRails  = refOr(sketch, "rails",     EMPTY_ARR, true);

  intermediate_cursor_ = 0;
  int32_t finalHandle = inputHandle;
  bool anyDispatched = false;

  for (size_t colIdx = 0; colIdx < columns.size(); ++colIdx) {
    const auto& col = columns[colIdx];
    const json& chain = refOr(col, "chain", EMPTY_ARR, true);
    if (chain.empty()) continue;

    // Build per-column rail-by-id index (column-local + sketch-wide).
    std::unordered_map<std::string, json> railsById;
    auto indexRails = [&](const json& rails) {
      if (!rails.is_array()) return;
      for (const auto& r : rails) {
        if (!r.is_object()) continue;
        std::string id = r.value("id", std::string());
        if (!id.empty()) railsById[id] = r;
      }
    };
    indexRails(refOr(col, "rails", EMPTY_ARR, true));
    indexRails(sketchRails);

    // Per-column rail value tables. Texture handles keyed by leafPath
    // (empty string for single-texture rails); float scalars keyed by
    // railId.
    std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>> railTextures;
    std::unordered_map<std::string, float> railFloats;

    int32_t colInput = inputHandle;

    // Filter the chain to entries we have a registered effect for.
    // Unknown module_types are skipped silently (passthrough).
    std::vector<size_t> resolvable;
    for (size_t i = 0; i < chain.size(); ++i) {
      const auto& entry = chain[i];
      std::string mt = entry.value("module_type", std::string());
      if (registry_->find(mt) != nullptr) resolvable.push_back(i);
    }
    if (resolvable.empty()) continue;

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
      std::vector<char> eligibleK(resolvable.size(), 0);
      std::vector<char> isBarrier(resolvable.size(), 0);
      for (size_t k = 0; k < resolvable.size(); ++k) {
        const auto& entry = chain[resolvable[k]];
        const std::string mt = entry.value("module_type", std::string());
        const std::string instKey = entry.value("instance_key", std::string());
        // Lazily materialise the per-key instance so we can read its
        // fusion info (registered in its init() with its own uniform
        // buffer). Fusion kind/fragment are identical across instances
        // of a type; the per-instance uniform buffer differs.
        auto* inst = rt_ ? rt_->instanceFor(mt, instKey) : nullptr;
        bool e = false;
        if (inst) {
          const auto& fi = inst->fusionInfo();
          // FusionKind::PerPixelMapper == 1 in state::FusionKind.
          e = (fi.kind == 1) && !fi.fragmentName.empty() && fi.prepare;
          if (e && entry.contains("taps") && entry["taps"].is_array() &&
              !entry["taps"].empty()) {
            e = false;
          }
        }
        eligibleK[k] = e ? 1 : 0;
        isBarrier[k] = (barrierPredicate_
                        && barrierPredicate_((int)colIdx,
                                              (int)resolvable[k])) ? 1 : 0;
      }
      size_t start = 0;
      while (start < resolvable.size()) {
        if (!eligibleK[start]) {
          groups.push_back({start, start, false});
          ++start; continue;
        }
        size_t end = start;
        // Extend while the next entry is also eligible AND the current
        // entry isn't a barrier (a barrier forces its output into a
        // real texture, ending the group).
        while (end + 1 < resolvable.size()
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
      auto& cachedState = lastAppliedState_[instKey];
      if (cachedState == state) return;
      applyState(inst, cachedState, state);
      cachedState = state;
    };

    auto runStandalone = [&](size_t k, bool isLastGroupInCol) {
      size_t i = resolvable[k];
      const auto& entry = chain[i];
      const std::string mt      = entry.value("module_type", std::string());
      const std::string instKey = entry.value("instance_key", std::string());

      const RegisteredModule* reg = registry_->find(mt);
      if (!reg) return;
      auto* inst = rt_ ? rt_->instanceFor(mt, instKey) : nullptr;
      if (!inst) return;

      const bool isFinalStage = isLastCol && isLastGroupInCol;
      int32_t outHandle = isFinalStage ? outputHandle : nextIntermediate(W, H);

      // -- Zero stale per-field state from the previous frame --
      for (const auto& path : reg->inputTexturePaths) {
        inst->setTextureField(path, 0);
        inst->setFieldConnected(path, false, false);
      }
      for (const auto& path : reg->outputTexturePaths) {
        inst->setFieldConnected(path, false, false);
      }

      // -- Apply persisted instance state from the sketch --
      if (instances.is_object() && instances.contains(instKey)) {
        const auto& instJson = instances[instKey];
        const auto& state = instJson.value("state", json::object());
        maybeApplyState(inst, instKey, state);
      }

      // -- Wire primary channels --
      inst->setTextureField("tex_in",  colInput);
      inst->setTextureField("tex_out", outHandle);
      inst->setFieldConnected("tex_in",  true,  false);
      inst->setFieldConnected("tex_out", false, true);

      applyReadTaps(inst, entry, railsById, railTextures, railFloats);
      markWriteTapOutputsConnected(inst, entry);

      inst->doTick(dt);
      inst->doRender(W, H);

      captureWriteTaps(inst, entry, instKey, instances,
                       railsById, railTextures, railFloats);

      if (chainEntryHook_) {
        chainEntryHook_((int)colIdx, (int)i, colInput, outHandle, W, H);
      }

      anyDispatched = true;
      finalHandle = outHandle;
      colInput = outHandle;
    };

    auto runFusedGroup = [&](const Group& g, bool isLastGroupInCol) {
      // Resolve fragments + build cache key.
      std::string cacheKey;
      std::vector<std::string> fragments;
      std::vector<effect_runtime::EffectInstance*> stages;
      stages.reserve(g.lastK - g.firstK + 1);
      bool fragsOK = true;
      for (size_t k = g.firstK; k <= g.lastK; ++k) {
        const auto& entry = chain[resolvable[k]];
        const std::string mt = entry.value("module_type", std::string());
        const std::string instKey = entry.value("instance_key", std::string());
        auto* inst = rt_ ? rt_->instanceFor(mt, instKey) : nullptr;
        if (!inst) { fragsOK = false; break; }
        if (!cacheKey.empty()) cacheKey += '|';
        cacheKey += mt;
        stages.push_back(inst);
        std::string msl;
        if (!rt_->lookupMSL(inst->fusionInfo().fragmentName, &msl)) {
          fragsOK = false; break;
        }
        fragments.push_back(std::move(msl));
      }
      int32_t pso = -1;
      if (fragsOK) {
        auto it = fusedPSOs_.find(cacheKey);
        if (it != fusedPSOs_.end()) {
          pso = it->second;
        } else {
          std::string src = fusion_codegen::generateFusedMSL(fragments);
          if (!src.empty()) {
            int32_t sm = gpu_->createShaderModule(src);
            if (sm > 0) {
              fusedShaderModules_.push_back(sm);
              pso = gpu_->createComputePSO(sm, "fused_main");
              if (pso > 0) fusedPSOs_[cacheKey] = pso;
            }
          }
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

      // Per-stage prep. Each chain entry has its own EffectInstance with
      // its own uniform buffer (created in its create()/init()), so
      // doPrepare writes into a distinct buffer per stage — we bind those
      // directly to the fused dispatch below. No snapshotting needed now
      // that state is per-instance rather than file-static.
      for (size_t idx = 0; idx < stages.size(); ++idx) {
        size_t k = g.firstK + idx;
        const auto& entry = chain[resolvable[k]];
        const std::string instKey = entry.value("instance_key", std::string());
        auto* inst = stages[idx];
        if (instances.is_object() && instances.contains(instKey)) {
          const auto& state = instances[instKey].value("state", json::object());
          maybeApplyState(inst, instKey, state);
        }
        inst->doTick(dt);
        inst->doPrepare(W, H);
      }

      const bool isFinalStage = isLastCol && isLastGroupInCol;
      const int32_t groupInput = colInput;
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
        chainEntryHook_((int)colIdx, (int)resolvable[g.firstK],
                        groupInput, /*output=*/-1, W, H);
        if (g.lastK != g.firstK) {
          chainEntryHook_((int)colIdx, (int)resolvable[g.lastK],
                          /*input=*/-1, groupOutput, W, H);
        }
      }

      anyDispatched = true;
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
  }
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
      inst->setParamJson(name, "\"" + v.get<std::string>() + "\"");
    }
  }
}

void SketchExecutor::applyReadTaps(
    effect_runtime::EffectInstance* inst,
    const json& entry,
    const std::unordered_map<std::string, json>& railsById,
    const std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>>& railTextures,
    const std::unordered_map<std::string, float>& railFloats) {
  if (!entry.contains("taps") || !entry["taps"].is_array()) return;
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
        inst->setParamFloat(fieldPath, fit->second);
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
          if (v.is_number()) {
            railFloats[railId] = (float)v.get<double>();
            inst->setFieldConnected(fieldPath, false, true);
          } else if (v.is_boolean()) {
            railFloats[railId] = v.get<bool>() ? 1.0f : 0.0f;
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
