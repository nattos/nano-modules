#include "sketch/sketch_executor.h"

#include "sketch/sketch_augment.h"
#include "sketch/tap_mod.h"
#include "sketch/param_smoothing.h"
#include "sketch/host_blend.h"
#include "sketch/exec_gpu.h"
#include "sketch/effrt.h"
#include "sketch/schema_util.h"

#ifndef __wasm__
// Native-only: the seed (registry_->schemas()) + effrtSetRuntime arg type. The
// wasm build drives everything through the gpu/effrt ABIs and never references
// these — the #ifndef __wasm__ blocks in execute() are compiled out there.
#include "sketch/module_registry.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#endif

#include <algorithm>
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
  void setBufferField(const std::string& p, int32_t b) const {
    effrt_set_buffer_field(h, p.data(), (int32_t)p.size(), b);
  }
  int32_t bufferField(const std::string& p) const {
    return effrt_buffer_field(h, p.data(), (int32_t)p.size());
  }
  void setInputTextureSlots(const std::vector<int32_t>& s) const {
    effrt_set_input_texture_slots(h, s.data(), (int32_t)s.size());
  }
  void setFieldConnected(const std::string& p, bool in, bool out) const {
    effrt_set_field_connected(h, p.data(), (int32_t)p.size(), in ? 1 : 0, out ? 1 : 0);
  }
  void setWillRender(bool v) const { effrt_set_will_render(h, v ? 1 : 0); }
  void doTick(double dt) const { effrt_tick(h, dt); }
  void doSeek(double from, double to) const { effrt_seek(h, from, to); } // no-op if the effect has no seek
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

/**
 * Visit each GPU storage-buffer leaf of a struct rail. (Plain buffer rails
 * don't exist — buffers only flow as struct leaves.) Yields slash-joined
 * sub-paths, mirroring forEachRailLeafTexture.
 */
template <class F>
void forEachRailLeafBuffer(const json& dataType, F&& f) {
  if (dataType.is_object() &&
      dataType.value("kind", std::string()) == "struct") {
    const auto& schema = dataType.value("schema", json());
    std::vector<std::string> leaves;
    sketch_augment::collectGpuBufferLeaves(schema, "", leaves);
    for (auto& l : leaves) f(l);
  }
}

/**
 * Visit each scalar leaf of a struct rail, with its schema default. The
 * producer's output declaration is the value source (no runtime getter), so a
 * struct rail flows the producer's declared count/flags onto the consumer.
 */
