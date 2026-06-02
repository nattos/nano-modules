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

// Mirrors nano::EffectDesc_v2 — the canonical class-like effect ABI.
// `module_init` runs once per effect TYPE (shaders, shared PSO, schema
// prototype, fusion type metadata). `create` constructs a per-instance
// `State` and returns it as an opaque `self`; the runtime threads `self`
// back through every instance-scoped callback. `destroy` frees it.
struct EffectDesc {
  std::string id;
  std::string name;
  std::string description;
  std::string category;
  std::string keywords;
  void  (*module_init)() = nullptr;
  void* (*create)() = nullptr;
  void  (*destroy)(void* self) = nullptr;
  void  (*init)(void* self) = nullptr;
  void  (*tick)(void* self, double dt) = nullptr;
  void  (*render)(void* self, int vp_w, int vp_h) = nullptr;
  void  (*on_state_patched)(void* self, int n, const char* pb, const int* off,
                            const int* len, const int* ops) = nullptr;
  void  (*on_resolume_param)(void* self, long long param_id, double value) = nullptr;
};

// One EffectInstance per (effect type, sketch instance_key). Each owns the
// effect's per-instance `State` via `user_state_` (allocated by the
// descriptor's create()) plus the per-instance uniform buffer, texture
// wiring, and fusion info. A single "prototype" instance per type (created
// by EffectRuntime::registerEffect) holds the type-level schema/metadata
// and is where module_init's host calls land; it has no user_state and
// never renders. Per-key render instances come from EffectRuntime::
// instanceFor().
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
  // call so the extern-C host impls can route back to this instance, and
  // threads `user_state_` into the descriptor's instance callbacks.
  //
  // doModuleInit runs the type-level setup on the prototype instance
  // (once per effect type). doCreate allocates user_state_ + runs the
  // per-instance init() tail. The two are split so module-level resources
  // (shaders, shared PSO, schema) are created exactly once.
  void doModuleInit();
  void doCreate();
  void doDestroy();
  void doTick(double dt);
  void doRender(int vp_w, int vp_h);
  // Drive only the per-frame uniform-buffer write (no dispatch). The
  // fusion path uses this in place of doRender so the executor can
  // batch N effects' uniforms + a single compute dispatch. No-op if
  // the effect didn't register fusion info.
  void doPrepare(int vp_w, int vp_h);

  void* userState() const { return user_state_; }

  // --- Fusion metadata ---
  // Populated when the effect calls state::registerFusionByName(...)
  // inside its init(). Effects that never register stay
  // FusionKind::Freeform (=0) and the executor runs their standalone
  // doRender() path.
  struct FusionInfo {
    int  kind = 0;                       // mirrors state::FusionKind
    std::string fragmentName;            // shader-module name (the "pixel" SPV/MSL)
    int  uniformBufferHandle = 0;        // gpu buffer id the effect wrote on registration
    int  uniformSizeBytes = 0;
    void (*prepare)(void*, int, int) = nullptr; // per-frame uniform writer; called by the fusion path instead of render()
  };
  const FusionInfo& fusionInfo() const { return fusion_info_; }
  void setFusionInfo(FusionInfo info) { fusion_info_ = std::move(info); }

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
  void hostSetOnStateReady(void (*fn)(void* self));

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

  // Per-instance state object returned by desc_.create(), threaded into
  // every instance-scoped callback as `self`. Null on the type prototype
  // (which only runs module_init) and on effects without a create().
  void* user_state_ = nullptr;

  std::string metadata_id_;
  std::string metadata_version_;
  std::string schema_json_;
  void (*on_state_ready_)(void* self) = nullptr;

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
  FusionInfo fusion_info_;

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

  // Register an effect TYPE. Creates the type's prototype instance and
  // runs its module_init() once (registering shaders, the shared PSO,
  // and the schema prototype). The descriptor is captured by value; its
  // function pointers must remain valid for the runtime's lifetime (they
  // typically point at namespaced effect functions, fine for static
  // linkage). Returns the prototype (used by the registry to read schema).
  EffectInstance* registerEffect(const EffectDesc& desc);

  // Look up the type prototype by id. Returns nullptr if not registered.
  EffectInstance* find(const std::string& id);

  // Get (creating on first use) the per-key render instance for a given
  // effect type + sketch instance_key. Lazily allocates the instance's
  // user_state via create() and runs its init() tail. Returns nullptr if
  // the type isn't registered. The returned pointer is owned by the
  // runtime and stays valid until destroyInstance / runtime teardown.
  EffectInstance* instanceFor(const std::string& type,
                              const std::string& instanceKey);

  // Destroy a pooled per-key instance (calls desc.destroy on its
  // user_state). Caller must ensure the GPU is idle. No-op if absent.
  void destroyInstance(const std::string& type, const std::string& instanceKey);

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
  // route through this. During module_init this is the type prototype;
  // during a per-key instance's lifecycle it's that instance.
  EffectInstance* active() const { return active_; }

 private:
  friend class EffectInstance;
  void setActive(EffectInstance* inst) { active_ = inst; }

  static std::string poolKey(const std::string& type,
                             const std::string& instanceKey) {
    return type + "|" + instanceKey;
  }

  gpu::GPUBackend* gpu_;
  // Type prototypes (one per effect type). Own the type-level schema +
  // module_init side effects.
  std::vector<std::unique_ptr<EffectInstance>> effects_;
  std::unordered_map<std::string, EffectInstance*> by_id_;
  // Per-(type, instance_key) render instances, created lazily.
  std::unordered_map<std::string, std::unique_ptr<EffectInstance>> instance_pool_;
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
