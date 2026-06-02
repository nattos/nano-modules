// effect_runtime.cpp — runtime + EffectInstance implementations.
//
// See header for design notes. Pairs with host_impls.cpp + gpu_impls.cpp
// which provide the extern-C symbols effects link against.

#include "runtime/effect_runtime.h"

#include <iostream>
#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"

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

void EffectInstance::doModuleInit() {
  // Type-level setup: register shaders, create the shared PSO, publish
  // the schema prototype. Routed to this (prototype) instance via the
  // active pointer so state::* host calls land here.
  runtime_->setActive(this);
  if (desc_.module_init) desc_.module_init();
  runtime_->setActive(nullptr);
}

void EffectInstance::doCreate() {
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
  runtime_->setActive(this);
  if (desc_.destroy) desc_.destroy(user_state_);
  runtime_->setActive(nullptr);
  user_state_ = nullptr;
}

void EffectInstance::doTick(double dt) {
  runtime_->setActive(this);
  if (desc_.tick) desc_.tick(user_state_, dt);
  runtime_->setActive(nullptr);
}

void EffectInstance::doRender(int vp_w, int vp_h) {
  runtime_->setActive(this);
  if (desc_.render) desc_.render(user_state_, vp_w, vp_h);
  runtime_->setActive(nullptr);
}

void EffectInstance::doPrepare(int vp_w, int vp_h) {
  if (!fusion_info_.prepare) return;
  runtime_->setActive(this);
  fusion_info_.prepare(user_state_, vp_w, vp_h);
  runtime_->setActive(nullptr);
}

bool EffectInstance::isIdentity() {
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
    void  (*on_resolume_param)(void*, long long, double);
    int32_t (*is_identity)(void*);
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
  desc.on_resolume_param = d->on_resolume_param;
  desc.is_identity = d->is_identity;
  registerEffect(desc);
}

}  // namespace effect_runtime
