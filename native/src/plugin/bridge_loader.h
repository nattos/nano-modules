#pragma once

#include "bridge/bridge_api.h"

namespace plugin {

/// Wraps dlopen/dlsym to load the bridge dylib at runtime.
class BridgeLoader {
public:
  ~BridgeLoader();

  bool load(const char* dylib_path);
  bool is_loaded() const;
  void unload();

  // Core function pointers
  BridgeInitFn bridge_init = nullptr;
  BridgeReleaseFn bridge_release = nullptr;
  BridgeGetParamFn bridge_get_param = nullptr;
  BridgeSetParamFn bridge_set_param = nullptr;
  BridgeTickFn bridge_tick = nullptr;
  BridgeLoadWasmFn bridge_load_wasm = nullptr;
  BridgeUnloadWasmFn bridge_unload_wasm = nullptr;
  BridgeCallWasmFn bridge_call_wasm = nullptr;

  // Extended function pointers (Phase C)
  BridgeSetFrameStateFn bridge_set_frame_state = nullptr;
  BridgeSetFfglParamFn bridge_set_ffgl_param = nullptr;
  BridgeRenderFn bridge_render = nullptr;
  BridgeCallTickFn bridge_call_tick = nullptr;
  BridgeCallOnParamFn bridge_call_on_param = nullptr;
  BridgeSetAudioCallbackFn bridge_set_audio_callback = nullptr;

private:
  void* handle_ = nullptr;
};

} // namespace plugin
