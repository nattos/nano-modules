// effect_runtime.cpp — runtime + EffectInstance implementations.
//
// See header for design notes. Pairs with host_impls.cpp + gpu_impls.cpp
// which provide the extern-C symbols effects link against.

#include "runtime/effect_runtime.h"

#include <cstring>
#include <iostream>
#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/spv_to_msl.h"
#include "wasm/wasm_host.h"

namespace effect_runtime {

namespace {
// Process-wide pointer used by the extern-C host stubs to route calls
// back to the runtime + currently-active instance. Single-runtime is
// the supported configuration (FFGL plugin, CLI). Tests embedding
// multiple runtimes must serialize externally.
EffectRuntime* g_runtime = nullptr;
}  // namespace

EffectRuntime* currentRuntime() { return g_runtime; }
void setCurrentRuntime(EffectRuntime* rt) { g_runtime = rt; }

// --- EffectInstance ---

EffectInstance::EffectInstance(EffectRuntime* rt, EffectDesc desc)
    : runtime_(rt), desc_(std::move(desc)) {}

EffectInstance::~EffectInstance() {
  // Per-key instances own their user_state; the prototype never has one.
  if (user_state_) doDestroy();
}

uint32_t EffectInstance::driveWasm(uint32_t fnIdx, uint32_t argc, uint32_t argv[]) {
  if (!fnIdx || !desc_.wasm_host) return 0;
  desc_.wasm_host->set_effect_instance(desc_.wasm_module_id, this);
  bool ok = desc_.wasm_host->call_indirect(desc_.wasm_module_id, fnIdx, argc, argv);
  desc_.wasm_host->set_effect_instance(desc_.wasm_module_id, nullptr);
  return ok ? argv[0] : 0u;
}

void EffectInstance::doModuleInit() {
  // Type-level setup: register shaders, create the shared PSO, publish
  // the schema prototype. Routed to this (prototype) instance so state::*
  // host calls land here (setActive for native, effect_instance for WASM).
  if (desc_.isWasm()) {
    uint32_t argv[4] = {0};
    desc_.wasm_host->set_effect_instance(desc_.wasm_module_id, this);
    bool ok = desc_.wasm_host->call_indirect(desc_.wasm_module_id,
                                             desc_.w_module_init, 0, argv);
    desc_.wasm_host->set_effect_instance(desc_.wasm_module_id, nullptr);
    if (!ok) {
      // A trapped module_init can't be cleanly contained (WAMR doesn't unwind
      // the C stack pointer on a trap, and effects keep type-level state — PSO
      // handles etc. — in the shared instance, so re-instantiating to clear the
      // leak would wipe earlier effects' setup). The realistic defense is to make
      // the trap LOUD: this both fails this effect's own setup and poisons every
      // effect registered after it in the same bundle (they trap on the leaked
      // stack and silently publish empty schemas). The usual cause is an
      // incomplete host ABI — an effect calling a gpu/state import the bundles
      // host never registered. The exception text names the missing symbol.
      module_init_trapped_ = true;
      fprintf(stderr,
              "[nano] WARNING: effect '%s' module_init trapped: %s\n"
              "       Effects registered after it in this bundle may fail to "
              "publish their schema. Likely an unregistered host import — "
              "complete the bundles host ABI.\n",
              desc_.id.c_str(), desc_.wasm_host->last_error().c_str());
    }
    return;
  }
  runtime_->setActive(this);
  if (desc_.module_init) desc_.module_init();
  runtime_->setActive(nullptr);
}

void EffectInstance::doCreate() {
  if (desc_.isWasm()) {
    // create() returns the State* (a wasm offset); init() applies defaults.
    uint32_t argv[4] = {0};
    user_state_ = reinterpret_cast<void*>(
        static_cast<uintptr_t>(driveWasm(desc_.w_create, 0, argv)));
    argv[0] = wasmSelf();
    driveWasm(desc_.w_init, 1, argv);
    // NOTE: on_state_ready for WASM effects is deferred — it arrives via the
    // state.set_on_state_ready host import, part of the remaining ABI surface.
    return;
  }
  runtime_->setActive(this);
  if (desc_.create) user_state_ = desc_.create();
  // Per-instance init tail: defaults, fusion registration with THIS
  // instance's uniform buffer, blob seeding, etc.
  if (desc_.init) desc_.init(user_state_);
  // Fire the on_state_ready hook if set during init (mirrors the host's
  // post-init + post-state-replay callback).
  if (on_state_ready_) on_state_ready_(user_state_);
  runtime_->setActive(nullptr);
}

void EffectInstance::doDestroy() {
  if (!user_state_) return;
  if (desc_.isWasm()) {
    uint32_t argv[4] = {wasmSelf()};
    driveWasm(desc_.w_destroy, 1, argv);
    user_state_ = nullptr;
    return;
  }
  runtime_->setActive(this);
  if (desc_.destroy) desc_.destroy(user_state_);
  runtime_->setActive(nullptr);
  user_state_ = nullptr;
}

void EffectInstance::doTick(double dt) {
  if (desc_.isWasm()) {
    // tick(self, dt): self i32 @argv[0], dt f64 @argv[1..2] (packed).
    uint32_t argv[4] = {wasmSelf()};
    std::memcpy(&argv[1], &dt, sizeof(double));
    driveWasm(desc_.w_tick, 3, argv);
    return;
  }
  runtime_->setActive(this);
  if (desc_.tick) desc_.tick(user_state_, dt);
  runtime_->setActive(nullptr);
}

void EffectInstance::setInputTextureSlots(const std::vector<int32_t>& handles) {
  input_texture_slots_ = handles;
  // WASM effects read the slots from their module's WasmContext (the host
  // import gpu.get_input_texture indexes ctx->input_texture_handles). Native
  // effects read input_texture_slots_ directly via active() in gpu_impls.
  if (desc_.isWasm() && desc_.wasm_host) {
    desc_.wasm_host->set_input_texture_handles(desc_.wasm_module_id, handles);
  }
}

void EffectInstance::doRender(int vp_w, int vp_h) {
  if (desc_.isWasm()) {
    uint32_t argv[4] = {wasmSelf(), static_cast<uint32_t>(vp_w),
                        static_cast<uint32_t>(vp_h)};
    driveWasm(desc_.w_render, 3, argv);
    return;
  }
  runtime_->setActive(this);
  if (desc_.render) desc_.render(user_state_, vp_w, vp_h);
  runtime_->setActive(nullptr);
}

void EffectInstance::doSetActive(bool active) {
  if (active == active_) return;
  active_ = active;
  if (desc_.isWasm()) {
    if (desc_.w_on_active) {
      uint32_t argv[4] = {wasmSelf(), static_cast<uint32_t>(active ? 1 : 0)};
      driveWasm(desc_.w_on_active, 2, argv);
    }
    return;
  }
  if (desc_.on_active) {
    runtime_->setActive(this);
    desc_.on_active(user_state_, active ? 1 : 0);
    runtime_->setActive(nullptr);
  }
}

void EffectInstance::doSeek(double from, double to) {
  if (desc_.isWasm()) {
    if (!desc_.w_seek) return;
    // seek(self, from, to): self i32 @argv[0], from f64 @argv[1..2],
    // to f64 @argv[3..4] (both doubles packed little-endian).
    uint32_t argv[5] = {wasmSelf()};
    std::memcpy(&argv[1], &from, sizeof(double));
    std::memcpy(&argv[3], &to, sizeof(double));
    driveWasm(desc_.w_seek, 5, argv);
    return;
  }
  if (desc_.seek) {
    runtime_->setActive(this);
    desc_.seek(user_state_, from, to);
    runtime_->setActive(nullptr);
  }
}

void EffectInstance::doPrepare(int vp_w, int vp_h) {
  if (desc_.isWasm()) {
    if (!fusion_info_.wasmPrepareIdx) return;
    uint32_t argv[4] = {wasmSelf(), static_cast<uint32_t>(vp_w),
                        static_cast<uint32_t>(vp_h)};
    driveWasm(fusion_info_.wasmPrepareIdx, 3, argv);
    return;
  }
  if (!fusion_info_.prepare) return;
  runtime_->setActive(this);
  fusion_info_.prepare(user_state_, vp_w, vp_h);
  runtime_->setActive(nullptr);
}

bool EffectInstance::isIdentity() {
  if (desc_.isWasm()) {
    if (!desc_.w_is_identity) return false;
    uint32_t argv[4] = {wasmSelf()};
    return driveWasm(desc_.w_is_identity, 1, argv) != 0;
  }
  if (!desc_.is_identity) return false;
  // Set the active pointer for parity with the other lifecycle calls, in
  // case a predicate reads host state (e.g. isInputConnected). The
  // predicate must be side-effect free.
  runtime_->setActive(this);
  int32_t r = desc_.is_identity(user_state_);
  runtime_->setActive(nullptr);
  return r != 0;
}

void EffectInstance::setTextureField(const std::string& path, int handle) {
  texture_fields_[path] = handle;
}
void EffectInstance::setBufferField(const std::string& path, int handle) {
  buffer_fields_[path] = handle;
}
int EffectInstance::textureField(const std::string& path) const {
  auto it = texture_fields_.find(path);
  return it != texture_fields_.end() ? it->second : -1;
}
int EffectInstance::bufferField(const std::string& path) const {
  auto it = buffer_fields_.find(path);
  return it != buffer_fields_.end() ? it->second : -1;
}

void EffectInstance::setFieldConnected(const std::string& path,
                                       bool input, bool output) {
  connected_inputs_[path] = input;
  connected_outputs_[path] = output;
}
bool EffectInstance::isInputConnected(const std::string& path) const {
  auto it = connected_inputs_.find(path);
  return it != connected_inputs_.end() && it->second;
}
bool EffectInstance::isOutputConnected(const std::string& path) const {
  auto it = connected_outputs_.find(path);
  return it != connected_outputs_.end() && it->second;
}

void EffectInstance::hostSetMetadata(std::string id, std::string version) {
  metadata_id_ = std::move(id);
  metadata_version_ = std::move(version);
}
void EffectInstance::hostSetSchema(std::string schemaJson) {
  schema_json_ = std::move(schemaJson);
}
void EffectInstance::hostRegisterShaderSpv(std::string_view name,
                                            const unsigned char* spv,
                                            int spv_len,
                                            std::string_view format,
                                            std::string_view access) {
  RegisteredShader& slot = shaders_by_name_[std::string(name)];
  slot.spv.assign(spv, spv + spv_len);
  slot.format = std::string(format);
  slot.access = std::string(access);
  // Also publish the SPV→MSL under the runtime's "<moduleType>::<name>" key so
  // the executor's fusion path (which looks up the "pixel" fragment MSL via
  // EffectRuntime::lookupMSL, exactly as for native effects) finds it. Because
  // spvToMsl mirrors the build-time conversion, the fused kernel is identical
  // to the statically-baked one → pixel parity.
  if (runtime_ && !desc_.id.empty()) {
    std::string msl = spvToMsl(slot.spv.data(), slot.spv.size());
    if (!msl.empty())
      runtime_->registerShaderMSL(desc_.id + "::" + std::string(name), msl);
  }
}

void EffectInstance::hostRegisterWasmFusion(int kind, std::string fragmentName,
                                            int uniformBufferHandle,
                                            int uniformSizeBytes,
                                            uint32_t prepareIdx) {
  FusionInfo info;
  info.kind = kind;
  info.fragmentName = std::move(fragmentName);
  info.uniformBufferHandle = uniformBufferHandle;
  info.uniformSizeBytes = uniformSizeBytes;
  info.prepare = nullptr;          // native slot unused for WASM
  info.wasmPrepareIdx = prepareIdx;
  fusion_info_ = std::move(info);
}
int EffectInstance::createShaderModuleByName(const std::string& name,
                                             gpu::GPUBackend* backend) {
  if (!backend) return -1;
  auto it = shaders_by_name_.find(name);
  if (it == shaders_by_name_.end()) return -1;
  const RegisteredShader& sh = it->second;
  // WASM effects ship SPIR-V; translate to MSL at load time (the native static
  // path uses build-time pre-baked MSL via EffectRuntime::lookupMSL instead).
  std::string msl = spvToMsl(sh.spv.data(), sh.spv.size());
  if (msl.empty()) return -1;
  return backend->createShaderModule(msl);
}

void EffectInstance::hostSetOnStateReady(void (*fn)(void* self)) {
  on_state_ready_ = fn;
}

void EffectInstance::setParamJson(const std::string& path,
                                  const std::string& jsonValue) {
  PendingPatch p{path, /*op=Replace*/ 2, jsonValue};
  firePatched({p});
}
void EffectInstance::setParamFloat(const std::string& path, float value) {
  setParamJson(path, std::to_string(value));
}
void EffectInstance::setParamArray(const std::string& path,
                                   const std::vector<float>& components) {
  std::string j = "[";
  for (size_t i = 0; i < components.size(); ++i) {
    if (i) j += ",";
    j += std::to_string(components[i]);
  }
  j += "]";
  setParamJson(path, j);
}

// Internal: firePatched populates the patch buffer/arrays, sets the
// active-instance pointer, and calls into on_state_patched. The
// effect's callback may call state::getPatch(i) / val::asNumber etc.
// — those resolve via the active instance + the in-scope val table.
void EffectInstance::firePatched(const std::vector<PendingPatch>& patches) {
  if (desc_.isWasm()) {
    if (!desc_.w_on_state_patched || patches.empty()) return;
    auto* h = desc_.wasm_host;
    const int32_t mid = desc_.wasm_module_id;

    // Build the packed path buffer + per-patch arrays (the on_state_patched
    // ABI) and the {op,path,value} objects state.get_patch returns.
    std::string pb;
    std::vector<int32_t> off, len, ops;
    off.reserve(patches.size());
    len.reserve(patches.size());
    ops.reserve(patches.size());
    std::vector<nlohmann::json> pend;
    pend.reserve(patches.size());
    for (const auto& p : patches) {
      off.push_back(static_cast<int32_t>(pb.size()));
      len.push_back(static_cast<int32_t>(p.path.size()));
      ops.push_back(p.op);
      pb += p.path;
      nlohmann::json obj;
      obj["op"] = (p.op == 0 ? "add"
                   : p.op == 1 ? "remove"
                   : p.op == 2 ? "replace"
                   : p.op == 3 ? "move"
                               : "copy");
      obj["path"] = p.path;
      obj["value"] = nlohmann::json::parse(p.valueJson, nullptr, false);
      pend.push_back(std::move(obj));
    }
    h->set_pending_patches(mid, std::move(pend));

    // Copy the buffers into the module's linear memory; pass their offsets.
    const uint32_t n = static_cast<uint32_t>(patches.size());
    const uint32_t bytes = n * sizeof(int32_t);
    void* nb = nullptr;
    void* no = nullptr;
    void* nl = nullptr;
    void* np = nullptr;
    uint32_t pb_off  = h->app_malloc(mid, static_cast<uint32_t>(pb.size()), &nb);
    uint32_t off_off = h->app_malloc(mid, bytes, &no);
    uint32_t len_off = h->app_malloc(mid, bytes, &nl);
    uint32_t ops_off = h->app_malloc(mid, bytes, &np);
    if (nb) std::memcpy(nb, pb.data(), pb.size());
    if (no) std::memcpy(no, off.data(), bytes);
    if (nl) std::memcpy(nl, len.data(), bytes);
    if (np) std::memcpy(np, ops.data(), bytes);

    uint32_t argv[6] = {wasmSelf(), n, pb_off, off_off, len_off, ops_off};
    h->set_effect_instance(mid, this);
    h->call_indirect(mid, desc_.w_on_state_patched, 6, argv);
    h->set_effect_instance(mid, nullptr);

    h->app_free(mid, pb_off);
    h->app_free(mid, off_off);
    h->app_free(mid, len_off);
    h->app_free(mid, ops_off);
    h->set_pending_patches(mid, {});
    return;
  }
  if (!desc_.on_state_patched) return;
  runtime_->setActive(this);

  // Build packed path buffer + per-patch arrays.
  std::string pb;
  std::vector<int> off, len, ops;
  off.reserve(patches.size());
  len.reserve(patches.size());
  ops.reserve(patches.size());
  for (const auto& p : patches) {
    off.push_back(static_cast<int>(pb.size()));
    len.push_back(static_cast<int>(p.path.size()));
    ops.push_back(p.op);
    pb += p.path;
  }

  // Pre-allocate val handles for each patch's {op, path, value}
  // payload so state::getPatch(i) can return them.
  val_strings_.clear();
  val_blobs_.clear();
  for (const auto& p : patches) {
    nlohmann::json obj;
    obj["op"] = (p.op == 0 ? "add"
                : p.op == 1 ? "remove"
                : p.op == 2 ? "replace"
                : p.op == 3 ? "move"
                            : "copy");
    obj["path"] = p.path;
    // p.valueJson is already a JSON literal (e.g. "1.5" or "[1,2]").
    obj["value"] = nlohmann::json::parse(p.valueJson, nullptr, false);
    val_blobs_.push_back(obj.dump());
  }

  desc_.on_state_patched(user_state_,
                         static_cast<int>(patches.size()),
                         pb.empty() ? nullptr : pb.data(),
                         off.empty() ? nullptr : off.data(),
                         len.empty() ? nullptr : len.data(),
                         ops.empty() ? nullptr : ops.data());

  runtime_->setActive(nullptr);
}

int EffectInstance::val_alloc(std::string_view jsonValue) {
  val_blobs_.emplace_back(jsonValue);
  return static_cast<int>(val_blobs_.size());  // 1-based handle
}
std::string EffectInstance::val_to_json(int handle) const {
  if (handle <= 0 || handle > (int)val_blobs_.size()) return "null";
  return val_blobs_[handle - 1];
}

// --- EffectRuntime ---

EffectRuntime::EffectRuntime(gpu::GPUBackend* gpu) : gpu_(gpu) {
  setCurrentRuntime(this);
}
EffectRuntime::~EffectRuntime() {
  if (currentRuntime() == this) setCurrentRuntime(nullptr);
}

EffectInstance* EffectRuntime::registerEffect(const EffectDesc& desc) {
  auto inst = std::make_unique<EffectInstance>(this, desc);
  auto* ptr = inst.get();
  by_id_[desc.id] = ptr;
  effects_.push_back(std::move(inst));
  // Run type-level setup once: shaders, shared PSO, schema prototype.
  ptr->doModuleInit();
  return ptr;
}

EffectInstance* EffectRuntime::find(const std::string& id) {
  auto it = by_id_.find(id);
  return it != by_id_.end() ? it->second : nullptr;
}

EffectInstance* EffectRuntime::instanceFor(const std::string& type,
                                           const std::string& instanceKey) {
  const std::string key = poolKey(type, instanceKey);
  auto it = instance_pool_.find(key);
  if (it != instance_pool_.end()) return it->second.get();

  EffectInstance* proto = find(type);
  if (!proto) return nullptr;

  // New per-key instance shares the type's descriptor; create() gives it
  // its own user_state + per-instance uniform buffer, init() registers
  // its per-instance fusion info.
  auto inst = std::make_unique<EffectInstance>(this, proto->desc_);
  auto* ptr = inst.get();
  instance_pool_.emplace(key, std::move(inst));
  ptr->doCreate();
  return ptr;
}

void EffectRuntime::destroyInstance(const std::string& type,
                                    const std::string& instanceKey) {
  auto it = instance_pool_.find(poolKey(type, instanceKey));
  if (it == instance_pool_.end()) return;
  instance_pool_.erase(it);  // ~EffectInstance runs doDestroy
}

void EffectRuntime::registerShaderMSL(const std::string& name, std::string msl) {
  msl_by_name_[name] = std::move(msl);
}
bool EffectRuntime::lookupMSL(const std::string& name, std::string* out) const {
  auto it = msl_by_name_.find(name);
  if (it == msl_by_name_.end()) return false;
  *out = it->second;
  return true;
}

void EffectRuntime::log(std::string_view level, std::string_view message) {
  std::string entry = std::string(level) + ": " + std::string(message);
  console_log_.emplace_back(std::move(entry));
}

std::vector<std::string> EffectRuntime::drainConsoleLog() {
  auto out = std::move(console_log_);
  console_log_.clear();
  return out;
}

void EffectRuntime::registerFromDesc(const void* desc_v2_ptr) {
  // Mirrors nano::EffectDesc_v2 layout — see wasm_modules/include/module_api.h.
  // We can't include that header directly (it declares the
  // nano_register_effect import) so we replicate the layout here.
  struct DescV2 {
    int32_t struct_version;
    const char* id;
    const char* name;
    const char* description;
    const char* category;
    const char* keywords;
    void  (*module_init)();
    void* (*create)();
    void  (*destroy)(void*);
    void  (*init)(void*);
    void  (*tick)(void*, double);
    void  (*render)(void*, int, int);
    void  (*on_state_patched)(void*, int, const char*, const int*, const int*, const int*);
    int32_t (*is_identity)(void*);
    void  (*on_active)(void*, int32_t);
    void  (*seek)(void*, double, double);
  };
  const auto* d = static_cast<const DescV2*>(desc_v2_ptr);
  if (!d || d->struct_version != 2) return;
  EffectDesc desc;
  desc.id = d->id ? d->id : "";
  desc.name = d->name ? d->name : "";
  desc.description = d->description ? d->description : "";
  desc.category = d->category ? d->category : "";
  desc.keywords = d->keywords ? d->keywords : "";
  desc.module_init = d->module_init;
  desc.create = d->create;
  desc.destroy = d->destroy;
  desc.init = d->init;
  desc.tick = d->tick;
  desc.render = d->render;
  desc.on_state_patched = d->on_state_patched;
  desc.is_identity = d->is_identity;
  desc.on_active = d->on_active;
  desc.seek = d->seek;
  registerEffect(desc);
}

}  // namespace effect_runtime
