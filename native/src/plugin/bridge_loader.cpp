#include "plugin/bridge_loader.h"

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace plugin {
namespace {

// The three calls that differ. RTLD_GLOBAL has no Windows analogue and needs
// none: a DLL's exports are visible to every later GetProcAddress by handle,
// and nothing here resolves a symbol without one.
void* openLibrary(const char* path) {
#ifdef _WIN32
  return (void*)LoadLibraryA(path);
#else
  return dlopen(path, RTLD_NOW | RTLD_GLOBAL);
#endif
}

void* findSymbol(void* handle, const char* name) {
#ifdef _WIN32
  return (void*)GetProcAddress((HMODULE)handle, name);
#else
  return dlsym(handle, name);
#endif
}

void closeLibrary(void* handle) {
#ifdef _WIN32
  FreeLibrary((HMODULE)handle);
#else
  dlclose(handle);
#endif
}

}  // namespace

BridgeLoader::~BridgeLoader() {
  unload();
}

bool BridgeLoader::load(const char* lib_path) {
  if (handle_) return true;

  handle_ = openLibrary(lib_path);
  if (!handle_) return false;

  // Core functions
  bridge_init = reinterpret_cast<BridgeInitFn>(findSymbol(handle_, "bridge_init"));
  bridge_release = reinterpret_cast<BridgeReleaseFn>(findSymbol(handle_, "bridge_release"));
  bridge_get_param = reinterpret_cast<BridgeGetParamFn>(findSymbol(handle_, "bridge_get_param"));
  bridge_set_param = reinterpret_cast<BridgeSetParamFn>(findSymbol(handle_, "bridge_set_param"));
  bridge_tick = reinterpret_cast<BridgeTickFn>(findSymbol(handle_, "bridge_tick"));
  bridge_load_wasm = reinterpret_cast<BridgeLoadWasmFn>(findSymbol(handle_, "bridge_load_wasm"));
  bridge_unload_wasm = reinterpret_cast<BridgeUnloadWasmFn>(findSymbol(handle_, "bridge_unload_wasm"));
  bridge_call_wasm = reinterpret_cast<BridgeCallWasmFn>(findSymbol(handle_, "bridge_call_wasm"));

  // Extended functions
  bridge_set_frame_state = reinterpret_cast<BridgeSetFrameStateFn>(findSymbol(handle_, "bridge_set_frame_state"));
  bridge_set_ffgl_param = reinterpret_cast<BridgeSetFfglParamFn>(findSymbol(handle_, "bridge_set_ffgl_param"));
  bridge_render = reinterpret_cast<BridgeRenderFn>(findSymbol(handle_, "bridge_render"));
  bridge_call_tick = reinterpret_cast<BridgeCallTickFn>(findSymbol(handle_, "bridge_call_tick"));
  bridge_call_on_param = reinterpret_cast<BridgeCallOnParamFn>(findSymbol(handle_, "bridge_call_on_param"));
  bridge_set_audio_callback = reinterpret_cast<BridgeSetAudioCallbackFn>(findSymbol(handle_, "bridge_set_audio_callback"));
  bridge_add_audio_listener = reinterpret_cast<BridgeAddAudioListenerFn>(findSymbol(handle_, "bridge_add_audio_listener"));
  bridge_remove_audio_listener = reinterpret_cast<BridgeRemoveAudioListenerFn>(findSymbol(handle_, "bridge_remove_audio_listener"));

  // Multiplexed-instance functions (FFGL barrel). Not in the required-symbol
  // check below so older dylibs still load for the looper/repatch path; the
  // barrel checks the specific pointers it needs before first use.
  bridge_register_plugin = reinterpret_cast<BridgeRegisterPluginFn>(findSymbol(handle_, "bridge_register_plugin"));
  bridge_unregister_plugin = reinterpret_cast<BridgeUnregisterPluginFn>(findSymbol(handle_, "bridge_unregister_plugin"));
  bridge_register_patch_listener = reinterpret_cast<BridgeRegisterPatchListenerFn>(findSymbol(handle_, "bridge_register_patch_listener"));
  bridge_unregister_patch_listener = reinterpret_cast<BridgeUnregisterPatchListenerFn>(findSymbol(handle_, "bridge_unregister_patch_listener"));
  bridge_set_plugin_state = reinterpret_cast<BridgeSetPluginStateFn>(findSymbol(handle_, "bridge_set_plugin_state"));
  bridge_get_plugin_state = reinterpret_cast<BridgeGetPluginStateFn>(findSymbol(handle_, "bridge_get_plugin_state"));
  bridge_set_at = reinterpret_cast<BridgeSetAtFn>(findSymbol(handle_, "bridge_set_at"));
  bridge_get_at = reinterpret_cast<BridgeGetAtFn>(findSymbol(handle_, "bridge_get_at"));
  bridge_free_string = reinterpret_cast<BridgeFreeStringFn>(findSymbol(handle_, "bridge_free_string"));
  bridge_broadcast_binary = reinterpret_cast<BridgeBroadcastBinaryFn>(findSymbol(handle_, "bridge_broadcast_binary"));
  bridge_has_clients = reinterpret_cast<BridgeHasClientsFn>(findSymbol(handle_, "bridge_has_clients"));
  bridge_key_observed = reinterpret_cast<BridgeKeyObservedFn>(findSymbol(handle_, "bridge_key_observed"));

  bridge_rt_acquire = reinterpret_cast<BridgeRtAcquireFn>(findSymbol(handle_, "bridge_rt_acquire"));
  bridge_rt_release = reinterpret_cast<BridgeRtReleaseFn>(findSymbol(handle_, "bridge_rt_release"));
  bridge_rt_gpu_device = reinterpret_cast<BridgeRtGpuDeviceFn>(findSymbol(handle_, "bridge_rt_gpu_device"));
  bridge_rt_schemas = reinterpret_cast<BridgeRtSchemasFn>(findSymbol(handle_, "bridge_rt_schemas"));
  bridge_executor_create = reinterpret_cast<BridgeExecutorCreateFn>(findSymbol(handle_, "bridge_executor_create"));
  bridge_executor_destroy = reinterpret_cast<BridgeExecutorDestroyFn>(findSymbol(handle_, "bridge_executor_destroy"));
  bridge_executor_render = reinterpret_cast<BridgeExecutorRenderFn>(findSymbol(handle_, "bridge_executor_render"));

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
    closeLibrary(handle_);
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
  bridge_add_audio_listener = nullptr;
  bridge_remove_audio_listener = nullptr;
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
  bridge_rt_gpu_device = nullptr;
  bridge_rt_schemas = nullptr;
  bridge_executor_create = nullptr;
  bridge_executor_destroy = nullptr;
  bridge_executor_render = nullptr;
}

} // namespace plugin
