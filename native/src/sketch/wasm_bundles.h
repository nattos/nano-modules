#pragma once
// wasm_bundles.h — load effect .wasm bundles into a ModuleRegistry.
//
// The barrel-loads-WASM replacement for the statically-generated
// nano_barrel_gen::registerAllBarrelEffects. Owns the WasmHost that keeps the
// loaded modules alive (effects call_indirect into them every frame), loads
// each bundle, runs its nano_module_main, and registers every effect it
// declares via ModuleRegistry::registerWasmBundle.

#include <cstdint>
#include <string>

#include "bridge/param_cache.h"
#include "wasm/wasm_host.h"

namespace gpu { class GPUBackend; }
namespace bridge { class StateDocument; }

namespace sketch_executor {

class ModuleRegistry;

class WasmEffectBundles {
 public:
  WasmEffectBundles();

  // Initialize the WAMR runtime. Must succeed before loading bundles.
  bool init();
  bool initialized() const { return initialized_; }

  // Load an effect bundle from bytecode and register every effect it declares
  // into `registry`. `gpu`/`stateDoc` are attached to the module so an effect's
  // module_init can compile its shaders and publish its schema (both may be
  // null — schema still publishes; GPU effects skip shader compile). Returns
  // the number of effects registered (0 on any failure / no nano_module_main).
  int loadBundle(const uint8_t* bytecode, uint32_t len, ModuleRegistry& registry,
                 gpu::GPUBackend* gpu, bridge::StateDocument* stateDoc);

  // Same, reading the bundle from a file path. Returns 0 if unreadable.
  int loadBundleFile(const std::string& path, ModuleRegistry& registry,
                     gpu::GPUBackend* gpu, bridge::StateDocument* stateDoc);

  wasm::WasmHost& host() { return host_; }

 private:
  bridge::ParamCache cache_;  // declared before host_ (host_ binds to it)
  wasm::WasmHost host_;
  bool initialized_ = false;
};

}  // namespace sketch_executor
