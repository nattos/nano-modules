#include "wasm/wasm_host.h"
#include "wasm/host_functions.h"

#include <cstring>

namespace wasm {

WasmHost::WasmHost(bridge::ParamCache& cache) : cache_(cache) {}

WasmHost::~WasmHost() {
  shutdown();
}

bool WasmHost::init() {
  if (initialized_) return true;

  if (!wasm_runtime_init()) {
    last_error_ = "Failed to initialize WAMR runtime";
    return false;
  }

  if (!register_host_functions()) {
    last_error_ = "Failed to register host functions";
    wasm_runtime_destroy();
    return false;
  }

  initialized_ = true;
  return true;
}

void WasmHost::shutdown() {
  if (!initialized_) return;

  // Unload all modules
  for (auto& [id, m] : modules_) {
    cleanup_module(m);
  }
  modules_.clear();

  wasm_runtime_destroy();
  initialized_ = false;
}

int32_t WasmHost::load_module(const uint8_t* bytecode, uint32_t len) {
  if (!initialized_) {
    last_error_ = "Runtime not initialized";
    return -1;
  }
  if (!bytecode || len == 0) {
    last_error_ = "Invalid bytecode";
    return -1;
  }

  LoadedModule m;
  // Copy bytecode — WAMR requires writable buffer that lives as long as the module
  m.bytecode.assign(bytecode, bytecode + len);

  char error_buf[256] = {0};

  m.module = wasm_runtime_load(m.bytecode.data(), m.bytecode.size(),
                                error_buf, sizeof(error_buf));
  if (!m.module) {
    last_error_ = std::string("Failed to load module: ") + error_buf;
    return -1;
  }

  m.instance = wasm_runtime_instantiate(m.module, 8192, 8192,
                                         error_buf, sizeof(error_buf));
  if (!m.instance) {
    last_error_ = std::string("Failed to instantiate module: ") + error_buf;
    wasm_runtime_unload(m.module);
    return -1;
  }

  m.exec_env = wasm_runtime_create_exec_env(m.instance, 8192);
  if (!m.exec_env) {
    last_error_ = "Failed to create execution environment";
    wasm_runtime_deinstantiate(m.instance);
    wasm_runtime_unload(m.module);
    return -1;
  }

  // Attach this WasmHost as user_data so host functions can find it
  wasm_runtime_set_user_data(m.exec_env, this);

  int32_t id = next_id_++;
  modules_[id] = std::move(m);
  return id;
}

void WasmHost::unload_module(int32_t module_id) {
  auto it = modules_.find(module_id);
  if (it == modules_.end()) return;
  cleanup_module(it->second);
  modules_.erase(it);
}

int32_t WasmHost::call_function(int32_t module_id, const char* func_name) {
  auto it = modules_.find(module_id);
  if (it == modules_.end()) {
    last_error_ = "Module not found";
    return -1;
  }

  auto& m = it->second;
  wasm_function_inst_t func = wasm_runtime_lookup_function(m.instance, func_name);
  if (!func) {
    last_error_ = std::string("Function not found: ") + func_name;
    return -1;
  }

  if (!wasm_runtime_call_wasm(m.exec_env, func, 0, nullptr)) {
    const char* exception = wasm_runtime_get_exception(m.instance);
    last_error_ = std::string("Execution failed: ") + (exception ? exception : "unknown");
    wasm_runtime_clear_exception(m.instance);
    return -1;
  }

  return 0;
}

void WasmHost::log(const std::string& msg) {
  if (log_callback_) {
    log_callback_(msg);
  }
}

void WasmHost::cleanup_module(LoadedModule& m) {
  if (m.exec_env) {
    wasm_runtime_destroy_exec_env(m.exec_env);
    m.exec_env = nullptr;
  }
  if (m.instance) {
    wasm_runtime_deinstantiate(m.instance);
    m.instance = nullptr;
  }
  if (m.module) {
    wasm_runtime_unload(m.module);
    m.module = nullptr;
  }
  m.bytecode.clear();
}

} // namespace wasm
