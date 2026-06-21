#include "sketch/module_registry.h"

#include <algorithm>
#include <utility>

#include "sketch/schema_util.h"
#include "runtime/effect_runtime.h"
#include "wasm/wasm_host.h"

namespace sketch_executor {

ModuleRegistry::ModuleRegistry(effect_runtime::EffectRuntime* rt)
  : rt_(rt) {}

bool ModuleRegistry::registerEffect(
    const std::string& moduleType,
    const std::string& displayName,
    void  (*module_init)(),
    void* (*create)(),
    void  (*destroy)(void*),
    void  (*init)(void*),
    void  (*tick)(void*, double),
    void  (*render)(void*, int, int),
    void  (*on_state_patched)(void*, int, const char*, const int*,
                              const int*, const int*),
    int32_t (*is_identity)(void*),
    void  (*on_active)(void*, int32_t)) {
  if (entries_.count(moduleType)) return true;
  if (!rt_) return false;

  effect_runtime::EffectDesc d;
  d.id   = moduleType;
  d.name = displayName;
  d.module_init      = module_init;
  d.create           = create;
  d.destroy          = destroy;
  d.init             = init;
  d.tick             = tick;
  d.render           = render;
  d.on_state_patched = on_state_patched;
  d.is_identity      = is_identity;
  d.on_active        = on_active;
  // registerEffect creates the type prototype and runs module_init()
  // (schema publish + shared GPU resources). Per-instance state is
  // created lazily per chain entry via EffectRuntime::instanceFor.
  auto* proto = rt_->registerEffect(d);
  if (!proto) return false;

  RegisteredModule reg;
  auto parsed = nlohmann::json::parse(proto->schemaJson(), nullptr, false);
  if (!parsed.is_discarded() && parsed.is_object()) {
    reg.schemaFields = parsed.value("fields", nlohmann::json::object());
    if (parsed.contains("capabilities") && parsed["capabilities"].is_array())
      for (const auto& c : parsed["capabilities"])
        if (c.is_string()) reg.capabilities.push_back(c.get<std::string>());
  } else {
    reg.schemaFields = nlohmann::json::object();
  }
  extractTextureLeafPaths(reg.schemaFields, "",
                          reg.inputTexturePaths,
                          reg.outputTexturePaths);
  buildSlotInputTextureFields(reg.schemaFields, reg.slotInputTextureFields);
  entries_[moduleType] = std::move(reg);
  return true;
}

bool ModuleRegistry::registerWasmEffect(
    const std::string& moduleType, const std::string& displayName,
    wasm::WasmHost* host, int32_t moduleId, const wasm::WasmEffectDesc& wd) {
  if (entries_.count(moduleType)) return true;
  if (!rt_ || !host) return false;

  effect_runtime::EffectDesc d;
  d.id   = moduleType;
  d.name = displayName;
  // WASM binding: dispatch the lifecycle through call_indirect on these indices.
  d.wasm_host           = host;
  d.wasm_module_id      = moduleId;
  d.w_module_init       = wd.idx_module_init;
  d.w_create            = wd.idx_create;
  d.w_destroy           = wd.idx_destroy;
  d.w_init              = wd.idx_init;
  d.w_tick              = wd.idx_tick;
  d.w_render            = wd.idx_render;
  d.w_on_state_patched  = wd.idx_on_state_patched;
  d.w_is_identity       = wd.idx_is_identity;
  d.w_on_active         = wd.idx_on_active;
  d.w_seek              = wd.idx_seek;

  // Runs module_init() — schema is published onto the prototype via the WASM
  // host-import forwarding (EffectHostSink), then parsed below as for native.
  auto* proto = rt_->registerEffect(d);
  if (!proto) return false;

  RegisteredModule reg;
  reg.moduleInitTrapped = proto->moduleInitTrapped();
  auto parsed = nlohmann::json::parse(proto->schemaJson(), nullptr, false);
  if (!parsed.is_discarded() && parsed.is_object()) {
    reg.schemaFields = parsed.value("fields", nlohmann::json::object());
    if (parsed.contains("capabilities") && parsed["capabilities"].is_array())
      for (const auto& c : parsed["capabilities"])
        if (c.is_string()) reg.capabilities.push_back(c.get<std::string>());
  } else {
    reg.schemaFields = nlohmann::json::object();
  }
  extractTextureLeafPaths(reg.schemaFields, "",
                          reg.inputTexturePaths,
                          reg.outputTexturePaths);
  buildSlotInputTextureFields(reg.schemaFields, reg.slotInputTextureFields);
  entries_[moduleType] = std::move(reg);
  return true;
}

int ModuleRegistry::registerWasmBundle(wasm::WasmHost& host, int32_t moduleId) {
  int count = 0;
  // Copy the descriptors: registerWasmEffect → registerEffect can mutate the
  // host's per-module state, so don't hold a reference into it across the loop.
  const std::vector<wasm::WasmEffectDesc> effects =
      host.registered_effects(moduleId);
  for (const auto& e : effects) {
    if (e.id.empty()) continue;
    if (registerWasmEffect(e.id, e.name.empty() ? e.id : e.name,
                           &host, moduleId, e)) {
      ++count;
    }
  }
  return count;
}

const RegisteredModule* ModuleRegistry::find(const std::string& moduleType) const {
  auto it = entries_.find(moduleType);
  return it == entries_.end() ? nullptr : &it->second;
}

std::unordered_map<std::string, nlohmann::json> ModuleRegistry::schemas() const {
  std::unordered_map<std::string, nlohmann::json> out;
  out.reserve(entries_.size());
  for (const auto& kv : entries_) {
    out.emplace(kv.first, kv.second.schemaFields);
  }
  return out;
}

// Thin forwarders to the shared, wasm-safe helpers (schema_util.h). The
// executor uses the free functions directly; ModuleRegistry keeps these static
// methods for its existing callers.
void ModuleRegistry::buildSlotInputTextureFields(
    const nlohmann::json& fields, std::vector<std::string>& slots) {
  schema_util::deriveSlotInputTextureFields(fields, slots);
}

void ModuleRegistry::extractTextureLeafPaths(
    const nlohmann::json& fields, const std::string& prefix,
    std::vector<std::string>& inputs,
    std::vector<std::string>& outputs) {
  schema_util::deriveTextureLeafPaths(fields, prefix, inputs, outputs);
}

}  // namespace sketch_executor
