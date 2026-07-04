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
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "wasm/effect_host_sink.h"

namespace gpu { class GPUBackend; }
namespace wasm { class WasmHost; }

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
  // Optional pure passthrough predicate (see nano::EffectDesc_v2::is_identity).
  // Returns nonzero when the current state makes the effect an identity;
  // the executor then skips its dispatch and aliases input→output. Only
  // valid for stateless effects.
  int32_t (*is_identity)(void* self) = nullptr;
  // Optional device on/off transition callback (see nano::EffectDesc_v2::on_active).
  // active=1 turned ON, 0 turned OFF. Fired only on a change.
  void (*on_active)(void* self, int32_t active) = nullptr;
  // Optional seek/prefill (see nano::EffectDesc_v2::seek). Drives a stateful
  // effect to `to` time as if it had run from `from`. Only valid for effects
  // declaring the `seekable_prefill` capability. nullptr = not seekable.
  void (*seek)(void* self, double from_seconds, double to_seconds) = nullptr;

  // --- WASM-backed dispatch (barrel-loads-WASM migration) ---
  // When `wasm_host` is non-null this descriptor is WASM-backed: the
  // EffectInstance drives the lifecycle through WasmHost::call_indirect on the
  // function-table indices in `wasm_fns` (keyed by callback NAME, captured from
  // the bundle's name-keyed registration) instead of the native function
  // pointers above, which stay null. `user_state_` then holds the wasm State*
  // (a linear-memory offset) returned by create(). Host imports during these
  // calls are served by host_functions.cpp and routed to this instance via
  // WasmHost::set_effect_instance (the WASM analogue of setActive). Adding a
  // new hook needs only a name here + a wfn("...") call site in the dispatch.
  wasm::WasmHost* wasm_host = nullptr;
  int32_t wasm_module_id = -1;
  std::unordered_map<std::string, uint32_t> wasm_fns;
  bool isWasm() const { return wasm_host != nullptr; }
  // Table index for a named WASM callback, or 0 ("not provided").
  uint32_t wfn(const char* name) const {
    auto it = wasm_fns.find(name);
    return it != wasm_fns.end() ? it->second : 0u;
  }
};

// One EffectInstance per (effect type, sketch instance_key). Each owns the
// effect's per-instance `State` via `user_state_` (allocated by the
// descriptor's create()) plus the per-instance uniform buffer, texture
// wiring, and fusion info. A single "prototype" instance per type (created
// by EffectRuntime::registerEffect) holds the type-level schema/metadata
// and is where module_init's host calls land; it has no user_state and
// never renders. Per-key render instances come from EffectRuntime::
// instanceFor().
class EffectInstance : public wasm::EffectHostSink {
 public:
  // Owning runtime + effect descriptor are set at construction.
  EffectInstance(class EffectRuntime* rt, EffectDesc desc);
  ~EffectInstance() override;

  const std::string& id() const { return desc_.id; }
  const std::string& schemaJson() const { return schema_json_; }
  // True if this (prototype) effect's WASM module_init trapped during
  // registration. A trapped module_init both fails to finish its own type-level
  // setup AND poisons later effects in the same shared bundle instance (the C
  // stack pointer is left un-unwound), so they trap too — surfacing this is the
  // fast way to diagnose an incomplete host ABI. See doModuleInit.
  bool moduleInitTrapped() const { return module_init_trapped_; }
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
  // Publish the positional input-texture slots for this frame's render. Slot N
  // backs gpu::Device::inputTexture(N). For a WASM effect this forwards into
  // the module's WasmContext; for a native effect it's a no-op (native effects
  // resolve inputs via setActive/textureField). The executor calls this just
  // before doRender (and doPrepareUniforms for the fused path).
  void setInputTextureSlots(const std::vector<int32_t>& handles);
  // Drive the device on/off ("bypass") state. Fires the descriptor's
  // on_active callback only on a transition. New instances start active, so
  // the first doSetActive(false) fires an OFF; re-enabling fires an ON.
  void doSetActive(bool active);
  // Drive the optional seek/prefill (desc.seek / wfn("seek")). No-op when the
  // effect doesn't export seek. Only valid for `seekable_prefill` effects.
  // See nano::EffectDesc_v2::seek. No executor caller yet (declared ABI).
  void doSeek(double from_seconds, double to_seconds);
  bool active() const { return active_; }
  // Per-frame "will this effect's output be drawn" flag, set by the executor
  // before doTick(). False when opacity is 0 (render is skipped). Read by the
  // effect via state::willRender().
  void setWillRender(bool v) { will_render_ = v; }
  bool willRender() const override { return will_render_; }
  // Drive only the per-frame uniform-buffer write (no dispatch). The
  // fusion path uses this in place of doRender so the executor can
  // batch N effects' uniforms + a single compute dispatch. No-op if
  // the effect didn't register fusion info.
  void doPrepare(int vp_w, int vp_h);

  void* userState() const { return user_state_; }

