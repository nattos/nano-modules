#pragma once

#include "wasm_export.h"

namespace wasm {

/// Register host functions with WAMR under module name "env".
/// Must be called before loading any WASM modules.
bool register_host_functions();

// Host function implementations (called from WASM)
double host_resolume_get_param(wasm_exec_env_t env, int64_t param_id);
void host_resolume_set_param(wasm_exec_env_t env, int64_t param_id, double value);
void host_log(wasm_exec_env_t env, int32_t msg_ptr, int32_t msg_len);

} // namespace wasm
