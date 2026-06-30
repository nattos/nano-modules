#include "plugin/bridge_loader.h"

#include <dlfcn.h>

namespace plugin {

BridgeLoader::~BridgeLoader() {
  unload();
}

bool BridgeLoader::load(const char* dylib_path) {
  if (handle_) return true;

  handle_ = dlopen(dylib_path, RTLD_NOW | RTLD_GLOBAL);
  if (!handle_) return false;

  // Core functions
  bridge_init = reinterpret_cast<BridgeInitFn>(dlsym(handle_, "bridge_init"));
  bridge_release = reinterpret_cast<BridgeReleaseFn>(dlsym(handle_, "bridge_release"));
  bridge_get_param = reinterpret_cast<BridgeGetParamFn>(dlsym(handle_, "bridge_get_param"));
  bridge_set_param = reinterpret_cast<BridgeSetParamFn>(dlsym(handle_, "bridge_set_param"));
  bridge_tick = reinterpret_cast<BridgeTickFn>(dlsym(handle_, "bridge_tick"));
  bridge_load_wasm = reinterpret_cast<BridgeLoadWasmFn>(dlsym(handle_, "bridge_load_wasm"));
  bridge_unload_wasm = reinterpret_cast<BridgeUnloadWasmFn>(dlsym(handle_, "bridge_unload_wasm"));
  bridge_call_wasm = reinterpret_cast<BridgeCallWasmFn>(dlsym(handle_, "bridge_call_wasm"));

  // Extended functions
  bridge_set_frame_state = reinterpret_cast<BridgeSetFrameStateFn>(dlsym(handle_, "bridge_set_frame_state"));
  bridge_set_ffgl_param = reinterpret_cast<BridgeSetFfglParamFn>(dlsym(handle_, "bridge_set_ffgl_param"));
  bridge_render = reinterpret_cast<BridgeRenderFn>(dlsym(handle_, "bridge_render"));
  bridge_call_tick = reinterpret_cast<BridgeCallTickFn>(dlsym(handle_, "bridge_call_tick"));
  bridge_call_on_param = reinterpret_cast<BridgeCallOnParamFn>(dlsym(handle_, "bridge_call_on_param"));
  bridge_set_audio_callback = reinterpret_cast<BridgeSetAudioCallbackFn>(dlsym(handle_, "bridge_set_audio_callback"));

  // Multiplexed-instance functions (FFGL barrel). Not in the required-symbol
  // check below so older dylibs still load for the looper/repatch path; the
  // barrel checks the specific pointers it needs before first use.
  bridge_register_plugin = reinterpret_cast<BridgeRegisterPluginFn>(dlsym(handle_, "bridge_register_plugin"));
  bridge_unregister_plugin = reinterpret_cast<BridgeUnregisterPluginFn>(dlsym(handle_, "bridge_unregister_plugin"));
  bridge_register_patch_listener = reinterpret_cast<BridgeRegisterPatchListenerFn>(dlsym(handle_, "bridge_register_patch_listener"));
  bridge_unregister_patch_listener = reinterpret_cast<BridgeUnregisterPatchListenerFn>(dlsym(handle_, "bridge_unregister_patch_listener"));
  bridge_set_plugin_state = reinterpret_cast<BridgeSetPluginStateFn>(dlsym(handle_, "bridge_set_plugin_state"));
  bridge_get_plugin_state = reinterpret_cast<BridgeGetPluginStateFn>(dlsym(handle_, "bridge_get_plugin_state"));
  bridge_set_at = reinterpret_cast<BridgeSetAtFn>(dlsym(handle_, "bridge_set_at"));
  bridge_get_at = reinterpret_cast<BridgeGetAtFn>(dlsym(handle_, "bridge_get_at"));
  bridge_free_string = reinterpret_cast<BridgeFreeStringFn>(dlsym(handle_, "bridge_free_string"));
  bridge_broadcast_binary = reinterpret_cast<BridgeBroadcastBinaryFn>(dlsym(handle_, "bridge_broadcast_binary"));
  bridge_has_clients = reinterpret_cast<BridgeHasClientsFn>(dlsym(handle_, "bridge_has_clients"));
  bridge_key_observed = reinterpret_cast<BridgeKeyObservedFn>(dlsym(handle_, "bridge_key_observed"));

  bridge_rt_acquire = reinterpret_cast<BridgeRtAcquireFn>(dlsym(handle_, "bridge_rt_acquire"));
  bridge_rt_release = reinterpret_cast<BridgeRtReleaseFn>(dlsym(handle_, "bridge_rt_release"));
  bridge_rt_metal_device = reinterpret_cast<BridgeRtMetalDeviceFn>(dlsym(handle_, "bridge_rt_metal_device"));
  bridge_rt_schemas = reinterpret_cast<BridgeRtSchemasFn>(dlsym(handle_, "bridge_rt_schemas"));
  bridge_executor_create = reinterpret_cast<BridgeExecutorCreateFn>(dlsym(handle_, "bridge_executor_create"));
  bridge_executor_destroy = reinterpret_cast<BridgeExecutorDestroyFn>(dlsym(handle_, "bridge_executor_destroy"));
  bridge_executor_render = reinterpret_cast<BridgeExecutorRenderFn>(dlsym(handle_, "bridge_executor_render"));

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
  bridge_set_frame_state = nullptr;
  bridge_set_ffgl_param = nullptr;
  bridge_render = nullptr;
  bridge_call_tick = nullptr;
  bridge_call_on_param = nullptr;
  bridge_set_audio_callback = nullptr;
  bridge_register_plugin = nullptr;
  bridge_unregister_plugin = nullptr;
  bridge_register_patch_listener = nullptr;
  bridge_unregister_patch_listener = nullptr;
  bridge_set_plugin_state = nullptr;
  bridge_get_plugin_state = nullptr;
  bridge_set_at = nullptr;
  bridge_get_at = nullptr;
  bridge_free_string = nullptr;
  bridge_broadcast_binary = nullptr;
  bridge_has_clients = nullptr;
  bridge_key_observed = nullptr;
  bridge_rt_acquire = nullptr;
  bridge_rt_release = nullptr;
  bridge_rt_metal_device = nullptr;
  bridge_rt_schemas = nullptr;
  bridge_executor_create = nullptr;
  bridge_executor_destroy = nullptr;
  bridge_executor_render = nullptr;
}

} // namespace plugin
