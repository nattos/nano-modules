// effrt_impls.cpp — NATIVE implementations of the effrt.h effect-orchestration
// ABI. Maps opaque int32 instance handles to effect_runtime::EffectInstance*
// over the "current" EffectRuntime, and forwards each call to the instance.
//
// Handles are FRAME-LOCAL: effrtSetRuntime() (called by SketchExecutor::execute
// at the top of every frame) clears the table, and effrt_instance_for()
// repopulates it as the executor re-acquires instances. The executor never
// stores handles across frames (it calls instance_for each frame), so this both
// keeps handles consistent within a frame and avoids dangling pointers when a
// sketch edit frees an instance between frames. In the wasm build these symbols
// are replaced by host imports; the runtime is then owned by the host, not set
// from the shared executor code (the effrtSetRuntime call is #ifndef __wasm__).

#include "sketch/effrt.h"

#include <nlohmann/json.hpp>

#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#include "runtime/effect_runtime.h"
#include "runtime/fusion_codegen.h"

using effect_runtime::EffectInstance;
using effect_runtime::EffectRuntime;

namespace {
EffectRuntime* g_rt = nullptr;
std::vector<EffectInstance*> g_byHandle;
std::unordered_map<EffectInstance*, int32_t> g_handleByInst;
std::function<std::string(EffectInstance*)> g_publishedStateFn;

EffectInstance* resolve(int32_t h) {
  return (h >= 0 && h < static_cast<int32_t>(g_byHandle.size())) ? g_byHandle[h]
                                                                 : nullptr;
}
}  // namespace

namespace sketch_executor {
// Point the effrt_* forwarders at `rt` and reset the frame's handle table.
// Called natively by SketchExecutor::execute each frame.
void effrtSetRuntime(EffectRuntime* rt) {
  g_rt = rt;
  g_byHandle.clear();
  g_handleByInst.clear();
}

// See effrt.h — test seam behind effrt_published_scalar / effrt_read_triggers
// (tests synthesize published state as JSON). Default: none → absent.
void effrtSetPublishedStateProvider(std::function<std::string(EffectInstance*)> fn) {
  g_publishedStateFn = std::move(fn);
}
}  // namespace sketch_executor

