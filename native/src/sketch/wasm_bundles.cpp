#include "sketch/wasm_bundles.h"

#include <fstream>
#include <vector>

#include "sketch/module_registry.h"

namespace sketch_executor {

WasmEffectBundles::WasmEffectBundles() : host_(cache_) {}

bool WasmEffectBundles::init() {
  initialized_ = host_.init();
  return initialized_;
}

int WasmEffectBundles::loadBundle(const uint8_t* bytecode, uint32_t len,
                                  ModuleRegistry& registry, gpu::GPUBackend* gpu,
                                  bridge::StateDocument* stateDoc) {
  if (!initialized_ || !bytecode || len == 0) return 0;

  int32_t id = host_.load_module(bytecode, len);
  if (id < 0) return 0;

  // Attach per-module host services before nano_module_main / module_init runs:
  // the GPU backend (shader compile) and the state doc (schema publish to the
  // editor bridge). Both optional.
  if (gpu) host_.set_gpu_backend(id, gpu);
  if (stateDoc) host_.set_state_doc(id, stateDoc);

  // Bundles register their effects from nano_module_main. A non-effect module
  // (no such export) fails here and contributes nothing.
  if (host_.call_function(id, "nano_module_main") != 0) return 0;

  return registry.registerWasmBundle(host_, id);
}

int WasmEffectBundles::loadBundleFile(const std::string& path,
                                      ModuleRegistry& registry,
                                      gpu::GPUBackend* gpu,
                                      bridge::StateDocument* stateDoc) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return 0;
  auto size = f.tellg();
  if (size <= 0) return 0;
  std::vector<uint8_t> buf(static_cast<size_t>(size));
  f.seekg(0);
  if (!f.read(reinterpret_cast<char*>(buf.data()), size)) return 0;
  return loadBundle(buf.data(), static_cast<uint32_t>(buf.size()), registry,
                    gpu, stateDoc);
}

}  // namespace sketch_executor
