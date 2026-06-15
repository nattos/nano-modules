#include "sketch/sketch_executor.h"

#include "sketch/sketch_augment.h"
#include "sketch/tap_mod.h"
#include "sketch/host_blend.h"
#include "sketch/exec_gpu.h"
#include "sketch/effrt.h"
#include "sketch/schema_util.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace sketch_executor {

// Native-only: point the effrt_* forwarders at this runtime + reset the frame's
// handle table (effrt_impls.cpp). Under wasm the host owns the runtime, so the
// shared executor never calls this (guarded #ifndef __wasm__ in execute()).
void effrtSetRuntime(effect_runtime::EffectRuntime* rt);

using nlohmann::json;

namespace {

// Thin handle wrapper: the executor drives effect instances purely through the
// effrt.h ABI over an opaque int32 handle (no EffectInstance pointer), so the
// same source compiles to executor.wasm. Methods mirror the old EffectInstance
// surface 1:1 — call sites read the same, just `.` instead of `->`.
struct EffectRef {
  int32_t h = -1;
  bool valid() const { return h >= 0; }
  void setParamFloat(const std::string& p, float v) const {
    effrt_set_param_float(h, p.data(), (int32_t)p.size(), v);
  }
  void setParamJson(const std::string& p, const std::string& j) const {
    effrt_set_param_json(h, p.data(), (int32_t)p.size(), j.data(), (int32_t)j.size());
  }
  void setParamArray(const std::string& p, const std::vector<float>& c) const {
    effrt_set_param_array(h, p.data(), (int32_t)p.size(), c.data(), (int32_t)c.size());
  }
  void setTextureField(const std::string& p, int32_t t) const {
    effrt_set_texture_field(h, p.data(), (int32_t)p.size(), t);
  }
  int32_t textureField(const std::string& p) const {
    return effrt_texture_field(h, p.data(), (int32_t)p.size());
  }
  void setInputTextureSlots(const std::vector<int32_t>& s) const {
    effrt_set_input_texture_slots(h, s.data(), (int32_t)s.size());
  }
  void setFieldConnected(const std::string& p, bool in, bool out) const {
    effrt_set_field_connected(h, p.data(), (int32_t)p.size(), in ? 1 : 0, out ? 1 : 0);
  }
  void setWillRender(bool v) const { effrt_set_will_render(h, v ? 1 : 0); }
  void doTick(double dt) const { effrt_tick(h, dt); }
  void doRender(int w, int hh) const { effrt_render(h, w, hh); }
  void doPrepare(int w, int hh) const { effrt_prepare(h, w, hh); }
  void doSetActive(bool a) const { effrt_set_active(h, a ? 1 : 0); }
  bool isIdentity() const { return effrt_is_identity(h) != 0; }
  int  fusionKind() const { return effrt_fusion_kind(h); }
  bool fusionHasPrepare() const { return effrt_fusion_has_prepare(h) != 0; }
  int  fusionUniformBuffer() const { return effrt_fusion_uniform_buffer(h); }
  std::string fusionFragmentName() const {
    char buf[128];
    int32_t n = effrt_fusion_fragment_name(h, buf, (int32_t)sizeof(buf));
    if (n > (int32_t)sizeof(buf)) n = (int32_t)sizeof(buf);
    return std::string(buf, n > 0 ? n : 0);
  }
};

// Acquire a handle for (module_type, instance_key) via the effrt ABI.
EffectRef instanceRef(const std::string& mt, const std::string& key) {
  return EffectRef{effrt_instance_for(mt.data(), (int32_t)mt.size(),
                                      key.data(), (int32_t)key.size())};
}

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
  : rt_(rt), registry_(registry) { (void)gpu; }

void SketchExecutor::registerModuleSchema(const std::string& moduleType,
                                          const nlohmann::json& schemaFields) {
  RegisteredModule rm;
  rm.schemaFields = schemaFields;
  schema_util::deriveTextureLeafPaths(rm.schemaFields, "",
                                      rm.inputTexturePaths, rm.outputTexturePaths);
  schema_util::deriveSlotInputTextureFields(rm.schemaFields,
                                            rm.slotInputTextureFields);
  moduleSchemas_[moduleType] = std::move(rm);
  // The augmenter's {module_type: schemaFields} projection is now stale.
  cachedSchemasValid_ = false;
}

const RegisteredModule* SketchExecutor::findSchema(const std::string& mt) const {
  auto it = moduleSchemas_.find(mt);
  return it == moduleSchemas_.end() ? nullptr : &it->second;
}

SketchExecutor::~SketchExecutor() {
  for (int32_t h : intermediates_) {
    if (h > 0) gpu_release(h);
  }
  for (auto& [_, pso] : fusedPSOs_) {
    if (pso > 0) gpu_release(pso);
  }
  for (int32_t sm : fusedShaderModules_) {
    if (sm > 0) gpu_release(sm);
  }
  for (auto& [_, leaves] : delayedRailTextures_) {
    for (auto& [__, h] : leaves) {
      if (h > 0) gpu_release(h);
    }
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
      const RegisteredModule* reg = findSchema(mt);
      if (!reg) continue;  // unknown module_type → silent passthrough
      std::string instKey = entry.value("instance_key", std::string());
      // Fusion eligibility — structural (fusion kind/fragment/prepare, tap-free)
      // plus bypass/opacity, which are sketch state and thus only change on a
      // dirty frame. instanceFor materialises the per-key instance here.
      EffectRef inst = instanceRef(mt, instKey);
      bool e = false;
      if (inst.valid()) {
        e = (inst.fusionKind() == 1) && !inst.fusionFragmentName().empty() &&
            inst.fusionHasPrepare();
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
  if (!rawSketch.is_object()) return inputHandle;

#ifndef __wasm__
  // Native: point the effrt_* instance ABI at this runtime and reset the frame's
  // handle table (effrt_impls.cpp). The wasm build's host owns the runtime, so
  // the shared executor doesn't do this there.
  effrtSetRuntime(rt_);
#endif

  // Augment with implicit struct-rail connections. Schemas are
  // immutable after the host's one-shot registerEffect calls, so build
  // the map once and reuse.
  if (!cachedSchemasValid_) {
#ifndef __wasm__
    // Native transitional seed: copy the registry's schemas into the executor's
    // own cache (deriving slot/leaf paths). B1e replaces this with host pushes
    // via registerModuleSchema before execute(); the wasm host pushes directly.
    if (moduleSchemas_.empty() && registry_) {
      for (const auto& kv : registry_->schemas()) {
        registerModuleSchema(kv.first, kv.second);
      }
    }
#endif
    // Project the augmenter's {module_type: schemaFields} map from the cache.
    cachedSchemas_.clear();
    for (const auto& kv : moduleSchemas_) {
      cachedSchemas_[kv.first] = kv.second.schemaFields;
    }
    cachedSchemasValid_ = true;
  }
  // The augmenter deep-clones the whole sketch. For chains with only
  // texture-typed I/O (eg N×brightness_contrast) the augmenter is a
  // no-op anyway, so skip the clone entirely in that case. Detected
  // by `sketchNeedsAugmentation` walking the chain in O(N) and
  // checking whether any module's schema has a structured field.
  // Normalize the editor's single-stack "chain" sketch into the legacy
  // "columns" shape this executor walks: the top-level `chain` becomes one
  // column. Editor/web sketches serialize as `{chain, instances, wires}` (the
  // wire model); older persisted sketches carry `columns` and pass through
  // unchanged. NOTE: the new `wires` array is NOT translated yet — a linear
  // chain renders (each module feeds the next), but field-to-field wires are
  // dropped until the executor is unified onto the wire model (Phase 2).
  json normalizedStorage;
  const json* rawPtr = &rawSketch;
  if (!rawSketch.contains("columns") &&
      rawSketch.contains("chain") && rawSketch["chain"].is_array()) {
    normalizedStorage = rawSketch;
    json chain = rawSketch["chain"];
    json rails = json::array();

    // Translate the wire model's `wires` into the executor's read/write taps +
    // rails. FLOAT wires (scalar param modulation, reusing the tap-mod math)
    // and TEXTURE wires (video routing — producer's output texture captured
    // post-render, bound on the consumer pre-render) route here; struct wires
    // are dropped until the full wire-model port. Float producer scalars are
    // read from the sketch's instance state (the write-tap path); texture
    // handles are pulled from the producer runtime via textureField(). Causality
    // is same-frame only: the producer must sit above the consumer in the chain
    // (the editor serializes in that order). Producer-below-consumer (delayed /
    // feedback) wires are deferred.
    if (rawSketch.contains("wires") && rawSketch["wires"].is_array()) {
      std::unordered_map<std::string, size_t> byKey;
      for (size_t i = 0; i < chain.size(); ++i)
        if (chain[i].is_object())
          byKey[chain[i].value("instance_key", std::string())] = i;
      for (const auto& w : rawSketch["wires"]) {
        if (!w.is_object()) continue;
        const json src = w.value("src", json::object());
        const json dst = w.value("dest", json::object());
        const std::string srcField = src.value("field", std::string());
        const std::string dstField = dst.value("field", std::string());
        const std::string wid = w.value("id", std::string());
        if (wid.empty()) continue;
        auto si = byKey.find(src.value("instanceKey", std::string()));
        auto di = byKey.find(dst.value("instanceKey", std::string()));
        if (si == byKey.end() || di == byKey.end()) continue;
        // Route by the producer field's schema type. Float → float rail,
        // texture → texture rail, object/array → struct rail (its texture
        // leaves flow, same as the augmenter's implicit struct connections —
        // explicit read taps below suppress auto-connect on the dest field).
        const RegisteredModule* reg =
            findSchema(chain[si->second].value("module_type", std::string()));
        std::string ftype;
        json srcDef;
        if (reg && reg->schemaFields.is_object()) {
          auto fit = reg->schemaFields.find(srcField);
          if (fit != reg->schemaFields.end() && fit->is_object()) {
            srcDef = *fit;
            ftype = fit->value("type", std::string());
          }
        }
        json railDataType;
        if (ftype == "float" || ftype == "texture") {
          railDataType = ftype;  // string dataType
        } else if (ftype == "object" || ftype == "array") {
          // Struct rail: dataType {kind:"struct", schema:<producer field def>},
          // matching sketch_augment's implicit struct rails so the shared
          // forEachRailLeafTexture / collectTextureLeaves walk applies.
          railDataType = json{{"kind", "struct"}, {"schema", srcDef}};
        } else {
          continue;  // unsupported source type — drop the wire
        }
        // Positional causality (web's delayed flag): a producer at/below the
        // consumer in the chain feeds the PREVIOUS frame's value (also how
        // feedback cycles are broken). The executor processes top-to-bottom, so
        // when si >= di the consumer reads before the producer writes — mark
        // both taps delayed so they route through the persistent delay maps.
        const bool delayed = si->second >= di->second;
        rails.push_back(json{{"id", wid}, {"dataType", railDataType}});
        json wtap{{"direction", "write"}, {"railId", wid}, {"fieldPath", srcField}};
        if (delayed) wtap["delayed"] = true;
        chain[si->second]["taps"].push_back(std::move(wtap));
        json rtap{{"direction", "read"}, {"railId", wid}, {"fieldPath", dstField}};
        if (delayed) rtap["delayed"] = true;
        // Tap-mod / combine / mix only meaningfully apply to scalar rails; the
        // texture path ignores them (carried through harmlessly).
        if (w.contains("mod")) rtap["mod"] = w["mod"];
        if (w.contains("combine")) rtap["combine"] = w["combine"];
        if (w.contains("mixFactor")) rtap["mixFactor"] = w["mixFactor"];
        // Magnitude mapping (scalar wires only). The web's resolveScalarWire
        // default is `auto`: map the shaped value into the DEST field's
        // [min,max] per the source field's signed/unsigned declaration. Only
        // `absolute` falls back to the plain combineTap fold. Resolve it here
        // (registry available) and stash the concrete params on the read tap;
        // applyReadTaps replays applyMagnitude with them. Texture wires skip it.
        if (ftype == "float") {
          std::string mag = w.value("magnitude", std::string("auto"));
          if (mag != "absolute") {
            // auto → the source output field's `magnitude` decl (default unsigned).
            if (mag == "auto") {
              std::string decl;
              if (reg && reg->schemaFields.is_object()) {
                auto fit = reg->schemaFields.find(srcField);
                if (fit != reg->schemaFields.end() && fit->is_object())
                  decl = fit->value("magnitude", std::string());
              }
              mag = (decl == "signed") ? "signed" : "unsigned";
            }
            // Dest field's [min,max] (default 0..1, e.g. dashboard knobs).
            double dmin = 0.0, dmax = 1.0;
            const RegisteredModule* dreg =
                findSchema(chain[di->second].value("module_type", std::string()));
            if (dreg && dreg->schemaFields.is_object()) {
              auto dfit = dreg->schemaFields.find(dstField);
              if (dfit != dreg->schemaFields.end() && dfit->is_object()) {
                dmin = dfit->value("min", 0.0);
                dmax = dfit->value("max", 1.0);
              }
            }
            rtap["magnitude"] = mag;   // "signed" | "unsigned"
            rtap["destMin"] = dmin;
            rtap["destMax"] = dmax;
          }
        }
        chain[di->second]["taps"].push_back(rtap);
      }
    }

    json col{{"chain", std::move(chain)}};
    if (!rails.empty()) col["rails"] = std::move(rails);
    normalizedStorage["columns"] = json::array({std::move(col)});
    rawPtr = &normalizedStorage;
  }
  const json& rawNorm = *rawPtr;

  json augmentedStorage;
  const json* sketchPtr = &rawNorm;
  if (sketch_augment::sketchNeedsAugmentation(rawNorm, cachedSchemas_)) {
    augmentedStorage = sketch_augment::augmentSketchWithImplicitConnections(
        rawNorm, cachedSchemas_);
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
  pendingDelayRetain_.clear();  // delayed texture retains gathered this frame

  // Coalesce the whole frame's stages into ONE command buffer. Every effect's
  // render() ends in gpu::submit() (commit + waitUntilCompleted) — left alone,
  // an N-stage chain blocks the CPU on GPU completion N times per frame, the
  // dominant cost for non-fusable chains (a 16-stage chain measured ~12 ms/frame
  // wall, almost all of it parked in waitUntilCompleted). beginSubmitBatch makes
  // those per-stage submits defer; endSubmitBatch commits + waits once. The
  // chain-entry capture hooks only RECORD texture handles (readback is deferred
  // to after execute()), so monitored intermediates stay correct.
  gpu_begin_submit_batch();

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
    auto maybeApplyState = [&](EffectRef inst,
                               const std::string& instKey,
                               const json& state) {
      // Persisted params only change when the sketch is edited. When the host
      // tells us it didn't change, skip the per-instance whole-state compare
      // (multi-KB for rich text) entirely — they were applied on the last dirty
      // frame and read taps re-drive any modulated params separately below.
      if (!sketchDirty) return;
      auto& cachedState = lastAppliedState_[instKey];
      if (cachedState == state) return;
      applyState(inst.h, cachedState, state);
      cachedState = state;
    };

    auto runStandalone = [&](size_t k, bool isLastGroupInCol) {
      const PlanEntry& pe = R[k];
      size_t i = pe.chainIdx;
      const auto& entry = chain[i];
      const std::string& mt      = pe.moduleType;
      const std::string& instKey = pe.instanceKey;

      const RegisteredModule* reg = pe.reg;
      EffectRef inst = instanceRef(mt, instKey);
      if (!inst.valid()) return;

      // For a passthrough stage that is the column's FINAL output, the result
      // must land in `outputHandle` (the caller's bound output texture) — the
      // barrel blits that texture, not an arbitrary intermediate. Mid-chain
      // passthroughs just alias colInput (the next stage reads it directly).
      const bool isFinalStage = isLastCol && isLastGroupInCol;
      auto passthroughOutput = [&](int32_t src) -> int32_t {
        // No real input (e.g. a bypassed generator with nothing above): emit a
        // clean cleared frame so the next stage / column output isn't a stale
        // pooled texture.
        if (src < 0) {
          src = nextIntermediate(W, H);
          gpu_clear_texture(src, 0.0f, 0.0f, 0.0f, 0.0f);
        }
        if (isFinalStage && src != outputHandle) {
          gpu_copy_texture(src, outputHandle);
          return outputHandle;
        }
        return src;
      };

      // -- Device on/off ("bypass"): when off, fire the on_active transition
      // then go fully dormant — no state, no taps, no tick/render — and alias
      // the column input straight through as this stage's output. --
      const bool bypass = readBypass(instances, instKey);
      inst.doSetActive(!bypass);
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
        inst.setTextureField(path, 0);
        inst.setFieldConnected(path, false, false);
      }
      for (const auto& path : reg->outputTexturePaths) {
        inst.setFieldConnected(path, false, false);
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
      if (!hasTaps && inst.isIdentity()) {
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
      inst.setWillRender(willRender);

      if (!willRender) {
        inst.setTextureField("tex_in", colInput);
        inst.setFieldConnected("tex_in", true, false);
        applyReadTaps(inst.h, entry, railsById, railTextures, railFloats, instances, instKey);
        markWriteTapOutputsConnected(inst.h, entry);
        inst.doTick(dt);
        captureWriteTaps(inst.h, entry, instKey, instances,
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
      inst.setTextureField("tex_in",  colInput);
      inst.setTextureField("tex_out", fxHandle);
      inst.setFieldConnected("tex_in",  true,  false);
      inst.setFieldConnected("tex_out", false, true);

      applyReadTaps(inst.h, entry, railsById, railTextures, railFloats, instances, instKey);
      markWriteTapOutputsConnected(inst.h, entry);

      // -- Positional input slots + per-stage render target (slot-based GPU
      // ABI). Effects like video.blend read inputTexture(0/1) and
      // renderTarget() rather than textureForField. Slot 0 is the linear chain
      // input; any wire-bound input field overrides its schema slot. Mirrors
      // the web executor's inputTextures construction. setSurface points
      // renderTarget() at this stage's output (the barrel never sets a surface
      // otherwise, so this is also what makes renderTarget() valid at all). --
      {
        std::vector<int32_t> slots;
        slots.push_back(colInput);
        if (reg) {
          for (size_t pi = 0; pi < reg->slotInputTextureFields.size(); ++pi) {
            int h = inst.textureField(reg->slotInputTextureFields[pi]);
            if (h > 0) {
              while (slots.size() <= pi) slots.push_back(-1);
              slots[pi] = h;
            }
          }
        }
        inst.setInputTextureSlots(slots);
      }
      gpu_set_surface(fxHandle, W, H);

      inst.doTick(dt);
      inst.doRender(W, H);

      captureWriteTaps(inst.h, entry, instKey, instances,
                       railsById, railTextures, railFloats);

      if (partial) {
        if (!blend_) blend_ = std::make_unique<WetDryBlend>();
        if (!blend_->encode(colInput, fxHandle, outHandle, opacity, W, H)) {
          // Couldn't build the blend pass — show the effect at full strength
          // rather than nothing.
          gpu_copy_texture(fxHandle, outHandle);
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
      std::vector<EffectRef> allStages;
      allStages.reserve(g.lastK - g.firstK + 1);
      bool stagesOK = true;
      for (size_t k = g.firstK; k <= g.lastK; ++k) {
        const std::string& instKey = R[k].instanceKey;
        EffectRef inst = instanceRef(R[k].moduleType, instKey);
        if (!inst.valid()) { stagesOK = false; break; }
        if (const json* st = findState(instances, instKey)) {
          maybeApplyState(inst, instKey, *st);
        }
        inst.doTick(dt);
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
      std::vector<EffectRef> stages;
      for (size_t idx = 0; idx < allStages.size(); ++idx) {
        EffectRef inst = allStages[idx];
        if (inst.isIdentity()) continue;
        if (!cacheKey.empty()) cacheKey += '|';
        cacheKey += R[g.firstK + idx].moduleType;
        stages.push_back(inst);
      }

      const bool isFinalStage = isLastCol && isLastGroupInCol;
      const int32_t groupInput = colInput;

      // Whole group is identity → passthrough.
      if (stages.empty()) {
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
      {
        auto it = fusedPSOs_.find(cacheKey);
        if (it != fusedPSOs_.end()) {
          pso = it->second;   // may be -1: a previously-failed compile (cached!)
        } else {
          // Host assembles the platform fused-chain source (lookupMSL +
          // generateFused — MSL native / WGSL web). The executor owns the PSO
          // cache + lifetime; only the codegen crosses the ABI.
          std::vector<int32_t> sh;
          sh.reserve(stages.size());
          for (auto s : stages) sh.push_back(s.h);
          std::string src(8192, '\0');
          int32_t len = effrt_build_fused_source(sh.data(), (int32_t)sh.size(),
                                                 src.data(), (int32_t)src.size());
          if (len > (int32_t)src.size()) {  // grew past the buffer — resize + retry
            src.assign((size_t)len, '\0');
            len = effrt_build_fused_source(sh.data(), (int32_t)sh.size(),
                                           src.data(), (int32_t)src.size());
          }
          if (len > 0) {
            int32_t sm = gpu_create_shader_module(src.data(), len);
            if (sm > 0) {
              fusedShaderModules_.push_back(sm);
              pso = gpu_create_compute_pso(sm, "fused_main", 10);
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
      for (auto inst : stages) inst.doPrepare(W, H);

      const int32_t groupOutput = isFinalStage
                                  ? outputHandle
                                  : nextIntermediate(W, H);

      int32_t pass = gpu_begin_compute_pass();
      gpu_compute_set_pso(pass, pso);
      gpu_compute_set_texture(pass, groupInput,  0, /*read */ 0);
      gpu_compute_set_texture(pass, groupOutput, 1, /*write*/ 1);
      for (size_t idx = 0; idx < stages.size(); ++idx) {
        // Each stage binds its own per-instance uniform buffer.
        int32_t ub = stages[idx].fusionUniformBuffer();
        gpu_compute_set_buffer(pass, ub, 0, (int32_t)(2 + idx));
      }
      gpu_compute_dispatch(pass,
                            ((uint32_t)W + 7) / 8,
                            ((uint32_t)H + 7) / 8, 1);
      gpu_end_compute_pass(pass);

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

  // Retain delayed (feedback) texture wires' outputs into stable copies BEFORE
  // the batch commits, so the blit is ordered after the producers' renders in
  // this command buffer and the copy is finished by the time next frame reads it.
  flushDelayedTextureRetains(W, H);

  // Flush the batched frame: commit + wait once. All GPU work (including any
  // monitored intermediate textures) is complete when this returns, so the
  // host's downstream consumers — the output-hook readback below and the FFGL
  // interop blit — see finished pixels exactly as they did under per-stage waits.
  gpu_end_submit_batch();

  if (anyDispatched && sketchOutputHook_) {
    sketchOutputHook_(finalHandle, W, H);
  }
  return anyDispatched ? finalHandle : inputHandle;
}

int32_t SketchExecutor::nextIntermediate(int W, int H) {
  if (W != intermediates_w_ || H != intermediates_h_) {
    for (int32_t h : intermediates_) { if (h > 0) gpu_release(h); }
    intermediates_.clear();
    intermediates_w_ = W; intermediates_h_ = H;
  }
  if (intermediate_cursor_ >= (int)intermediates_.size()) {
    // RGBA8 (format code 1) matches what every effect's compute
    // dispatch is writing today.
    int32_t h = gpu_create_texture((uint32_t)W, (uint32_t)H, 1);
    intermediates_.push_back(h);
  }
  return intermediates_[intermediate_cursor_++];
}

void SketchExecutor::flushDelayedTextureRetains(int W, int H) {
  // On resize the retained textures are the wrong size — free + drop them
  // (next frame reallocs at the new dims). Float delays are dimensionless.
  if (W != delayTexW_ || H != delayTexH_) {
    for (auto& [rid, leaves] : delayedRailTextures_)
      for (auto& [leaf, h] : leaves)
        if (h > 0) gpu_release(h);
    delayedRailTextures_.clear();
    delayTexW_ = W; delayTexH_ = H;
  }
  for (const auto& [railId, leaf, src] : pendingDelayRetain_) {
    if (src <= 0) continue;
    int32_t& retained = delayedRailTextures_[railId][leaf];
    if (retained <= 0) {
      // Match the producer's format (RGBA8 tex_out vs rgba16float struct leaves)
      // so the blit is a straight format-compatible copy.
      int32_t fmt = gpu_get_texture_format(src);
      if (fmt < 0) fmt = 1;
      retained = gpu_create_texture((uint32_t)W, (uint32_t)H, fmt);
    }
    if (retained > 0) gpu_copy_texture(src, retained);
  }
  pendingDelayRetain_.clear();
}

void SketchExecutor::applyState(
    int32_t inst_handle,
    const json& prevState,
    const json& state) {
  const EffectRef inst{inst_handle};
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
      inst.setParamFloat(name, (float)v.get<double>());
    } else if (v.is_boolean()) {
      inst.setParamFloat(name, v.get<bool>() ? 1.0f : 0.0f);
    } else if (v.is_array()) {
      std::vector<float> comps;
      for (const auto& x : v) {
        if (x.is_number()) comps.push_back((float)x.get<double>());
      }
      if (!comps.empty()) inst.setParamArray(name, comps);
    } else if (v.is_string()) {
      // dump() emits a properly-escaped JSON string literal. Naive quoting
      // ("\"" + s + "\"") produces invalid JSON the moment the value contains
      // a quote/backslash/newline — e.g. rich-text HTML (<h1 style="…">) — and
      // setParamJson then parses it as null (renders the literal "null").
      inst.setParamJson(name, v.dump());
    }
  }
}

void SketchExecutor::applyReadTaps(
    int32_t inst_handle,
    const json& entry,
    const std::unordered_map<std::string, json>& railsById,
    const std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>>& railTextures,
    const std::unordered_map<std::string, float>& railFloats,
    const json& sketchInstances,
    const std::string& instanceKey) {
  const EffectRef inst{inst_handle};
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

    // Delayed reads pull from the persistent maps (last frame's value); plain
    // reads from this frame's local rails. See delayedRailFloats_ doc.
    const bool delayed = tap.value("delayed", false);

    if (dataType.is_string() && dataType.get<std::string>() == "float") {
      const auto& srcFloats = delayed ? delayedRailFloats_ : railFloats;
      auto fit = srcFloats.find(railId);
      if (fit != srcFloats.end()) {
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
        float combined;
        // Wire magnitude mode (resolved during normalization). Present →
        // range-aware fold into [destMin,destMax]; absent → legacy combineTap
        // (the wire's `absolute` mode, or a plain rail tap). Mirrors web's
        // resolveScalarWire: applyMagnitude seeds from min when no canonical.
        if (tap.contains("magnitude")) {
          const bool isSigned = tap.value("magnitude", std::string()) == "signed";
          const float dmin = (float)tap.value("destMin", 0.0);
          const float dmax = (float)tap.value("destMax", 1.0);
          combined = tap_mod::applyMagnitude(
              hasCanon ? canon : dmin, shaped, isSigned,
              parseCombine(tap), tap.value("mixFactor", 1.0f), dmin, dmax);
        } else {
          combined = tap_mod::combineTap(hasCanon, canon, shaped,
              parseCombine(tap), tap.value("mixFactor", 1.0f));
        }
        inst.setParamFloat(fieldPath, combined);
        inst.setFieldConnected(fieldPath, true, false);
      }
      continue;
    }

    // Texture/struct read: delayed binds the retained 1-frame copy (empty until
    // the producer has run for a full frame — frame 0 degrades to unbound).
    const auto& srcTextures = delayed ? delayedRailTextures_ : railTextures;
    auto texIt = srcTextures.find(railId);
    if (texIt == srcTextures.end()) continue;
    forEachRailLeafTexture(dataType, [&](const std::string& leaf) {
      auto lit = texIt->second.find(leaf);
      if (lit == texIt->second.end() || lit->second <= 0) return;
      const std::string target = leaf.empty() ? fieldPath
                                              : (fieldPath + "/" + leaf);
      inst.setTextureField(target, lit->second);
    });
    inst.setFieldConnected(fieldPath, true, false);
  }
}

void SketchExecutor::captureWriteTaps(
    int32_t inst_handle,
    const json& entry,
    const std::string& producerInstanceKey,
    const json& sketchInstances,
    const std::unordered_map<std::string, json>& railsById,
    std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>>& railTextures,
    std::unordered_map<std::string, float>& railFloats) {
  const EffectRef inst{inst_handle};
  if (!entry.contains("taps") || !entry["taps"].is_array()) return;
  for (const auto& tap : entry["taps"]) {
    if (tap.value("direction", std::string()) != "write") continue;
    const std::string railId    = tap.value("railId", std::string());
    const std::string fieldPath = tap.value("fieldPath", std::string());
    auto railIt = railsById.find(railId);
    if (railIt == railsById.end()) continue;
    const auto& dataType = railIt->second.value("dataType", json());
    // Delayed writes land in the persistent maps (float: write straight through
    // — the consumer above already read last frame's value; texture: defer a
    // retained copy to frame end). See delayedRailFloats_ doc.
    const bool delayed = tap.value("delayed", false);

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
            auto& rf = delayed ? delayedRailFloats_ : railFloats;
            float shaped = tap_mod::applyTapMod(raw, parseMod(tap));
            auto existing = rf.find(railId);
            rf[railId] = tap_mod::combineTap(
                existing != rf.end(),
                existing != rf.end() ? existing->second : 0.0f,
                shaped, parseCombine(tap), tap.value("mixFactor", 1.0f));
            inst.setFieldConnected(fieldPath, false, true);
          }
        }
      }
      continue;
    }

    if (delayed) {
      // Texture/struct feedback: the producer's output is a recycled
      // intermediate, so record its current handle and copy it into a retained
      // texture at frame end (after every stage commits). The retained copy is
      // what next frame's consumer reads.
      forEachRailLeafTexture(dataType, [&](const std::string& leaf) {
        const std::string source = leaf.empty() ? fieldPath
                                                : (fieldPath + "/" + leaf);
        int32_t h = inst.textureField(source);
        if (h > 0) pendingDelayRetain_.emplace_back(railId, leaf, h);
      });
      inst.setFieldConnected(fieldPath, false, true);
      continue;
    }

    auto& texMap = railTextures[railId];
    forEachRailLeafTexture(dataType, [&](const std::string& leaf) {
      const std::string source = leaf.empty() ? fieldPath
                                              : (fieldPath + "/" + leaf);
      int32_t h = inst.textureField(source);
      if (h > 0) texMap[leaf] = h;
    });
  }
}

void SketchExecutor::markWriteTapOutputsConnected(
    int32_t inst_handle,
    const json& entry) {
  const EffectRef inst{inst_handle};
  if (!entry.contains("taps") || !entry["taps"].is_array()) return;
  for (const auto& tap : entry["taps"]) {
    if (tap.value("direction", std::string()) != "write") continue;
    const std::string fieldPath = tap.value("fieldPath", std::string());
    inst.setFieldConnected(fieldPath, false, true);
  }
}

}  // namespace sketch_executor
