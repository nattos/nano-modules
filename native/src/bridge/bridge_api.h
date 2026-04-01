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

// Function pointer typedefs for dlsym loading
typedef BridgeHandle (*BridgeInitFn)(void);
typedef void (*BridgeReleaseFn)(BridgeHandle);
typedef double (*BridgeGetParamFn)(BridgeHandle, int64_t);
typedef void (*BridgeSetParamFn)(BridgeHandle, int64_t, double);
typedef void (*BridgeTickFn)(BridgeHandle);
typedef int32_t (*BridgeLoadWasmFn)(BridgeHandle, const uint8_t*, uint32_t);
typedef void (*BridgeUnloadWasmFn)(BridgeHandle, int32_t);
typedef int32_t (*BridgeCallWasmFn)(BridgeHandle, int32_t, const char*);

#ifdef __cplusplus
}
#endif
