// comp_catalog.h — the composition executor's effect registry.
//
// LOCK-STEP: web/src/views/arrangement/engine/effect-catalog.ts. Derives an
// effect's ROLE (generator vs effect), default float-field state, and declared
// scalar output ranges from the discovered plugin schema + capabilities — the
// SAME `fields` JSON the host already registers per module (see
// executor_register_schema; comp_register_schema forwards it here too).
//
// Schema entry shape (per field): { type:'float', io, min, max, default, order }
// where io&1 = input, io&2 = output. Non-float fields are intentionally ignored,
// exactly like the TS registry.

#pragma once

#include <string>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

namespace comp {

class Catalog {
 public:
  /** Register (or replace) a module's schema — presence makes the type "real"
   *  (catalogEffect resolves), even with an empty fields object. */
  void registerSchema(const std::string& moduleType, nlohmann::json fields) {
    auto& e = byType_[moduleType];
    e.schema = fields.is_object() ? std::move(fields) : nlohmann::json::object();
    e.registered = true;
  }

  /** Register a module's capability tags (JSON array of strings). */
  void registerCapabilities(const std::string& moduleType, const nlohmann::json& caps) {
    auto& e = byType_[moduleType];
    e.caps.clear();
    if (caps.is_array()) {
      for (const auto& c : caps) {
        if (c.is_string()) e.caps.push_back(c.get<std::string>());
      }
    }
  }

  /** catalogEffect(type) presence — is this a discovered/real effect? */
  bool has(const std::string& moduleType) const {
    auto it = byType_.find(moduleType);
    return it != byType_.end() && it->second.registered;
  }

  /** role === 'generator' — straight from the `generator` capability tag. */
  bool isGenerator(const std::string& moduleType) const {
    auto it = byType_.find(moduleType);
    if (it == byType_.end()) return false;
    for (const auto& c : it->second.caps) {
      if (c == "generator") return true;
    }
    return false;
  }

  /** Default field state (float input fields → default), effect-catalog's
   *  defaultStateFor. Returns an object (empty for unknown types). */
  nlohmann::json defaultStateFor(const std::string& moduleType) const {
    nlohmann::json state = nlohmann::json::object();
    auto it = byType_.find(moduleType);
    if (it == byType_.end()) return state;
    for (auto& [key, def] : it->second.schema.items()) {
      if (!isFloatWithIo(def, /*bit=*/1)) continue;
      state[key] =
          def.contains("default") && def["default"].is_number() ? def["default"] : nlohmann::json(0);
    }
    return state;
  }

  /**
   * Declared range of a scalar OUTPUT field (io&2) — the modulation-range
   * contract a rail writer normalizes from. Mirrors the TS call site's
   * `out?.min ?? 0` / `out?.max ?? 1`: a missing type/field yields {0, 1}.
   */
  void outputRange(const std::string& moduleType, const std::string& field, double& mn,
                   double& mx) const {
    mn = 0;
    mx = 1;
    auto it = byType_.find(moduleType);
    if (it == byType_.end()) return;
    auto f = it->second.schema.find(field);
    if (f == it->second.schema.end() || !isFloatWithIo(*f, /*bit=*/2)) return;
    if (f->contains("min") && (*f)["min"].is_number()) mn = (*f)["min"].get<double>();
    if (f->contains("max") && (*f)["max"].is_number()) mx = (*f)["max"].get<double>();
  }

  /**
   * PURE-OUTPUT scalar fields (io&2 set, io&1 clear; not object/array/texture)
   * — the producer outputs the executor's write-taps read from instance state,
   * which the comp executor mirrors from the live plugin state each frame.
   * Mirrors executor-host.ts's producer-output filter exactly.
   */
  std::vector<std::string> publishedOutFields(const std::string& moduleType) const {
    std::vector<std::string> out;
    auto it = byType_.find(moduleType);
    if (it == byType_.end()) return out;
    for (auto& [key, def] : it->second.schema.items()) {
      if (!def.is_object()) continue;
      const int io = def.contains("io") && def["io"].is_number() ? def["io"].get<int>() : 0;
      if (!((io & 2) && !(io & 1))) continue;
      const std::string type = def.value("type", std::string());
      if (type == "object" || type == "array" || type == "texture") continue;
      out.push_back(key);
    }
    return out;
  }

 private:
  static bool isFloatWithIo(const nlohmann::json& def, int bit) {
    if (!def.is_object()) return false;
    if (def.value("type", std::string()) != "float") return false;
    const int io = def.contains("io") && def["io"].is_number() ? def["io"].get<int>() : 0;
    return (io & bit) != 0;
  }

  struct Entry {
    nlohmann::json schema = nlohmann::json::object();
    std::vector<std::string> caps;
    bool registered = false;
  };
  std::unordered_map<std::string, Entry> byType_;
};

}  // namespace comp
