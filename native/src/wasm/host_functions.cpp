#include "wasm/host_functions.h"
#include "wasm/wasm_host.h"
#include "bridge/param_cache.h"

#include <cstring>

namespace wasm {

// Access the WasmHost from the exec env's user_data
static WasmHost* get_host(wasm_exec_env_t env) {
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  return static_cast<WasmHost*>(wasm_runtime_get_user_data(env));
}

double host_resolume_get_param(wasm_exec_env_t env, int64_t param_id) {
  auto* host = get_host(env);
  if (!host) return 0.0;
  return host->param_cache().get(param_id);
}

void host_resolume_set_param(wasm_exec_env_t env, int64_t param_id, double value) {
  auto* host = get_host(env);
  if (!host) return;
  host->param_cache().set(param_id, value);
  host->param_cache().queue_write(param_id, value);
}

void host_log(wasm_exec_env_t env, int32_t msg_ptr, int32_t msg_len) {
  auto* host = get_host(env);
  if (!host) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, msg_ptr, msg_len)) return;

  char* native_ptr = static_cast<char*>(
      wasm_runtime_addr_app_to_native(inst, msg_ptr));
  if (!native_ptr) return;

  std::string msg(native_ptr, msg_len);
  host->log(msg);
}

// Native symbol table — must be static (WAMR does not copy it)
static NativeSymbol native_symbols[] = {
    {"resolume_get_param", reinterpret_cast<void*>(host_resolume_get_param), "(I)F", nullptr},
    {"resolume_set_param", reinterpret_cast<void*>(host_resolume_set_param), "(IF)", nullptr},
    {"log", reinterpret_cast<void*>(host_log), "(ii)", nullptr},
};

bool register_host_functions() {
  return wasm_runtime_register_natives(
      "env",
      native_symbols,
      sizeof(native_symbols) / sizeof(NativeSymbol));
}

} // namespace wasm