template <class F>
void forEachRailLeafScalar(const json& dataType, F&& f) {
  if (dataType.is_object() &&
      dataType.value("kind", std::string()) == "struct") {
    const auto& schema = dataType.value("schema", json());
    std::vector<std::pair<std::string, double>> leaves;
    sketch_augment::collectScalarLeaves(schema, "", leaves);
    for (auto& l : leaves) f(l.first, l.second);
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
  // Envelope: a flat number array [x0,y0,e0, x1,y1,e1, ...] (the same wire-format
  // the mod.shaper.envelope effect uses; serialized by the envelope graph editor). Read
  // it into the Mod's control points; applyTapMod evaluates it before the remap.
  if (mod.contains("envelope") && mod["envelope"].is_array()) {
    const json& e = mod["envelope"];
    int n = 0;
    for (size_t k = 0; k + 3 <= e.size() && n < envelope::kMaxPoints; k += 3) {
      if (!e[k].is_number() || !e[k + 1].is_number() || !e[k + 2].is_number()) continue;
      m.env[n].x    = e[k].get<float>();
      m.env[n].y    = e[k + 1].get<float>();
      m.env[n].ease = e[k + 2].get<float>();
      ++n;
    }
    m.nEnv = n;
  }
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

// Modulation-band sampler. Re-runs the SAME per-tap fold (`fold`) used for a
// modulated input's live value across the source output's declared range to
// find the swing the value can take. Sampling (not interval arithmetic) so the
// nonlinear / foldback tap_mod curves are reproduced exactly by the lock-step
// functions — no parallel math to keep in sync. Records { value, min, max } at
// modData[instanceKey][field] for editor telemetry (lastModulationData()).
// `neutral` is the fill anchor the editor's band grows from (see modNeutral) so
// a filled bar — not just a moving tick — tracks the live value.
template <typename FoldFn>
void recordModBand(json& modData, const std::string& instanceKey,
                   const std::string& field, float live, float neutral,
                   float srcMin, float srcMax, FoldFn&& fold) {
  constexpr int kBandSamples = 9;  // enough to capture foldback / non-monotone
  float lo = live, hi = live;
  for (int i = 0; i < kBandSamples; ++i) {
    const float t = (float)i / (float)(kBandSamples - 1);
    const float v = fold(srcMin + (srcMax - srcMin) * t);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  modData[instanceKey][field] = {
      {"value", (double)live}, {"min", (double)lo}, {"max", (double)hi},
      {"neutral", (double)neutral}};
}

// The fill anchor a modulation band grows from, per combine mode. This is the
// effective value when the source input sits at its neutral (0):
//   replace → min (unsigned) / midpoint (signed) — i.e. applyMagnitude's
//             replaceVal at input 0;
//   add / mix → the user's base value (input 0 contributes nothing);
//   mul       → 0 (the multiplicative origin).
inline float modNeutral(tap_mod::Combine combine, bool isSigned,
                        float base, float dmin, float dmax) {
  switch (combine) {
    case tap_mod::Combine::Mul:     return 0.0f;
    case tap_mod::Combine::Replace: return isSigned ? (dmin + dmax) * 0.5f : dmin;
    case tap_mod::Combine::Add:
    case tap_mod::Combine::Mix:
    default:                        return base;
  }
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

// Structural signature of everything buildPlan() consumes — used to decide
// whether a dirty frame actually needs a plan REBUILD vs. just a state re-apply.
// The plan depends only on chain TOPOLOGY (module_types, instance_keys, whether
// an entry has any taps) + rail definitions + the two state-derived fusion
// eligibility inputs (bypass, opacity). It does NOT depend on effect param
// values — those are read live per frame (applyState / read taps). So a pure
// param-slider drag produces an identical signature and skips the rebuild, while
// add/remove/reorder, wire edits, and bypass/opacity toggles still change it.
// (Tap CONTENT — mod/combine/magnitude — is read live each frame from the
// sketch, never cached in the plan, so only taps-PRESENCE affects the plan.)
// True iff a chain entry has at least one engine-level `smoothing` option
// enabled (entry.fieldOptions[field].smoothing.enabled). Smoothing layers a
// per-frame linear ramp on top of a scalar field's final (post-modulation)
// value, so a smoothed entry must run on the standalone path (where params are
// applied per frame) — it disables fusion the same way a tap does.
bool entryHasSmoothing(const json& entry) {
  auto it = entry.find("fieldOptions");
  if (it == entry.end() || !it->is_object()) return false;
  for (auto f = it->begin(); f != it->end(); ++f) {
    if (!f->is_object()) continue;
    const auto sm = f->find("smoothing");
    if (sm != f->end() && sm->is_object() && sm->value("enabled", false))
      return true;
  }
  return false;
}

std::string computeStructSig(const json& columns, const json& instances,
                             const json& sketchRails) {
  std::string sig;
  sig.reserve(256);
  sig += "R:";
  sig += sketchRails.dump();
  sig.push_back('\n');
  for (size_t c = 0; c < columns.size(); ++c) {
    const json& col = columns[c];
    sig += "r:";
    sig += refOr(col, "rails", kEmptyArr, true).dump();
    sig.push_back('\n');
    const json& chain = refOr(col, "chain", kEmptyArr, true);
    for (size_t i = 0; i < chain.size(); ++i) {
      const auto& e = chain[i];
      sig += e.value("module_type", std::string());
      sig.push_back('|');
      const std::string key = e.value("instance_key", std::string());
      sig += key;
      sig.push_back('|');
      const bool tapsNonEmpty = e.contains("taps") && e["taps"].is_array() &&
                                !e["taps"].empty();
      sig.push_back(tapsNonEmpty ? 'T' : 't');
      sig.push_back('|');
      // Smoothing toggles fusion eligibility (a smoothed entry is forced
      // standalone), so it's structural — track it so toggling rebuilds the plan.
      sig.push_back(entryHasSmoothing(e) ? 'S' : 's');
      sig.push_back('|');
      sig.push_back(readBypass(instances, key) ? 'B' : 'b');
      sig.push_back('|');
      sig += std::to_string(readOpacity(instances, key));
      sig.push_back('\n');
    }
  }
  return sig;
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
  // A node with NO output texture field (io & 2) emits only scalars/structs — a
  // modulation source that passes the image chain through (see hasTextureOutput).
  rm.hasTextureOutput = false;
  rm.hasBufferOutput = false;
  if (rm.schemaFields.is_object()) {
    for (auto it = rm.schemaFields.begin(); it != rm.schemaFields.end(); ++it) {
      const auto& def = it.value();
      if (!def.is_object() || (def.value("io", 0) & 2) == 0) continue;
      if (def.value("type", std::string()) == "texture") {
        rm.hasTextureOutput = true;
      }
      // An output struct/array may carry GPU storage-buffer leaves (e.g.
      // particles_out/positions). Such a producer must still render() to upload
      // its buffers even though it has no texture output.
      std::vector<std::string> bufLeaves;
      sketch_augment::collectGpuBufferLeaves(def, "", bufLeaves);
      if (!bufLeaves.empty()) rm.hasBufferOutput = true;
    }
  }
  moduleSchemas_[moduleType] = std::move(rm);
  // The augmenter's {module_type: schemaFields} projection is now stale.
  cachedSchemasValid_ = false;
  // Force a plan rebuild on the next frame. A (re-)registered schema can change
  // fusion eligibility (kind/fragment/prepare) for an existing module_type — e.g.
  // an effect HMR-reloaded under the same type — and that's NOT reflected in the
  // structural signature (which keys on module_type, not schema contents). The
  // sig-gated rebuild in execute() would otherwise skip it. registerModuleSchema
  // runs only at setup / on reload (never per frame), so invalidating here is
  // free and keeps the invariant: any buildPlan input change → rebuild.
  planValid_ = false;
}

void SketchExecutor::registerModuleCapabilities(
    const std::string& moduleType, std::vector<std::string> capabilities) {
  // The schema entry is registered first; create it lazily if not (defensive).
  moduleSchemas_[moduleType].capabilities = std::move(capabilities);
  // Capabilities drive the modulation auto-connect, which rewrites the wire
  // topology — rebuild the plan so a late capability push takes effect.
  planValid_ = false;
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
  ++planBuildCount_;  // test-only instrumentation (planBuildCountForTest)
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
        // A modulation source (no output texture) is a passthrough, never fused.
        e = reg->hasTextureOutput &&
            (inst.fusionKind() == 1) && !inst.fusionFragmentName().empty() &&
            inst.fusionHasPrepare();
        if (e && entry.contains("taps") && entry["taps"].is_array() &&
            !entry["taps"].empty()) {
          e = false;
        }
        // A smoothed field needs its ramp applied per frame on the standalone
        // path (after read taps); fusion's per-stage uniform prep doesn't run it.
        if (e && entryHasSmoothing(entry)) {
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

  // Deterministic effect seeks (see setFrameTime). Two triggers land an effect on the
  // exact phase it should have at this frame's time rather than wherever a clamped tick
  // left it: a BACKWARD jump in transport time, or a freshly-ACTIVATED instance (its
  // clip just started playing — without this its phase would start from the jump point,
  // not the clip start). Both seek to the instance's CLIP-RELATIVE time
  // (frameAbsSec_ − the entry's `startSec`). Smoothing/delay always advance by a
  // CLAMPED (≥0) tickDt so they never run backwards.
  const double absNow = frameAbsSec_;
  const double absPrev = prevAbsSec_;
  prevAbsSec_ = absNow;
  const bool jumpedBack = absNow < absPrev - 1e-6;
  const double tickDt = dt < 0.0 ? 0.0 : dt;
  std::unordered_set<std::string> framedKeys; // instance keys ticked this frame
  // Seek `inst` to its clip-relative time when it's new this frame or transport jumped
  // back. doSeek is a no-op for effects with no seek handler. Also records the key as
  // active so a later frame knows it isn't new.
  auto maybeSeek = [&](const EffectRef& inst, double startSec, const std::string& instKey) {
    const bool isNew = !knownKeys_.count(instKey);
    framedKeys.insert(instKey);
    if (!isNew && !jumpedBack) return;
    const double to = absNow - startSec;
    inst.doSeek(to - tickDt, to);
  };

  // Advance the shared modulation clock once per frame — the time base the wire
  // delay lines (delayState_) push/read against (style guide §2.1: accumulate dt,
  // never time*rate). Done before any tap processing this frame.
  modClock_ += tickDt;

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
        // Carry the registry's capability tags into the executor's own cache —
        // the modulation auto-connect (below) gates on them, and the executor
        // never consults the registry at run time (parity with the wasm host,
        // which pushes caps via executor_register_capabilities).
        if (const RegisteredModule* r = registry_->find(kv.first))
          registerModuleCapabilities(kv.first, r->capabilities);
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
    // Effective wire list = the user's explicit wires + implicit modulation
    // auto-connects synthesised just below. Both route through the same
    // wire→tap translation, so an implicit wire shapes/folds identically to one
    // the user drew.
    json effWires = rawSketch.value("wires", json::array());
    if (!effWires.is_array()) effWires = json::array();

    // --- Modulation auto-connect (by relative chain position) ---------------
    // When a module that declares `modulation_shaper` sits directly after one
    // that PRODUCES modulation — a `modulation_source` OR another
    // `modulation_shaper` (the nearest module entry above it) — wire the
    // producer's modulation OUTPUT channel into the shaper's modulation INPUT
    // channel in ABSOLUTE magnitude (value flows through untouched), so a
    // dropped-in shaper "just works" and shapers CHAIN without the user drawing
    // wires. This is
    // the modulation analogue of sketch_augment's implicit STRUCT connections —
    // there matched by structural type, here by capability + relative position.
    // A "channel" is the magnitude'd scalar field (the same marker that names a
    // source's output channels); we pick the PRIMARY one. Explicit wires win:
    // an input that's already wired is left alone.
    // Modulation channel helpers, shared by the auto-connect (below) and the
    // "inherit" polarity resolution (in the wire loop).
    auto hasCap = [](const RegisteredModule* reg, const char* cap) -> bool {
      if (!reg) return false;
      for (const auto& c : reg->capabilities) if (c == cap) return true;
      return false;
    };
    // A module's modulation channel for one io direction: the primary
    // magnitude'd scalar float field (falls back to the first such field).
    auto modChannel = [](const RegisteredModule* reg, int ioBit) -> std::string {
      if (!reg || !reg->schemaFields.is_object()) return std::string();
      std::string primary, any;
      for (auto it = reg->schemaFields.begin(); it != reg->schemaFields.end(); ++it) {
        const json& d = it.value();
        if (!d.is_object()) continue;
        if (d.value("type", std::string()) != "float") continue;
        const int io = d.value("io", 0);
        if (!(io & ioBit)) continue;
        if (!d.contains("magnitude")) continue;     // channel marker
        if (any.empty()) any = it.key();
        if ((io & 4) && primary.empty()) primary = it.key();  // Primary bit
      }
      return primary.empty() ? any : primary;
    };
    {
      // Disabled (bypassed) instances are invisible to modulation auto-connect:
      // they get no wire of their own, and neighbours connect THROUGH them (the
      // predecessor scan skips them), so toggling an effect off re-routes the
      // mod chain around it.
      const json& modInstances = refOr(rawSketch, "instances", kEmptyObj, false);
      for (size_t i = 0; i < chain.size(); ++i) {
        if (!chain[i].is_object() || !chain[i].contains("instance_key")) continue;
        if (readBypass(modInstances, chain[i].value("instance_key", std::string())))
          continue;  // a disabled shaper takes no auto-connect
        const RegisteredModule* sreg =
            findSchema(chain[i].value("module_type", std::string()));
        if (!hasCap(sreg, "modulation_shaper")) continue;
        const std::string inField = modChannel(sreg, 1);   // Input bit
        if (inField.empty()) continue;
        // Nearest ENABLED module entry above (the "directly after" relation,
        // seeing through disabled instances).
        int p = -1;
        for (int j = static_cast<int>(i) - 1; j >= 0; --j) {
          if (chain[j].is_object() && chain[j].contains("module_type") &&
              chain[j].contains("instance_key")) {
            if (readBypass(modInstances, chain[j].value("instance_key", std::string())))
              continue;  // skip disabled producers
            p = j; break;
          }
        }
        if (p < 0) continue;
        const RegisteredModule* greg =
            findSchema(chain[p].value("module_type", std::string()));
        // The predecessor must PRODUCE modulation: a source (generator) OR
        // another shaper (so shapers chain — shaper.output → next shaper.input).
        if (!hasCap(greg, "modulation_source") && !hasCap(greg, "modulation_shaper"))
          continue;
        const std::string outField = modChannel(greg, 2);  // Output bit
        if (outField.empty()) continue;
        const std::string sKey = chain[i].value("instance_key", std::string());
        const std::string gKey = chain[p].value("instance_key", std::string());
        if (sKey.empty() || gKey.empty()) continue;
        // Explicit wire on the shaper's input suppresses the auto-connect.
        bool alreadyWired = false;
        for (const auto& w : effWires) {
          if (!w.is_object()) continue;
          const json d = w.value("dest", json::object());
          if (d.value("instanceKey", std::string()) == sKey &&
              d.value("field", std::string()) == inField) { alreadyWired = true; break; }
        }
        if (alreadyWired) continue;
        effWires.push_back(json{
          {"id", "__modauto__/" + gKey + "/" + sKey + "/" + inField},
          {"src",  {{"instanceKey", gKey}, {"field", outField}}},
          {"dest", {{"instanceKey", sKey}, {"field", inField}}},
          {"magnitude", "absolute"},
        });
      }
    }

    if (!effWires.empty()) {
      std::unordered_map<std::string, size_t> byKey;
      for (size_t i = 0; i < chain.size(); ++i)
        if (chain[i].is_object())
          byKey[chain[i].value("instance_key", std::string())] = i;
      // Resolve a producer output field's effective polarity, following the
      // shaper-only `magnitude:"inherit"` mode: a shaper's output mirrors the
      // polarity of whatever drives its INPUT channel, walking back through the
      // shaper chain to the originating source. Returns "signed"/"unsigned", or
      // "" when unknown (the caller then defaults to unsigned). Depth-guarded
      // against wire cycles.
      std::function<std::string(const std::string&, const std::string&, int)>
          resolvePolarity = [&](const std::string& key, const std::string& field,
                                int depth) -> std::string {
        if (depth > 16) return std::string();
        auto kit = byKey.find(key);
        if (kit == byKey.end()) return std::string();
        const RegisteredModule* r =
            findSchema(chain[kit->second].value("module_type", std::string()));
        if (!r || !r->schemaFields.is_object()) return std::string();
        std::string decl;
        auto fit = r->schemaFields.find(field);
        if (fit != r->schemaFields.end() && fit->is_object())
          decl = fit->value("magnitude", std::string());
        if (decl == "signed" || decl == "unsigned") return decl;
        if (decl != "inherit") return std::string();
        // Inherit: mirror whatever feeds this shaper's input channel.
        const std::string inField = modChannel(r, 1);   // Input bit
        if (inField.empty()) return std::string();
        for (const auto& w : effWires) {
          if (!w.is_object()) continue;
          const json d = w.value("dest", json::object());
          if (d.value("instanceKey", std::string()) == key &&
              d.value("field", std::string()) == inField) {
            const json s = w.value("src", json::object());
            return resolvePolarity(s.value("instanceKey", std::string()),
                                   s.value("field", std::string()), depth + 1);
          }
        }
        return std::string();   // input unwired → unknown (defaults unsigned)
      };
      for (const auto& w : effWires) {
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
        const std::string srcMt =
            chain[si->second].value("module_type", std::string());
        const RegisteredModule* reg = findSchema(srcMt);
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
          // Source output's declared value range — the sweep range the editor's
          // modulation band samples (Phase: modulationData). srcDef is the
          // producer field def (empty for schema-less dashboard knobs → 0..1).
          rtap["srcMin"] = srcDef.is_object() ? srcDef.value("min", 0.0) : 0.0;
          rtap["srcMax"] = srcDef.is_object() ? srcDef.value("max", 1.0) : 1.0;
          std::string mag = w.value("magnitude", std::string("auto"));
          if (mag != "absolute") {
            // Source output field's effective polarity ("" when none). Follows a
            // shaper output's `magnitude:"inherit"` back to the source that drives
            // its input, so a polarity propagates down a chain of shapers.
            const std::string decl = resolvePolarity(
                src.value("instanceKey", std::string()), srcField, 0);
            if (mag == "auto") {
              // auto → take the source's declared polarity as-is (default unsigned).
              mag = (decl == "signed") ? "signed" : "unsigned";
            } else if (decl == "unsigned" && mag == "signed") {
              // Source EXPLICITLY unipolar [0,1] forced bipolar: prescale the
              // value to [-1,1] (0→-1, 1→1) so it spans the full signed range.
              rtap["preScale"] = 2.0;
              rtap["preBias"] = -1.0;
            } else if (decl == "signed" && mag == "unsigned") {
              // Source EXPLICITLY bipolar [-1,1] forced unipolar: prescale to
              // [0,1] (−1→0, 1→1) so the negative half maps into range.
              rtap["preScale"] = 0.5;
              rtap["preBias"] = 0.5;
            }
            // (No explicit decl, or decl matches the forced mode → no prescale:
            //  the forced polarity is taken at face value, as before.)
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
  const json& sketchRails  = refOr(sketch, "rails",     kEmptyArr, true);

  // Legacy `entry.params` fallback. The canonical place for an effect's field
  // values is instances[key].state, but the older/terser sketch format (and many
  // tests) put them on the chain entry's `params` object instead. The TS executor
  // falls back to entry.params when there's no instance state
  // (sketch-executor.ts: `instances?.[key]?.state ?? entry.params ?? {}`); mirror
  // that here so the unified executor applies them too. Build a merged instances
  // map only when some entry actually needs the fallback (the common canonical
  // case allocates nothing).
  const json& rawInstances = refOr(sketch, "instances", kEmptyObj, false);
  json mergedInstances;
  const json* instancesPtr = &rawInstances;
  {
    bool merged = false;
    for (const auto& col : columns) {
      const json& chain = refOr(col, "chain", kEmptyArr, true);
      for (const auto& e : chain) {
        if (!e.is_object()) continue;
        auto pit = e.find("params");
        if (pit == e.end() || !pit->is_object() || pit->empty()) continue;
        const std::string key = e.value("instance_key", std::string());
        if (key.empty()) continue;
        // Per-FIELD fallback: fill in each entry.params field the canonical state
        // doesn't already have. Must NOT be all-or-nothing — the web host mirrors
        // producers' live OUTPUT scalars into instances[key].state, so a producer
        // (e.g. mod.source.lfo) has partial state {output: ...}; an all-or-nothing skip
        // would then drop its INPUT params (rate/amplitude) and the effect would
        // run at schema defaults. (`*instancesPtr` stays == rawInstances for the
        // whole scan; we only swap to mergedInstances after.)
        const json* st = findState(*instancesPtr, key);
        for (auto it = pit->begin(); it != pit->end(); ++it) {
          if (st && st->contains(it.key())) continue;  // canonical/mirrored wins
          if (!merged) { mergedInstances = rawInstances; merged = true; }
          json& slot = mergedInstances[key];
          if (!slot.is_object()) slot = json::object();
          if (!slot.contains("module_type"))
            slot["module_type"] = e.value("module_type", std::string());
          json& state = slot["state"];
          if (!state.is_object()) state = json::object();
          if (!state.contains(it.key())) state[it.key()] = it.value();
        }
      }
    }
    if (merged) instancesPtr = &mergedInstances;
  }
  const json& instances = *instancesPtr;

  // Compile-once: rebuild the structural plan only when the chain TOPOLOGY
  // actually changed (or first run). `sketchDirty` is a coarse value-dirty flag —
  // it's set on every frame of a continuous slider/knob drag, but those edits
  // change only effect param VALUES, which the plan never caches (they're read
  // live below via applyState + read taps). buildPlan depends purely on topology
  // (module_types, instance_keys, taps-presence, rail defs) + bypass/opacity, all
  // captured by computeStructSig. So we only pay buildPlan's cost (per-entry
  // instanceFor + fusion probes) when that signature shifts — a real add/remove/
  // reorder, wire edit, or bypass/opacity toggle — not on every drag frame. In
  // standalone / steady state nothing edits the sketch and the cached plan is
  // reused untouched. See buildPlan + the PlanColumn cache.
  if (!planValid_) {
    buildPlan(columns, instances, sketchRails);
    planStructSig_ = computeStructSig(columns, instances, sketchRails);
    planValid_ = true;
  } else if (sketchDirty) {
    std::string sig = computeStructSig(columns, instances, sketchRails);
    if (sig != planStructSig_) {
      buildPlan(columns, instances, sketchRails);
      planStructSig_ = std::move(sig);
    }
  }

  intermediate_cursor_ = 0;
  int32_t finalHandle = inputHandle;
  bool anyDispatched = false;
  stats_ = DebugStats{};        // per-frame debug counters (fillDebugStats / tests)
  railState_ = json::object();  // rebuilt per frame; published by the host
  modulationData_ = json::object();  // rebuilt per frame (modulated input bands)
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
    // texture rails); float scalars keyed by railId; GPU storage-buffer handles
    // keyed by leafPath (struct rails only — buffers flow as struct leaves).
    std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>> railTextures;
    std::unordered_map<std::string, float> railFloats;
    std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>> railBuffers;

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
      // Host automation for this instance can drive an otherwise-identity effect
      // off identity this frame, so it must NOT be skipped (like a wired/smoothed
      // entry). Without this, a clip whose param sits at its identity value never
      // runs, and applyAutomation below never gets to change it.
      const bool hasAuto = automationByInstance_.find(instKey) != automationByInstance_.end();
      // A smoothed entry must run the standalone path EVERY frame so its ramp
      // state stays seeded/advanced — even while the (smoothed) value is momentarily
      // identity. Skipping here would leave the SmoothState unseeded, so the first
      // non-identity frame would snap to the new target instead of ramping.
      if (!hasTaps && !hasAuto && !entryHasSmoothing(entry) && inst.isIdentity()) {
        ++stats_.identitySkipped;
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
      // A modulation source (no output texture, e.g. mod.source.lfo) never renders an
      // image — it ticks to publish its scalar/struct outputs and passes the
      // texture chain through untouched. Same path as opacity 0 below. Without
      // this it would render an empty (black) frame over the chain. Mirrors
      // sketch-executor.ts's isTexturePassthrough.
      const bool isModulationSource = reg && !reg->hasTextureOutput;
      const bool willRender = opacity > 0.0f && !isModulationSource;
      inst.setWillRender(willRender);

      if (!willRender) {
        inst.setTextureField("tex_in", colInput);
        inst.setFieldConnected("tex_in", true, false);
        std::unordered_map<std::string, float> modScalars;
        applyReadTaps(inst.h, entry, railsById, railTextures, railFloats,
                      railBuffers, instances, instKey, &modScalars);
        applyAutomation(inst.h, entry, instances, instKey, &modScalars);
        applySmoothing(inst.h, entry, instKey, instances, modScalars, tickDt);
        markWriteTapOutputsConnected(inst.h, entry);
        maybeSeek(inst, entry.value("startSec", 0.0), instKey); // clip-relative seek on activation/back-jump
        inst.doTick(tickDt);
        // A buffer-producing modulation source (e.g. debug.particles_emitter) has
        // no texture output, but its render() UPLOADS its GPU buffers — run it so
        // downstream readers see fresh data. It doesn't touch the chain texture,
        // so the passthrough below still forwards colInput untouched.
        if (reg && reg->hasBufferOutput) inst.doRender(W, H);
        captureWriteTaps(inst.h, entry, instKey, instances,
                         railsById, railTextures, railFloats, railBuffers,
                         &modScalars);
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

      std::unordered_map<std::string, float> modScalars;
      applyReadTaps(inst.h, entry, railsById, railTextures, railFloats,
                    railBuffers, instances, instKey, &modScalars);
      applyAutomation(inst.h, entry, instances, instKey, &modScalars);
      applySmoothing(inst.h, entry, instKey, instances, modScalars, tickDt);
      markWriteTapOutputsConnected(inst.h, entry);

      // -- Positional input slots + per-stage render target (slot-based GPU
      // ABI). Effects like composite.blend read inputTexture(0/1) and
      // renderTarget() rather than textureForField. Slot 0 is the linear chain
      // input; any wire-bound input field overrides its schema slot. Mirrors
      // the web executor's inputTextures construction. setSurface points
      // renderTarget() at this stage's output (the barrel never sets a surface
      // otherwise, so this is also what makes renderTarget() valid at all). --
      {
        std::vector<int32_t> slots;
        slots.push_back(colInput);
        if (reg) {
          // A wire-bound input overrides its schema slot. The dest field may be
          // the schema's NAMED input field (e.g. "tex_a" → slot 0) or a NUMERIC
          // positional index (e.g. "0"/"1") — the editor uses both, and the TS
          // executor accepts either. Scan at least the schema's input fields,
          // checking the named field first then the numeric index for that slot.
          const size_t nSlots =
              std::max<size_t>(reg->slotInputTextureFields.size(), 4);
          for (size_t pi = 0; pi < nSlots; ++pi) {
            int h = (pi < reg->slotInputTextureFields.size())
                      ? inst.textureField(reg->slotInputTextureFields[pi]) : -1;
            if (h <= 0) h = inst.textureField(std::to_string(pi));
            if (h > 0) {
              while (slots.size() <= pi) slots.push_back(-1);
              slots[pi] = h;
            }
          }
        }
        inst.setInputTextureSlots(slots);
      }
      gpu_set_surface(fxHandle, W, H);

      maybeSeek(inst, entry.value("startSec", 0.0), instKey); // clip-relative seek on activation/back-jump
      inst.doTick(tickDt);
      inst.doRender(W, H);
      ++stats_.standaloneDispatches;   // a real per-stage render() dispatch

      captureWriteTaps(inst.h, entry, instKey, instances,
                       railsById, railTextures, railFloats, railBuffers,
                       &modScalars);

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
        // Fused stages are GPU texture effects, never modulation sources (LFO), so none
        // currently has a seek handler — clip-relative startSec isn't threaded here.
        maybeSeek(inst, 0.0, instKey);
        inst.doTick(tickDt);
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
        stats_.identitySkipped += (int)allStages.size();
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
      ++stats_.fusedRuns;        // a real fused-kernel dispatch (not a fallback)
      stats_.fusedStages += (int)stages.size();   // surviving stages folded in
      // Identity stages dropped from THIS (successfully-fused) group are
      // genuinely skipped. Counted here, not at the drop loop, so the pso<=0
      // fallback (which re-runs each stage via runStandalone) doesn't double-count.
      stats_.identitySkipped += (int)(allStages.size() - stages.size());
      finalHandle = groupOutput;
      colInput = groupOutput;
    };

    for (size_t gi = 0; gi < groups.size(); ++gi) {
      const Group& g = groups[gi];
      const bool isLastGroupInCol = (gi == groups.size() - 1);
      // Every resolvable entry this group covers is "processed" exactly once,
      // counted here (not in the lambdas) so a fused group that falls back to
      // per-stage runStandalone doesn't double-count.
      stats_.effectsExecuted += (int)(g.lastK - g.firstK + 1);
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
  // Remember which instances ticked this frame so the NEXT frame can tell which keys
  // are newly activated (and seek them to clip-relative time). A key that dropped out
  // (clip stopped) leaves the set, so re-activation re-seeks.
  knownKeys_.swap(framedKeys);
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
    const std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>>& railBuffers,
    const json& sketchInstances,
    const std::string& instanceKey,
    std::unordered_map<std::string, float>* outModulatedScalars) {
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
  // Running per-field accumulator: multiple read-taps (wires) into the SAME field
  // ACCUMULATE rather than overwrite. The first tap folds from the authored value;
  // each later tap folds from the running result — so e.g. two `add` wires SUM, and
  // a `mul` after an `add` multiplies the sum. Wires were always meant to support
  // multiple connections; without this each tap re-folded from canon and the last
  // `setParamFloat` won (last-wins).
  std::unordered_map<std::string, float> runningFloat;
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
        bool hasCanon = false;
        float canon = 0.0f;
        if (canonState && canonState->contains(fieldPath)) {
          const auto& cv = (*canonState)[fieldPath];
          if (cv.is_number())       { canon = (float)cv.get<double>(); hasCanon = true; }
          else if (cv.is_boolean()) { canon = cv.get<bool>() ? 1.0f : 0.0f; hasCanon = true; }
        }
        // Accumulate: a prior tap on this field already produced a value → fold from
        // it (not the authored canon), so multiple wires stack per their combines.
        auto runIt = runningFloat.find(fieldPath);
        if (runIt != runningFloat.end()) { canon = runIt->second; hasCanon = true; }
        // Wire magnitude mode (resolved during normalization). Present →
        // range-aware fold into [destMin,destMax]; absent → legacy combineTap
        // (the wire's `absolute` mode, or a plain rail tap). Mirrors web's
        // resolveScalarWire: applyMagnitude seeds from min when no canonical.
        // The fold from a raw rail value to the dest value — shared by the live
        // value AND the band sweep so the two can never diverge.
        const tap_mod::Mod mod = parseMod(tap);
        const tap_mod::Combine combine = parseCombine(tap);
        const float mixFactor = tap.value("mixFactor", 1.0f);
        const bool hasMag = tap.contains("magnitude");
        const bool isSigned = tap.value("magnitude", std::string()) == "signed";
        const float dmin = (float)tap.value("destMin", 0.0);
        const float dmax = (float)tap.value("destMax", 1.0);
        // Polarity prescale (identity unless the wire forces signed/unsigned
        // against an opposite EXPLICIT source decl — see normalization).
        // Applied to the raw value BEFORE applyTapMod, so the conversion's
        // affine bias is inside what `scale` multiplies — i.e. `scale` scales
        // the converted swing around its neutral (0 for signed), not after it.
        const float preScale = (float)tap.value("preScale", 1.0);
        const float preBias  = (float)tap.value("preBias", 0.0);
        auto fold = [&](float railVal) -> float {
          const float shaped = tap_mod::applyTapMod(railVal * preScale + preBias, mod);
          return hasMag
              ? tap_mod::applyMagnitude(hasCanon ? canon : dmin, shaped, isSigned,
                                        combine, mixFactor, dmin, dmax)
              : tap_mod::combineTap(hasCanon, canon, shaped, combine, mixFactor);
        };
        float combined = fold(fit->second);
        // Wire DELAY stage — temporal, transitive. Applied AFTER the pure
        // envelope/remap/scale + magnitude fold and BEFORE smoothing (so the
        // smoothing target below is the delayed value). `delay` (seconds) rides
        // the tap's mod object, a sibling of the pure remap/scale/envelope; it's
        // read here rather than in parseMod because it's stateful, not part of
        // the band-sampled `fold`. The band thus reflects the value's range
        // (unchanged by a pure time-shift), while the live marker tracks the
        // delayed value — which always lies within that range.
        const float delaySec = tap.contains("mod") && tap["mod"].is_object()
            ? (float)tap["mod"].value("delay", 0.0) : 0.0f;
        combined = applyModDelay(instanceKey, fieldPath, combined, delaySec);
        runningFloat[fieldPath] = combined; // next tap on this field folds from here
        inst.setParamFloat(fieldPath, combined);
        inst.setFieldConnected(fieldPath, true, false);
        // Hand the smoothing pass this field's post-modulation target.
        if (outModulatedScalars) (*outModulatedScalars)[fieldPath] = combined;
        // Editor telemetry: the effective value + the swing band, sampled over
        // the source output's declared range (default 0..1). Fill anchor =
        // the base the fold modulates from (dmin seeds when no canonical).
        recordModBand(modulationData_, instanceKey, fieldPath, combined,
                      modNeutral(combine, isSigned, hasCanon ? canon : dmin, dmin, dmax),
                      (float)tap.value("srcMin", 0.0),
                      (float)tap.value("srcMax", 1.0), fold);
      }
      continue;
    }

    // Texture/struct read. A struct rail can carry any mix of texture, GPU
    // buffer, and scalar leaves; each kind is routed independently (a struct
    // with only buffer/scalar leaves has no entry in railTextures, so the
    // texture bind must not gate the others).

    // Scalar leaves: the producer's declared value (schema default) flows onto
    // the consumer's nested input field — e.g. particles_out/count → the
    // renderer's particles_in/count. Patched as a float; int/bool effects read
    // it back through their own coercion.
    forEachRailLeafScalar(dataType, [&](const std::string& leaf, double def) {
      const std::string target = leaf.empty() ? fieldPath
                                              : (fieldPath + "/" + leaf);
      inst.setParamFloat(target, (float)def);
    });

    // GPU storage-buffer leaves: bind the producer's published handle (captured
    // this frame). Persistent buffers, so no delayed-copy path.
    auto bufIt = railBuffers.find(railId);
    if (bufIt != railBuffers.end()) {
      forEachRailLeafBuffer(dataType, [&](const std::string& leaf) {
        auto lit = bufIt->second.find(leaf);
        if (lit == bufIt->second.end() || lit->second <= 0) return;
        const std::string target = leaf.empty() ? fieldPath
                                                : (fieldPath + "/" + leaf);
        inst.setBufferField(target, lit->second);
      });
    }

    // Texture leaves: delayed binds the retained 1-frame copy (empty until the
    // producer has run for a full frame — frame 0 degrades to unbound).
    const auto& srcTextures = delayed ? delayedRailTextures_ : railTextures;
    auto texIt = srcTextures.find(railId);
    if (texIt != srcTextures.end()) {
      forEachRailLeafTexture(dataType, [&](const std::string& leaf) {
        auto lit = texIt->second.find(leaf);
        if (lit == texIt->second.end() || lit->second <= 0) return;
        const std::string target = leaf.empty() ? fieldPath
                                                : (fieldPath + "/" + leaf);
        inst.setTextureField(target, lit->second);
      });
    }
    inst.setFieldConnected(fieldPath, true, false);
  }
}

void SketchExecutor::setAutomation(const json& entries) {
  automationByInstance_.clear();
  if (!entries.is_array()) return;
  for (const auto& e : entries) {
    if (!e.is_object()) continue;
    const std::string inst = e.value("instance", std::string());
    if (!inst.empty()) automationByInstance_[inst].push_back(e);
  }
}

void SketchExecutor::applyAutomation(
    int32_t inst_handle, const json& entry, const json& sketchInstances,
    const std::string& instanceKey,
    std::unordered_map<std::string, float>* outModulatedScalars) {
  auto it = automationByInstance_.find(instanceKey);
  if (it == automationByInstance_.end() || !it->second.is_array()) return;
  const EffectRef inst{inst_handle};
  const RegisteredModule* reg = findSchema(entry.value("module_type", std::string()));
  // Authored ("before automation") state — the base a non-replace combine folds
  // from. Read from the serialized JSON (not the runtime), like applyReadTaps, so
  // add/mul don't compound frame-over-frame.
  const json* canonState = nullptr;
  if (sketchInstances.is_object()) {
    auto iit = sketchInstances.find(instanceKey);
    if (iit != sketchInstances.end() && iit->is_object()) {
      auto sit = iit->find("state");
      if (sit != iit->end() && sit->is_object()) canonState = &(*sit);
    }
  }
  for (const auto& a : it->second) {
    if (!a.is_object()) continue;
    const std::string field = a.value("field", std::string());
    if (field.empty()) continue;
    const float value = (float)a.value("value", 0.0);
    // Dest field [min,max] from the schema (defaults 0..1) — the range the
    // normalized curve value maps into, exactly as a wire's destMin/destMax.
    float dmin = 0.0f, dmax = 1.0f;
    if (reg && reg->schemaFields.is_object()) {
      auto f = reg->schemaFields.find(field);
      if (f != reg->schemaFields.end() && f->is_object()) {
        dmin = (float)f->value("min", 0.0);
        dmax = (float)f->value("max", 1.0);
      }
    }
    float canon = dmin;
    bool hasCanon = false;
    if (canonState && canonState->contains(field) && (*canonState)[field].is_number()) {
      canon = (float)(*canonState)[field].get<double>();
      hasCanon = true;
    }
    const tap_mod::Combine combine = parseCombine(a);
    const bool isSigned = a.value("magnitude", std::string("unsigned")) == "signed";
    const float combined = tap_mod::applyMagnitude(
        hasCanon ? canon : dmin, value, isSigned, combine, 1.0f, dmin, dmax);
    inst.setParamFloat(field, combined);
    inst.setFieldConnected(field, true, false);
    if (outModulatedScalars) (*outModulatedScalars)[field] = combined;
  }
}

float SketchExecutor::applyModDelay(const std::string& instanceKey,
                                    const std::string& field,
                                    float value, float delaySec) {
  if (!(delaySec > 0.0f)) {
    // Disabled / non-positive → pass-through. Drop any stale line so a later
    // re-enable starts fresh (mirrors smoothing's erase-on-disable).
    auto iit = delayState_.find(instanceKey);
    if (iit != delayState_.end()) {
      iit->second.erase(field);
      if (iit->second.empty()) delayState_.erase(iit);
    }
    return value;
  }
  auto& line = delayState_[instanceKey][field];
  line.push(modClock_, value);
  return line.read(modClock_ - (double)delaySec);
}

void SketchExecutor::applySmoothing(
    int32_t inst_handle,
    const json& entry,
    const std::string& instanceKey,
    const json& sketchInstances,
    const std::unordered_map<std::string, float>& modulatedScalars,
    double dt) {
  auto foIt = entry.find("fieldOptions");
  const bool hasFO = foIt != entry.end() && foIt->is_object() && !foIt->empty();
  if (!hasFO) {
    // No smoothing config on this entry — drop any stale ramp state so a later
    // re-enable starts settled at the current value (not mid-ramp).
    smoothState_.erase(instanceKey);
    return;
  }
  const EffectRef inst{inst_handle};
  auto& states = smoothState_[instanceKey];
  // Canonical serialized scalars — the target for a smoothed field with no read
  // tap this frame (user param). Stable across frames (it's the persisted value).
  const json* canon = findState(sketchInstances, instanceKey);
  for (auto it = foIt->begin(); it != foIt->end(); ++it) {
    const std::string& field = it.key();
    const json& fo = it.value();
    const json sm = fo.is_object() ? fo.value("smoothing", json()) : json();
    if (!sm.is_object() || !sm.value("enabled", false)) {
      states.erase(field);   // disabled → forget the ramp
      continue;
    }
    const float duration = (float)sm.value("duration", 0.0);
    // Target = the modulated value if a read tap drove it this frame, else the
    // canonical serialized scalar. Skip fields with no defined target.
    float target;
    auto mit = modulatedScalars.find(field);
    if (mit != modulatedScalars.end()) {
      target = mit->second;
    } else if (canon && canon->is_object() && canon->contains(field)) {
      const auto& cv = (*canon)[field];
      if (cv.is_number())       target = (float)cv.get<double>();
      else if (cv.is_boolean()) target = cv.get<bool>() ? 1.0f : 0.0f;
      else { states.erase(field); continue; }
    } else {
      states.erase(field);
      continue;
    }
    auto sit = states.find(field);
    if (sit == states.end()) {
      // First frame for this field: seed settled at the target (no ramp from 0).
      sit = states.emplace(field, param_smoothing::initSmooth(target, duration)).first;
    }
    const float v =
        param_smoothing::advanceSmooth(sit->second, target, duration, (float)dt);
    inst.setParamFloat(field, v);
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
    std::unordered_map<std::string, float>& railFloats,
    std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>>& railBuffers,
    const std::unordered_map<std::string, float>* modulatedScalars) {
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
      bool hasScalar = false;
      float raw = 0.0f;
      // Relay field: if this same field was read-tapped (modulated) this frame,
      // publish the MODULATED value, not the canonical state — so e.g. a
      // dashboard knob driven by an LFO forwards the LFO-modulated result to its
      // output wire. This is exactly what the old runDashboard resolved in one
      // place; a normal effect never read-taps an output field, so it's
      // unaffected.
      if (modulatedScalars) {
        auto mit = modulatedScalars->find(fieldPath);
        if (mit != modulatedScalars->end()) { raw = mit->second; hasScalar = true; }
      }
      // Otherwise the producer's current scalar lives in the sketch's instance
      // state — the editor mirrors it there each frame. The runtime doesn't
      // expose a getParamFloat, so we read the canonical source.
      if (!hasScalar && sketchInstances.is_object() &&
          sketchInstances.contains(producerInstanceKey)) {
        const auto& st = sketchInstances[producerInstanceKey]
                            .value("state", json::object());
        if (st.is_object() && st.contains(fieldPath)) {
          const auto& v = st[fieldPath];
          if (v.is_number())       { raw = (float)v.get<double>(); hasScalar = true; }
          else if (v.is_boolean()) { raw = v.get<bool>() ? 1.0f : 0.0f; hasScalar = true; }
        }
      }
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

    // GPU storage-buffer leaves: record the producer's published handle so the
    // consumer's read-tap can bind it. Buffers are producer-owned + persistent
    // (no recycled-intermediate hazard), so there's no delayed-copy path.
    bool hasBuf = false;
    auto& bufMap = railBuffers[railId];
    forEachRailLeafBuffer(dataType, [&](const std::string& leaf) {
      const std::string source = leaf.empty() ? fieldPath
                                              : (fieldPath + "/" + leaf);
      int32_t h = inst.bufferField(source);
      if (h > 0) { bufMap[leaf] = h; hasBuf = true; }
    });
    if (hasBuf) inst.setFieldConnected(fieldPath, false, true);
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
