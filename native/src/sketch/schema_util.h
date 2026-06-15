#pragma once
/*
 * schema_util.h — pure schema-derivation helpers, shared by ModuleRegistry
 * (native) and the unified executor. Header-only + dependency-light (nlohmann +
 * std only) so it compiles unchanged into executor.wasm, where there is no
 * ModuleRegistry: the executor derives a module's texture-leaf paths and
 * positional input-slot order from the schema JSON the host pushes in.
 */

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace sketch_executor {
namespace schema_util {

// Top-level input-texture field names ordered by the schema "order" key
// (NOT alphabetical / map order), INCLUDING the slot-0 field (tex_in / tex_a) —
// the positional contract behind gpu::Device::inputTexture(N) / the executor's
// per-stage input slots. Mirrors web's textureInputIndex.
inline void deriveSlotInputTextureFields(const nlohmann::json& fields,
                                         std::vector<std::string>& slots) {
  slots.clear();
  if (!fields.is_object()) return;
  std::vector<std::pair<int, std::string>> ordered;
  for (auto it = fields.begin(); it != fields.end(); ++it) {
    const auto& def = it.value();
    if (!def.is_object()) continue;
    if (def.value("type", std::string()) != "texture") continue;
    if ((def.value("io", 0) & 1) == 0) continue;
    ordered.emplace_back(def.value("order", 0), it.key());
  }
  std::stable_sort(ordered.begin(), ordered.end(),
                   [](const auto& a, const auto& b) { return a.first < b.first; });
  for (auto& p : ordered) slots.push_back(std::move(p.second));
}

// Recursive walk: split every texture-leaf path into input/output buckets by the
// io bitfield. Skips primary "tex_in"/"tex_out" (the executor wires those each
// frame). Slash-joined paths (e.g. "render_outputs/motion") for nested structs.
inline void deriveTextureLeafPaths(const nlohmann::json& fields,
                                   const std::string& prefix,
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
      deriveTextureLeafPaths(sub, path, inputs, outputs);
    }
  }
}

}  // namespace schema_util
}  // namespace sketch_executor
