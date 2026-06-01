#include "sketch/module_registry.h"

#include "runtime/effect_runtime.h"

namespace sketch_executor {

ModuleRegistry::ModuleRegistry(effect_runtime::EffectRuntime* rt)
  : rt_(rt) {}

bool ModuleRegistry::registerEffect(
    const std::string& moduleType,
    const std::string& displayName,
    void (*init)(),
    void (*tick)(double),
    void (*render)(int, int),
    void (*on_state_patched)(int, const char*, const int*,
                             const int*, const int*)) {
  if (entries_.count(moduleType)) return true;
  if (!rt_) return false;

  effect_runtime::EffectDesc d;
  d.id   = moduleType;
  d.name = displayName;
  d.init             = init;
  d.tick             = tick;
  d.render           = render;
  d.on_state_patched = on_state_patched;
  auto* inst = rt_->registerEffect(d);
  if (!inst) return false;
  inst->doInit();

  RegisteredModule reg;
  reg.inst = inst;
  auto parsed = nlohmann::json::parse(inst->schemaJson(), nullptr, false);
  if (!parsed.is_discarded() && parsed.is_object()) {
    reg.schemaFields = parsed.value("fields", nlohmann::json::object());
  } else {
    reg.schemaFields = nlohmann::json::object();
  }
  extractTextureLeafPaths(reg.schemaFields, "",
                          reg.inputTexturePaths,
                          reg.outputTexturePaths);
  entries_[moduleType] = std::move(reg);
  return true;
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

void ModuleRegistry::extractTextureLeafPaths(
    const nlohmann::json& fields, const std::string& prefix,
    std::vector<std::string>& inputs,
    std::vector<std::string>& outputs) {
  if (!fields.is_object()) return;
  for (auto it = fields.begin(); it != fields.end(); ++it) {
    const std::string& name = it.key();
    const auto& def = it.value();
    if (!def.is_object()) continue;
    const std::string type = def.value("type", std::string());
    const std::string path = prefix.empty() ? name : (prefix + "/" + name);
    if (type == "texture") {
      if (path == "tex_in" || path == "tex_out") continue;
      const int io = def.value("io", 0);
      if (io & 1) inputs.push_back(path);
      if (io & 2) outputs.push_back(path);
    } else if (type == "object") {
      const auto& sub = def.value("fields", nlohmann::json::object());
      extractTextureLeafPaths(sub, path, inputs, outputs);
    }
  }
}

}  // namespace sketch_executor
