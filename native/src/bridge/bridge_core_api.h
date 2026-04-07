#pragma once

#include <stdint.h>

/// C API for BridgeCore, exported from bridge_core.wasm.
/// Also usable from native code for testing.

#ifdef __cplusplus
extern "C" {
#endif

typedef void* BridgeCoreHandle;

// --- Lifecycle ---
BridgeCoreHandle bridge_core_create(void);
void bridge_core_destroy(BridgeCoreHandle h);

// --- Tick (call each frame to broadcast pending state patches) ---
void bridge_core_tick(BridgeCoreHandle h);

// --- Client management ---
int bridge_core_connect_client(BridgeCoreHandle h);
void bridge_core_disconnect_client(BridgeCoreHandle h, int client_id);

// --- Loopback transport ---
// Push a message from a client into the bridge core.
void bridge_core_receive_message(BridgeCoreHandle h, int client_id,
                                  const char* msg, int msg_len);

// Poll for the next outgoing message to a specific client.
// Returns the message length, or 0 if no messages pending.
// The message is written into the provided buffer.
int bridge_core_poll_outgoing(BridgeCoreHandle h, int client_id,
                               char* buf, int buf_len);

// --- Plugin registration (called by host functions on behalf of WASM modules) ---
// Returns the length of the assigned key written to key_buf.
int bridge_core_register_plugin(BridgeCoreHandle h,
                                 const char* id, int id_len,
                                 int ver_major, int ver_minor, int ver_patch,
                                 char* key_buf, int key_buf_len);

// Register with a full schema JSON. Returns key length written to key_buf.
int bridge_core_register_with_schema(BridgeCoreHandle h,
                                      const char* id, int id_len,
                                      int ver_major, int ver_minor, int ver_patch,
                                      const char* schema_json, int schema_json_len,
                                      char* key_buf, int key_buf_len);

void bridge_core_declare_param(BridgeCoreHandle h,
                                const char* plugin_key, int plugin_key_len,
                                int index,
                                const char* name, int name_len,
                                int type, float default_value);

void bridge_core_log(BridgeCoreHandle h,
                      const char* plugin_key, int plugin_key_len,
                      double timestamp, int level,
                      const char* msg, int msg_len);

void bridge_core_log_structured(BridgeCoreHandle h,
                                 const char* plugin_key, int plugin_key_len,
                                 double timestamp, int level,
                                 const char* msg, int msg_len,
                                 const char* json_data, int json_len);

// --- Plugin state ---
void bridge_core_set_plugin_state(BridgeCoreHandle h,
                                   const char* plugin_key, int plugin_key_len,
                                   const char* json_state, int json_len);

// Returns length of JSON written to buf, or 0 on error.
int bridge_core_get_plugin_state(BridgeCoreHandle h,
                                  const char* plugin_key, int plugin_key_len,
                                  char* buf, int buf_len);

// Apply client patches to plugin state.
void bridge_core_apply_client_patch(BridgeCoreHandle h,
                                     const char* plugin_key, int plugin_key_len,
                                     const char* patch_json, int patch_len);

// --- I/O port declarations ---
void bridge_core_declare_io(BridgeCoreHandle h,
                             const char* plugin_key, int plugin_key_len,
                             int index,
                             const char* name, int name_len,
                             int kind, int role);

// --- Resolume param cache ---
double bridge_core_get_param(BridgeCoreHandle h, int64_t param_id);
void bridge_core_set_param(BridgeCoreHandle h, int64_t param_id, double value);
void bridge_core_queue_param_write(BridgeCoreHandle h, int64_t param_id, double value);

// --- Param path registry ---
void bridge_core_set_param_path(BridgeCoreHandle h, int64_t param_id,
                                 const char* path, int path_len);
int bridge_core_get_param_path(BridgeCoreHandle h, int64_t param_id,
                                char* buf, int buf_len);

// --- State document queries ---
// Get a subtree by JSON Pointer path. Returns JSON length written to buf.
int bridge_core_get_at(BridgeCoreHandle h,
                        const char* path, int path_len,
                        char* buf, int buf_len);

// Set a value at an arbitrary path in the state document.
void bridge_core_set_at(BridgeCoreHandle h,
                         const char* path, int path_len,
                         const char* json_value, int json_len);

// Get the plugin key for a registered plugin by its ID (e.g. "com.nattos.nanolooper").
// Returns key length, or 0 if not found.
int bridge_core_get_plugin_key(BridgeCoreHandle h,
                                const char* id, int id_len,
                                char* key_buf, int key_buf_len);

// --- Val handle store ---
// Handle-based JSON value container. Bridge core owns the data;
// callers hold integer handles. Used by WASM modules via host functions.
int bridge_core_val_null(BridgeCoreHandle h);
int bridge_core_val_bool(BridgeCoreHandle h, int v);
int bridge_core_val_number(BridgeCoreHandle h, double v);
int bridge_core_val_string(BridgeCoreHandle h, const char* s, int len);
int bridge_core_val_array(BridgeCoreHandle h);
int bridge_core_val_object(BridgeCoreHandle h);

int bridge_core_val_type_of(BridgeCoreHandle h, int val_h);
double bridge_core_val_as_number(BridgeCoreHandle h, int val_h);
int bridge_core_val_as_bool(BridgeCoreHandle h, int val_h);
int bridge_core_val_as_string(BridgeCoreHandle h, int val_h, char* buf, int buf_len);

int bridge_core_val_get(BridgeCoreHandle h, int obj_h, const char* key, int key_len);
void bridge_core_val_set(BridgeCoreHandle h, int obj_h, const char* key, int key_len, int val_h);
int bridge_core_val_keys_count(BridgeCoreHandle h, int obj_h);
int bridge_core_val_key_at(BridgeCoreHandle h, int obj_h, int index, char* buf, int buf_len);

int bridge_core_val_get_index(BridgeCoreHandle h, int arr_h, int index);
void bridge_core_val_push(BridgeCoreHandle h, int arr_h, int val_h);
int bridge_core_val_length(BridgeCoreHandle h, int arr_h);

void bridge_core_val_release(BridgeCoreHandle h, int val_h);
int bridge_core_val_to_json(BridgeCoreHandle h, int val_h, char* buf, int buf_len);

// --- Direct state commit via val handle (no JSON serialization) ---
// Writes a val handle's value directly into a plugin's state document.
// If path is empty, replaces the entire plugin state.
// If path is provided (e.g. "field_name"), sets that field within the state.
void bridge_core_commit_val(BridgeCoreHandle h,
                             const char* plugin_key, int plugin_key_len,
                             const char* path, int path_len,
                             int val_h);

#ifdef __cplusplus
}
#endif
