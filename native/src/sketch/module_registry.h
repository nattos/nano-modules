// module_registry.h — effect-id → initialised effect instance lookup.
//
// Built once by whoever sets up the EffectRuntime (FFGL barrel plugin
// today; the bridge_server dylib will reuse it once it grows native
// effect support). Holds the per-effect schema metadata the augmenter
// needs and the texture-leaf path lists the executor needs to zero
// state between frames.
//
// Registering the same module_type twice is a no-op. Effects now keep
// per-instance state (see EffectRuntime::instanceFor) rather than file
// statics, so multiple chain entries of the same type each get their own
// instance — the registry holds only the type-level schema/metadata.

#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <unordered_map>
#include <vector>

namespace effect_runtime {
class EffectRuntime;
class EffectInstance;
}  // namespace effect_runtime

namespace sketch_executor {

/**
 * Per-effect metadata + the EffectInstance pointer the executor
 * dispatches through. Built once at registerEffect() time by parsing
 * the schema the effect publishes from its init().
 */
struct RegisteredModule {
  /**
   * Parsed schema `fields` sub-object. Passed to
   * `sketch_augment::augmentSketchWithImplicitConnections()` each
   * frame so the augmenter knows every module's structured I/O shape.
   */
  nlohmann::json schemaFields;
  /**
   * Slash-joined paths for every input texture leaf declared by the
   * schema (excludes the primary "tex_in"). The executor zeroes
   * these before each frame's tap routing so stale handles can't
   * leak through when the current frame's config doesn't cover them.
   */
  std::vector<std::string> inputTexturePaths;
  /** Output side — excludes "tex_out". Used to reset connection
   *  markers each frame. The handle itself isn't zeroed; the producer
   *  re-assigns via state::setGpuTexture during render. */
  std::vector<std::string> outputTexturePaths;
};

/**
 * Maps editor module_type strings (eg "video.brightness_contrast") to
 * initialised `RegisteredModule` records. The same registry instance
 * is shared between the augmenter (for `schemas()`) and the executor
 * (for per-frame `find()`).
 *
 * Doesn't own the EffectRuntime — the caller does. Doesn't allocate
 * GPU resources — the EffectInstances do that during init().
 */
class ModuleRegistry {
 public:
  explicit ModuleRegistry(effect_runtime::EffectRuntime* rt);

  /**
   * Register an effect TYPE under its editor module_type (eg
   * "video.brightness_contrast"). Runs the effect's `module_init()`
   * synchronously — when it publishes its schema and creates the shared
   * GPU resources (shader modules, PSOs). Per-instance state (uniform
   * buffers, params) is created lazily per chain entry via
   * EffectRuntime::instanceFor.
   *
   * Returns true on success, false if the runtime rejected the
   * registration. A repeated registration for the same module_type
   * is silently ignored.
   */
  bool registerEffect(
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
      int32_t (*is_identity)(void*) = nullptr,
      void  (*on_active)(void*, int32_t) = nullptr);

  /** Look up by editor module_type. nullptr if not registered. */
  const RegisteredModule* find(const std::string& moduleType) const;

  /**
   * Build a fresh module_type → schema-fields map. Cheap (copies a
   * handful of json objects); intended to be called once per frame
   * inside the executor before augmentation.
   */
  std::unordered_map<std::string, nlohmann::json> schemas() const;

  /** Number of effects registered. */
  size_t size() const { return entries_.size(); }

 private:
  effect_runtime::EffectRuntime* rt_;
  std::unordered_map<std::string, RegisteredModule> entries_;

  /**
   * Recursive walk: split every texture-leaf path in the schema into
   * input or output buckets based on the io bitfield. Skips primary
   * "tex_in" / "tex_out" — the executor wires those explicitly each
   * frame. Slash-joined paths (eg "render_outputs/motion") for nested
   * object fields.
   */
  static void extractTextureLeafPaths(
      const nlohmann::json& fields, const std::string& prefix,
      std::vector<std::string>& inputs,
      std::vector<std::string>& outputs);
};

}  // namespace sketch_executor
