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

#ifdef __cplusplus
}
#endif
