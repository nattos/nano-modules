#pragma once

#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

typedef void* BridgeHandle;

// Lifecycle — ref-counted singleton
BridgeHandle bridge_init(void);
void bridge_release(BridgeHandle h);

// Parameter access
double bridge_get_param(BridgeHandle h, int64_t param_id);
void bridge_set_param(BridgeHandle h, int64_t param_id, double value);

// Frame tick — poll WS inbox, flush outbox
void bridge_tick(BridgeHandle h);

// Dynamic WASM loading
int32_t bridge_load_wasm(BridgeHandle h, const uint8_t* bytecode, uint32_t len);
void bridge_unload_wasm(BridgeHandle h, int32_t module_id);
int32_t bridge_call_wasm(BridgeHandle h, int32_t module_id, const char* func_name);

// Per-frame state for WASM module rendering
void bridge_set_frame_state(BridgeHandle h, int32_t module_id,
    double elapsed, double dt, double bar_phase, double bpm,
    int vp_w, int vp_h);
void bridge_set_ffgl_param(BridgeHandle h, int32_t module_id, int index, double value);

// WASM render: calls module's render(vp_w, vp_h), returns DrawList pointer
void* bridge_render(BridgeHandle h, int32_t module_id, int vp_w, int vp_h);

// WASM tick with delta time
int32_t bridge_call_tick(BridgeHandle h, int32_t module_id, double dt);

// WASM on_param_change(index, value)
int32_t bridge_call_on_param(BridgeHandle h, int32_t module_id, int index, double value);

// Audio trigger callback
typedef void (*AudioTriggerCallback)(int channel, void* userdata);
void bridge_set_audio_callback(BridgeHandle h, int32_t module_id,
    AudioTriggerCallback fn, void* userdata);

// --- Multiplexed plugin instances (FFGL barrel) ---
// JSON crosses as UTF-8 strings. Strings returned by bridge_get_* are heap
// allocated by the dylib and MUST be freed with bridge_free_string.

// Register an instance. `requested_key` may be empty (server mints <id>@<n>)
// or a stable UUID. Writes the ACTUAL key (may differ on collision) into
// out_key (NUL-terminated, truncated to cap) and returns the full key length.
int32_t bridge_register_plugin(BridgeHandle h, const char* id,
    int major, int minor, int patch,
    const char* schema_json, const char* requested_key,
    char* out_key, int32_t out_key_cap);
void bridge_unregister_plugin(BridgeHandle h, const char* key);

// Per-key change notification (fires when a client patches this instance).
typedef void (*BridgePatchListenerFn)(const char* key, void* userdata);
void bridge_register_patch_listener(BridgeHandle h, const char* key,
    BridgePatchListenerFn fn, void* userdata);
void bridge_unregister_patch_listener(BridgeHandle h, const char* key);

// State document access.
void  bridge_set_plugin_state(BridgeHandle h, const char* key, const char* json);
char* bridge_get_plugin_state(BridgeHandle h, const char* key);   // free w/ bridge_free_string
void  bridge_set_at(BridgeHandle h, const char* path, const char* json);
char* bridge_get_at(BridgeHandle h, const char* path);            // free w/ bridge_free_string
void  bridge_free_string(char* s);

// Out-of-band binary broadcast (preview frames) + gating.
void bridge_broadcast_binary(BridgeHandle h, const uint8_t* data, uint32_t len);
int  bridge_has_clients(BridgeHandle h);
int  bridge_key_observed(BridgeHandle h, const char* key);

// Function pointer typedefs for dlsym loading
typedef BridgeHandle (*BridgeInitFn)(void);
typedef void (*BridgeReleaseFn)(BridgeHandle);
typedef double (*BridgeGetParamFn)(BridgeHandle, int64_t);
typedef void (*BridgeSetParamFn)(BridgeHandle, int64_t, double);
typedef void (*BridgeTickFn)(BridgeHandle);
typedef int32_t (*BridgeLoadWasmFn)(BridgeHandle, const uint8_t*, uint32_t);
typedef void (*BridgeUnloadWasmFn)(BridgeHandle, int32_t);
typedef int32_t (*BridgeCallWasmFn)(BridgeHandle, int32_t, const char*);
typedef void (*BridgeSetFrameStateFn)(BridgeHandle, int32_t, double, double, double, double, int, int);
typedef void (*BridgeSetFfglParamFn)(BridgeHandle, int32_t, int, double);
typedef void* (*BridgeRenderFn)(BridgeHandle, int32_t, int, int);
typedef int32_t (*BridgeCallTickFn)(BridgeHandle, int32_t, double);
typedef int32_t (*BridgeCallOnParamFn)(BridgeHandle, int32_t, int, double);
typedef void (*BridgeSetAudioCallbackFn)(BridgeHandle, int32_t, AudioTriggerCallback, void*);

typedef int32_t (*BridgeRegisterPluginFn)(BridgeHandle, const char*, int, int, int, const char*, const char*, char*, int32_t);
typedef void (*BridgeUnregisterPluginFn)(BridgeHandle, const char*);
typedef void (*BridgeRegisterPatchListenerFn)(BridgeHandle, const char*, BridgePatchListenerFn, void*);
typedef void (*BridgeUnregisterPatchListenerFn)(BridgeHandle, const char*);
typedef void (*BridgeSetPluginStateFn)(BridgeHandle, const char*, const char*);
typedef char* (*BridgeGetPluginStateFn)(BridgeHandle, const char*);
typedef void (*BridgeSetAtFn)(BridgeHandle, const char*, const char*);
typedef char* (*BridgeGetAtFn)(BridgeHandle, const char*);
typedef void (*BridgeFreeStringFn)(char*);
typedef void (*BridgeBroadcastBinaryFn)(BridgeHandle, const uint8_t*, uint32_t);
typedef int (*BridgeHasClientsFn)(BridgeHandle);
typedef int (*BridgeKeyObservedFn)(BridgeHandle, const char*);

#ifdef __cplusplus
}
#endif
