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

  // Multiplexed-instance function pointers (FFGL barrel)
  BridgeRegisterPluginFn bridge_register_plugin = nullptr;
  BridgeUnregisterPluginFn bridge_unregister_plugin = nullptr;
  BridgeRegisterPatchListenerFn bridge_register_patch_listener = nullptr;
  BridgeUnregisterPatchListenerFn bridge_unregister_patch_listener = nullptr;
  BridgeSetPluginStateFn bridge_set_plugin_state = nullptr;
  BridgeGetPluginStateFn bridge_get_plugin_state = nullptr;
  BridgeSetAtFn bridge_set_at = nullptr;
  BridgeGetAtFn bridge_get_at = nullptr;
  BridgeFreeStringFn bridge_free_string = nullptr;
  BridgeBroadcastBinaryFn bridge_broadcast_binary = nullptr;
  BridgeHasClientsFn bridge_has_clients = nullptr;
  BridgeKeyObservedFn bridge_key_observed = nullptr;

  // Shared effect runtime (barrel render service)
  BridgeRtAcquireFn bridge_rt_acquire = nullptr;
  BridgeRtReleaseFn bridge_rt_release = nullptr;
  BridgeRtMetalDeviceFn bridge_rt_metal_device = nullptr;
  BridgeRtSchemasFn bridge_rt_schemas = nullptr;
  BridgeExecutorCreateFn bridge_executor_create = nullptr;
  BridgeExecutorDestroyFn bridge_executor_destroy = nullptr;
  BridgeExecutorRenderFn bridge_executor_render = nullptr;

private:
  void* handle_ = nullptr;
};

} // namespace plugin