  // Pure passthrough query — true when the effect's descriptor supplies
  // an is_identity predicate AND it reports the current state is an
  // identity (output == primary input). The executor uses this to skip
  // the dispatch and alias input→output. False when no predicate is set.
  // Side-effect free; safe to call after state has been applied.
  bool isIdentity();

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
    void (*prepare)(void*, int, int) = nullptr; // native per-frame uniform writer
    // WASM-backed effects supply `prepare` as a function-table index instead of
    // a native pointer; doPrepare call_indirects it. 0 = none.
    uint32_t wasmPrepareIdx = 0;
    // True when this effect supplies a prepare callback (native or wasm) — the
    // executor's fusion-eligibility gate.
    bool hasPrepare() const { return prepare != nullptr || wasmPrepareIdx != 0; }
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
  void setTextureField(const std::string& path, int textureHandle) override;
  void setBufferField(const std::string& path, int bufferHandle) override;
  int  textureField(const std::string& path) const override;
  int  bufferField(const std::string& path) const override;
  // For state::isOutputConnected / isInputConnected — runtime caller
  // (FFGL plugin / CLI) sets known-connected fields up-front.
  void setFieldConnected(const std::string& path, bool input, bool output);
  bool isInputConnected(const std::string& path) const override;
  bool isOutputConnected(const std::string& path) const override;
  // Positional input slot lookup (native static path reads this via the
  // active() instance; the WASM path reads its WasmContext copy). Returns -1
  // when the slot is unset, matching the gpu.get_input_texture contract.
  int  inputTextureSlot(int idx) const {
    return (idx >= 0 && idx < (int)input_texture_slots_.size())
        ? input_texture_slots_[idx] : -1;
  }
  int  inputTextureSlotCount() const { return (int)input_texture_slots_.size(); }

  // --- host-import callback storage ---
  // Effects call these via host imports during init/tick/render. The
  // runtime sets `g_active` before calling into the effect so the
  // extern-C symbols route here.
  void hostSetMetadata(std::string id, std::string version) override;
  void hostSetSchema(std::string schemaJson) override;
  void hostSetVal(std::string_view path, std::string_view valueJson) override;
  // The accumulated set_val outputs as a JSON object string ("" when the
  // effect has published nothing). Backs effrt_published_state_json and the
  // barrel's per-frame plugin_states publish.
  std::string publishedStateJson() const;
  void hostRegisterShaderSpv(std::string_view name,
                             const unsigned char* spv, int spv_len,
                             std::string_view format,
                             std::string_view access) override;
  int createShaderModuleByName(const std::string& name,
                               gpu::GPUBackend* backend) override;
  void hostRegisterWasmFusion(int kind, std::string fragmentName,
                              int uniformBufferHandle, int uniformSizeBytes,
                              uint32_t prepareIdx) override;
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

  // --- WASM driver helpers (no-ops on native-backed descriptors) ---
  // The current user_state_ as a wasm32 linear-memory offset (the State* an
  // effect's create() returned), to pass as `self` to lifecycle calls.
  uint32_t wasmSelf() const {
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(user_state_));
  }
  // Invoke a WASM lifecycle function by table index with packed argv, bracketed
  // by set_effect_instance(this)/clear so host imports route here. No-op
  // (returns 0) when fnIdx is 0 (function not supplied). Returns argv[0].
  uint32_t driveWasm(uint32_t fnIdx, uint32_t argc, uint32_t argv[]);

  friend class EffectRuntime;
  friend struct HostBridge;

  EffectRuntime* runtime_;
  EffectDesc desc_;

  // Per-instance state object returned by desc_.create(), threaded into
  // every instance-scoped callback as `self`. Null on the type prototype
  // (which only runs module_init) and on effects without a create().
  void* user_state_ = nullptr;

  // Device on/off state. Starts active (true); doSetActive fires the
  // on_active callback on transitions only.
  bool active_ = true;
  // Per-frame render-skip flag (see setWillRender). Defaults true.
  bool will_render_ = true;

  std::string metadata_id_;
  std::string metadata_version_;
  std::string schema_json_;
  bool module_init_trapped_ = false;
  void (*on_state_ready_)(void* self) = nullptr;

  // Live set_val outputs: field → JSON value serialization. Ordered so the
  // serialized object is byte-stable across frames (dedup by comparison).
  std::map<std::string, std::string> published_;

  std::unordered_map<std::string, int> texture_fields_;
  std::unordered_map<std::string, int> buffer_fields_;
  std::unordered_map<std::string, bool> connected_inputs_;
  std::unordered_map<std::string, bool> connected_outputs_;
  // Positional input texture slots (gpu::Device::inputTexture(N)). Republished
  // by the executor each frame via setInputTextureSlots.
  std::vector<int32_t> input_texture_slots_;

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

  // Look up an existing pooled per-key instance WITHOUT creating one.
  // Telemetry readers (the barrel's plugin_states publish) must never
  // instantiate — the executor owns instance creation as it renders.
  EffectInstance* findInstance(const std::string& type,
                               const std::string& instanceKey);

  // Destroy a pooled per-key instance (calls desc.destroy on its
  // user_state). Caller must ensure the GPU is idle. No-op if absent.
  void destroyInstance(const std::string& type, const std::string& instanceKey);

  // Destroy every pooled instance whose instance_key begins with `prefix` (the
  // namespace a SketchExecutor was given via setKeyNamespace). Frees one
  // barrel's effect state from the SHARED pool on teardown. Caller must ensure
  // the GPU is idle.
  void destroyInstancesWithKeyPrefix(const std::string& prefix);

  // Live count of pooled per-(type, instance_key) render instances. Introspection
  // for tests proving instance-key namespacing keeps barrels isolated in the
  // shared pool (two namespaces × one bare key → two distinct instances).
  size_t instancePoolSize() const { return instance_pool_.size(); }

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
