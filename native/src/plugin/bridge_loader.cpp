#include "plugin/bridge_loader.h"

#include <dlfcn.h>

namespace plugin {

BridgeLoader::~BridgeLoader() {
  unload();
}

bool BridgeLoader::load(const char* dylib_path) {
  if (handle_) return true; // Already loaded

  handle_ = dlopen(dylib_path, RTLD_NOW | RTLD_GLOBAL);
  if (!handle_) return false;

  // Resolve all function pointers
  bridge_init = reinterpret_cast<BridgeInitFn>(dlsym(handle_, "bridge_init"));
  bridge_release = reinterpret_cast<BridgeReleaseFn>(dlsym(handle_, "bridge_release"));
  bridge_get_param = reinterpret_cast<BridgeGetParamFn>(dlsym(handle_, "bridge_get_param"));
  bridge_set_param = reinterpret_cast<BridgeSetParamFn>(dlsym(handle_, "bridge_set_param"));
  bridge_tick = reinterpret_cast<BridgeTickFn>(dlsym(handle_, "bridge_tick"));
  bridge_load_wasm = reinterpret_cast<BridgeLoadWasmFn>(dlsym(handle_, "bridge_load_wasm"));
  bridge_unload_wasm = reinterpret_cast<BridgeUnloadWasmFn>(dlsym(handle_, "bridge_unload_wasm"));
  bridge_call_wasm = reinterpret_cast<BridgeCallWasmFn>(dlsym(handle_, "bridge_call_wasm"));

  // Verify all required functions were found
  if (!bridge_init || !bridge_release || !bridge_get_param ||
      !bridge_set_param || !bridge_tick) {
    unload();
    return false;
  }

  return true;
}

bool BridgeLoader::is_loaded() const {
  return handle_ != nullptr && bridge_init != nullptr;
}

void BridgeLoader::unload() {
  if (handle_) {
    dlclose(handle_);
    handle_ = nullptr;
  }
  bridge_init = nullptr;
  bridge_release = nullptr;
  bridge_get_param = nullptr;
  bridge_set_param = nullptr;
  bridge_tick = nullptr;
  bridge_load_wasm = nullptr;
  bridge_unload_wasm = nullptr;
  bridge_call_wasm = nullptr;
}

} // namespace plugin
