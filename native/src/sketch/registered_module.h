#pragma once
/*
 * registered_module.h — the per-module schema record the executor caches.
 *
 * Split out of module_registry.h (which also declares the ModuleRegistry class
 * and references native effect_runtime / wasm:: types) so the unified executor
 * can include JUST this pure struct: nlohmann + std only, no native deps, so it
 * compiles into executor.wasm. The executor derives these fields itself via
 * schema_util.h from the schemas the host pushes in.
 */

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace sketch_executor {

/**
 * Per-effect metadata the executor uses for wire routing / slot binding. Built
 * by parsing the schema an effect publishes (natively at registerEffect() time;
 * in the executor via registerModuleSchema()).
 */
struct RegisteredModule {
  /** Parsed schema `fields` sub-object. Fed to the augmenter so it knows every
   *  module's structured I/O shape. */
  nlohmann::json schemaFields;
  /** Slash-joined paths for every input texture leaf (excludes primary
   *  "tex_in"). Zeroed before each frame's tap routing so stale handles can't
   *  leak through. */
  std::vector<std::string> inputTexturePaths;
  /** Output side — excludes "tex_out". Used to reset connection markers each
   *  frame. */
  std::vector<std::string> outputTexturePaths;
  /** Top-level input-texture field names in schema "order" order, INCLUDING the
   *  slot-0 field (tex_in / tex_a): the positional mapping the slot-based GPU
   *  ABI (inputTexture(N)) reads. Distinct from inputTexturePaths. */
  std::vector<std::string> slotInputTextureFields;
};

}  // namespace sketch_executor
