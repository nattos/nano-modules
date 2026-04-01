#pragma once

#include "bridge/bridge_api.h"

namespace plugin {

/// Wraps dlopen/dlsym to load the bridge dylib at runtime.
class BridgeLoader {
public:
  ~BridgeLoader();

  /// Load the bridge dylib from the given path.
  /// Returns true on success.
  bool load(const char* dylib_path);

  /// Check if the dylib is loaded and all function pointers resolved.
  bool is_loaded() const;

  /// Unload the dylib.
  void unload();

  // Function pointers resolved from the dylib
  BridgeInitFn bridge_init = nullptr;
  BridgeReleaseFn bridge_release = nullptr;
  BridgeGetParamFn bridge_get_param = nullptr;
  BridgeSetParamFn bridge_set_param = nullptr;
  BridgeTickFn bridge_tick = nullptr;
  BridgeLoadWasmFn bridge_load_wasm = nullptr;
  BridgeUnloadWasmFn bridge_unload_wasm = nullptr;
  BridgeCallWasmFn bridge_call_wasm = nullptr;

private:
  void* handle_ = nullptr;
};

} // namespace plugin
