// effect_runtime.h — in-process implementation of the effect host API.
//
// Effects' main.cpp files #include <host.h> + <gpu.h>, which declare a
// large surface of extern-C functions that are WASM imports under the
// `__wasm32__` build but plain externs in a native build. This runtime
// provides native definitions for those extern-Cs and wires them to
// the Metal GPUBackend, so the same effect source compiles + links + runs
// without WASM in the loop.
//
// Designed for the FFGL plugin path (statically-linked effects + Metal +
// FFGL bundle) and for the dual-backend test runner CLI. Both consumers
// instantiate one `EffectRuntime`, register the effects they want to use,
// activate one at a time, and drive its tick / render lifecycle.

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace gpu { class GPUBackend; }

namespace effect_runtime {

// Mirrors nano::EffectDesc_v1 — what the bundle's nano_module_main
// registers per effect via the imported `nano_register_effect`.
struct EffectDesc {
  std::string id;
  std::string name;
  std::string description;
  std::string category;
  std::string keywords;
  void (*init)() = nullptr;
  void (*tick)(double dt) = nullptr;
  void (*render)(int vp_w, int vp_h) = nullptr;
  void (*on_state_patched)(int n, const char* pb, const int* off,
                           const int* len, const int* ops) = nullptr;
  void (*on_resolume_param)(long long param_id, double value) = nullptr;
};

// Per-effect state owned by the runtime. There's one instance per
// registered effect (registry-key = effect id); since effects use file-
// static state (`static int s_blob_count`, etc.), reusing the same effect
// from multiple instances would collide — single-instance-per-effect-id is
// a hard invariant.
class EffectInstance {
 public:
  // Owning runtime + effect descriptor are set at construction.
  EffectInstance(class EffectRuntime* rt, EffectDesc desc);
  ~EffectInstance();

  const std::string& id() const { return desc_.id; }
  const std::string& schemaJson() const { return schema_json_; }
  const std::string& metadataId() const { return metadata_id_; }
  const std::string& metadataVersion() const { return metadata_version_; }

  // Lifecycle — runtime sets the active instance pointer before each
  // call so the extern-C host impls can route back to this instance.
  void doInit();
  void doTick(double dt);
  void doRender(int vp_w, int vp_h);

  // Push a single replacement patch through on_state_patched. Pass the
  // field path (e.g. "intensity") and a JSON value.
  void setParamJson(const std::string& path, const std::string& jsonValue);
  // Convenience for scalar floats.
  void setParamFloat(const std::string& path, float value);
  // Convenience for vec/color params — value is a JSON array string,
  // e.g. "[1.0, 0.5, 0.25]". Caller is expected to format correctly.
  void setParamArray(const std::string& path, const std::vector<float>& components);

  // Texture/buffer wiring — populated externally before render. The
  // effect reads via `gpu::Device::textureForField(name)`, which the
  // runtime routes here.
  void setTextureField(const std::string& path, int textureHandle);
  void setBufferField(const std::string& path, int bufferHandle);
  int  textureField(const std::string& path) const;
  int  bufferField(const std::string& path) const;
  // For state::isOutputConnected / isInputConnected — runtime caller
  // (FFGL plugin / CLI) sets known-connected fields up-front.
  void setFieldConnected(const std::string& path, bool input, bool output);
  bool isInputConnected(const std::string& path) const;
  bool isOutputConnected(const std::string& path) const;

  // --- host-import callback storage ---
  // Effects call these via host imports during init/tick/render. The
  // runtime sets `g_active` before calling into the effect so the
  // extern-C symbols route here.
  void hostSetMetadata(std::string id, std::string version);
  void hostSetSchema(std::string schemaJson);
  void hostRegisterShaderSpv(std::string_view name,
                             const unsigned char* spv, int spv_len,
                             std::string_view format,
                             std::string_view access);
  void hostSetOnStateReady(void (*fn)(void));

  // Patch reading — driven by setParam* methods. Held only for the
  // duration of doOnStatePatched. The path buffer (pb) and arrays
  // outlive the on_state_patched call.
  struct PendingPatch {
    std::string path;
    int op;  // 0=Add 1=Remove 2=Replace 3=Move 4=Copy
    std::string valueJson;
  };

