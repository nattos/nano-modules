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

#include "sketch/registered_module.h"  // RegisteredModule (pure struct)

namespace effect_runtime {
class EffectRuntime;
class EffectInstance;
}  // namespace effect_runtime

namespace wasm {
class WasmHost;
struct WasmEffectDesc;
}  // namespace wasm

namespace sketch_executor {

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

  /**
   * Register a WASM-backed effect TYPE (barrel-loads-WASM). `host` + `moduleId`
   * identify the loaded bundle; `desc` is the captured EffectDesc_v2 (function-
   * table indices). Builds a WASM-bound EffectDesc and runs module_init() like
   * the native path — schema is published via the host-import forwarding onto
   * the prototype instance, then parsed identically. The effect dispatches
   * through WasmHost::call_indirect. Repeated registration of the same
   * moduleType is a no-op. Returns false if the runtime rejected it.
   */
  bool registerWasmEffect(const std::string& moduleType,
                          const std::string& displayName,
                          wasm::WasmHost* host, int32_t moduleId,
                          const wasm::WasmEffectDesc& desc);

  /**
   * Register every effect a bundle's nano_module_main captured (each effect's
   * id becomes its editor module_type). Call after the bundle is loaded and
   * nano_module_main has run. Returns the number newly registered.
   */
  int registerWasmBundle(wasm::WasmHost& host, int32_t moduleId);

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

  /**
   * Top-level input-texture field names ordered by the schema "order"
   * key (NOT alphabetical / map order), INCLUDING the slot-0 field
   * (tex_in / tex_a). Populates `RegisteredModule::slotInputTextureFields`.
   * The positional contract behind `gpu::Device::inputTexture(N)`.
   */
  static void buildSlotInputTextureFields(
      const nlohmann::json& fields, std::vector<std::string>& slots);
};

}  // namespace sketch_executor