extern "C" {

int32_t effrt_instance_for(const char* mt, int32_t mt_len,
                           const char* key, int32_t key_len) {
  if (!g_rt) return -1;
  EffectInstance* inst = g_rt->instanceFor(std::string(mt, mt_len),
                                           std::string(key, key_len));
  if (!inst) return -1;
  auto it = g_handleByInst.find(inst);
  if (it != g_handleByInst.end()) return it->second;
  int32_t h = static_cast<int32_t>(g_byHandle.size());
  g_byHandle.push_back(inst);
  g_handleByInst[inst] = h;
  return h;
}

void effrt_set_param_float(int32_t inst, const char* path, int32_t path_len, float v) {
  if (auto* i = resolve(inst)) i->setParamFloat(std::string(path, path_len), v);
}
void effrt_set_param_json(int32_t inst, const char* path, int32_t path_len,
                          const char* json, int32_t json_len) {
  if (auto* i = resolve(inst))
    i->setParamJson(std::string(path, path_len), std::string(json, json_len));
}
void effrt_set_param_array(int32_t inst, const char* path, int32_t path_len,
                           const float* comps, int32_t n) {
  if (auto* i = resolve(inst))
    i->setParamArray(std::string(path, path_len),
                     std::vector<float>(comps, comps + n));
}
void effrt_set_texture_field(int32_t inst, const char* path, int32_t path_len, int32_t tex) {
  if (auto* i = resolve(inst)) i->setTextureField(std::string(path, path_len), tex);
}
int32_t effrt_texture_field(int32_t inst, const char* path, int32_t path_len) {
  auto* i = resolve(inst);
  return i ? i->textureField(std::string(path, path_len)) : -1;
}
void effrt_set_buffer_field(int32_t inst, const char* path, int32_t path_len, int32_t buf) {
  if (auto* i = resolve(inst)) i->setBufferField(std::string(path, path_len), buf);
}
int32_t effrt_buffer_field(int32_t inst, const char* path, int32_t path_len) {
  auto* i = resolve(inst);
  return i ? i->bufferField(std::string(path, path_len)) : 0;
}
void effrt_set_input_texture_slots(int32_t inst, const int32_t* handles, int32_t n) {
  if (auto* i = resolve(inst))
    i->setInputTextureSlots(std::vector<int32_t>(handles, handles + n));
}
void effrt_set_field_connected(int32_t inst, const char* path, int32_t path_len,
                               int32_t input, int32_t output) {
  if (auto* i = resolve(inst))
    i->setFieldConnected(std::string(path, path_len), input != 0, output != 0);
}
void effrt_set_will_render(int32_t inst, int32_t v) {
  if (auto* i = resolve(inst)) i->setWillRender(v != 0);
}
int32_t effrt_published_scalar(int32_t inst, const char* field, int32_t field_len,
                               double* out) {
  auto* i = resolve(inst);
  if (!i || !field || field_len <= 0 || !out) return 0;
  if (g_publishedStateFn) {
    // Test provider (JSON) — cold path, parity with published_state_json.
    auto j = nlohmann::json::parse(g_publishedStateFn(i), nullptr, false);
    if (!j.is_object()) return 0;
    auto it = j.find(std::string(field, (size_t)field_len));
    if (it == j.end()) return 0;
    if (it->is_number())  { *out = it->get<double>(); return 1; }
    if (it->is_boolean()) { *out = it->get<bool>() ? 1.0 : 0.0; return 1; }
    return 0;
  }
  return i->publishedScalar(field, field_len, out) ? 1 : 0;
}

int32_t effrt_read_triggers(int32_t inst, double* out, int32_t cap) {
  auto* i = resolve(inst);
  if (!i || !out || cap <= 0) return -1;
  if (g_publishedStateFn) {
    // Test provider (JSON) — cold path, parity with published_scalar.
    auto j = nlohmann::json::parse(g_publishedStateFn(i), nullptr, false);
    if (!j.is_object()) return -1;
    auto ring = j.find("triggers");
    if (ring == j.end() || !ring->is_array()) return -1;
    return effect_runtime::readTriggersFromRing(*ring, out, cap);
  }
  return i->readTriggers(out, cap);
}

void effrt_tick(int32_t inst, double dt) {
  if (auto* i = resolve(inst)) i->doTick(dt);
}
void effrt_render(int32_t inst, int32_t w, int32_t h) {
  if (auto* i = resolve(inst)) i->doRender(w, h);
}
void effrt_prepare(int32_t inst, int32_t w, int32_t h) {
  if (auto* i = resolve(inst)) i->doPrepare(w, h);
}
void effrt_set_active(int32_t inst, int32_t active) {
  if (auto* i = resolve(inst)) i->doSetActive(active != 0);
}
void effrt_seek(int32_t inst, double from, double to) {
  if (auto* i = resolve(inst)) i->doSeek(from, to);
}
int32_t effrt_is_identity(int32_t inst) {
  auto* i = resolve(inst);
  return (i && i->isIdentity()) ? 1 : 0;
}
int32_t effrt_fusion_kind(int32_t inst) {
  auto* i = resolve(inst);
  return i ? i->fusionInfo().kind : 0;
}
int32_t effrt_fusion_has_prepare(int32_t inst) {
  auto* i = resolve(inst);
  return (i && i->fusionInfo().hasPrepare()) ? 1 : 0;
}
int32_t effrt_fusion_uniform_buffer(int32_t inst) {
  auto* i = resolve(inst);
  return i ? i->fusionInfo().uniformBufferHandle : 0;
}
int32_t effrt_fusion_fragment_name(int32_t inst, char* out, int32_t cap) {
  auto* i = resolve(inst);
  if (!i) return 0;
  const std::string& n = i->fusionInfo().fragmentName;
  int32_t len = static_cast<int32_t>(n.size());
  int32_t copy = len < cap ? len : cap;
  if (out && copy > 0) std::memcpy(out, n.data(), static_cast<size_t>(copy));
  return len;
}

int32_t effrt_build_fused_source(const int32_t* insts, int32_t count,
                                 char* out, int32_t cap, int32_t out_fmt) {
  (void)out_fmt;  // MSL never bakes the storage format; web's WGSL twin does.
  if (!g_rt || count <= 0) return 0;
  // Resolve each stage's registered fragment MSL. Prefer the STABLE per-effect
  // key "<module_type>::<name>" (the bare "pixel" name is shared and overwritten
  // at registration, so a bare lookup could pull another effect's fragment),
  // falling back to the bare name. A miss aborts (the executor falls back to the
  // per-stage path).
  std::vector<std::string> fragments;
  fragments.reserve(static_cast<size_t>(count));
  for (int32_t k = 0; k < count; ++k) {
    EffectInstance* i = resolve(insts[k]);
    if (!i) return 0;
    const std::string& fragName = i->fusionInfo().fragmentName;
    std::string msl;
    if (!g_rt->lookupMSL(i->id() + "::" + fragName, &msl) &&
        !g_rt->lookupMSL(fragName, &msl)) {
      return 0;
    }
    fragments.push_back(std::move(msl));
  }
  // Platform fused codegen (MSL here; the web host emits WGSL).
  std::string src = fusion_codegen::generateFusedMSL(fragments);
  int32_t len = static_cast<int32_t>(src.size());
  if (out && cap > 0) {
    int32_t copy = len < cap ? len : cap;
    if (copy > 0) std::memcpy(out, src.data(), static_cast<size_t>(copy));
  }
  return len;
}

}  // extern "C"