  // Patch value access — public so host_impls.cpp's extern-C
  // state_get_patch can dispatch into the active instance's pending
  // patch JSON without needing friend access.
  std::string val_to_json(int handle) const;

 private:
  void firePatched(const std::vector<PendingPatch>& patches);
  friend class EffectRuntime;
  friend struct HostBridge;

  EffectRuntime* runtime_;
  EffectDesc desc_;

  std::string metadata_id_;
  std::string metadata_version_;
  std::string schema_json_;
  void (*on_state_ready_)(void) = nullptr;

  std::unordered_map<std::string, int> texture_fields_;
  std::unordered_map<std::string, int> buffer_fields_;
  std::unordered_map<std::string, bool> connected_inputs_;
  std::unordered_map<std::string, bool> connected_outputs_;

  // Set by hostRegisterShaderSpv — keyed by name, resolved by
  // gpu::Device::createShaderModuleByName.
  struct RegisteredShader {
    std::vector<unsigned char> spv;
    std::string format;
    std::string access;
  };
  std::unordered_map<std::string, RegisteredShader> shaders_by_name_;

  // val_* handle table — JSON values addressed by opaque int handles,
  // released explicitly. Populated by hostBeginPatchTransaction so
  // state::getPatch / patchFloat / patchVec* can walk patch values.
  // Implementation lives in effect_runtime.cpp.
  std::vector<std::string> val_strings_;       // for asString
  std::vector<std::string> val_blobs_;         // owned JSON serializations
  int val_alloc(std::string_view jsonValue);
};

// One runtime per process is the typical case (FFGL plugin or CLI).
// Multiple is allowed if the caller takes care never to interleave
// activations across runtimes (we use a static `g_active` pointer for
// the extern-C dispatchers).
class EffectRuntime {
 public:
  explicit EffectRuntime(gpu::GPUBackend* gpu);
  ~EffectRuntime();

  gpu::GPUBackend* gpu() { return gpu_; }

  // Register an effect descriptor. The descriptor is captured by value;
  // its function pointers must remain valid for the runtime's lifetime
  // (they typically point at namespaced effect functions, which is fine
  // for static-linkage builds).
  EffectInstance* registerEffect(const EffectDesc& desc);

  // Look up by id. Returns nullptr if not registered.
  EffectInstance* find(const std::string& id);

  // The bundle's nano_module_main calls `nano_register_effect`, which
  // routes here. The runtime expects bundles to be initialized via
  // direct C++ entry points (effect namespaces' `init()`s) rather than
  // via nano_module_main — but if a bundle's main IS used, this hook
  // captures the descriptors.
  void registerFromDesc(const void* desc_v1_ptr);

  // Pre-register MSL source for a shader name. When an effect later
  // calls state::registerShaderSPV(name, spv, ...), the runtime
  // ignores the SPV bytes and uses the pre-registered MSL string for
  // Metal shader module creation. Build pipeline emits these alongside
  // the SPV blobs.
  void registerShaderMSL(const std::string& name, std::string msl);
  bool lookupMSL(const std::string& name, std::string* out) const;

  // Console log capture — every state::log call appends here, runtime
  // user (CLI / FFGL plugin) can drain after each render.
  void log(std::string_view level, std::string_view message);
  std::vector<std::string> drainConsoleLog();

  // Internal — set by activate*() pre/post hooks. extern-C host impls
  // route through this.
  EffectInstance* active() const { return active_; }

 private:
  friend class EffectInstance;
  void setActive(EffectInstance* inst) { active_ = inst; }

  gpu::GPUBackend* gpu_;
  std::vector<std::unique_ptr<EffectInstance>> effects_;
  std::unordered_map<std::string, EffectInstance*> by_id_;
  std::unordered_map<std::string, std::string> msl_by_name_;
  std::vector<std::string> console_log_;
  EffectInstance* active_ = nullptr;
};

// Global process-wide runtime pointer. extern-C host imports reference
// this. Set/cleared by EffectRuntime ctor/dtor — only one runtime should
// exist at a time. Provided for the FFGL plugin path and the CLI; tests
// embedding multiple runtimes need to be serialized externally.
EffectRuntime* currentRuntime();
void setCurrentRuntime(EffectRuntime* rt);

}  // namespace effect_runtime
