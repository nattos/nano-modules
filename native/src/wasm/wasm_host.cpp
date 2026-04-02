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
  m.bytecode.assign(bytecode, bytecode + len);

  char error_buf[256] = {0};

  m.module = wasm_runtime_load(m.bytecode.data(), m.bytecode.size(),
                                error_buf, sizeof(error_buf));
  if (!m.module) {
    last_error_ = std::string("Failed to load module: ") + error_buf;
    return -1;
  }

  m.instance = wasm_runtime_instantiate(m.module, 16384, 16384,
                                         error_buf, sizeof(error_buf));
  if (!m.instance) {
    last_error_ = std::string("Failed to instantiate module: ") + error_buf;
    wasm_runtime_unload(m.module);
    return -1;
  }

  m.exec_env = wasm_runtime_create_exec_env(m.instance, 16384);
  if (!m.exec_env) {
    last_error_ = "Failed to create execution environment";
    wasm_runtime_deinstantiate(m.instance);
    wasm_runtime_unload(m.module);
    return -1;
  }

  m.context.host = this;

  int32_t id = next_id_++;
  modules_[id] = std::move(m);

  // Set user_data AFTER insertion so the pointer is stable
  auto& stored = modules_[id];
  wasm_runtime_set_user_data(stored.exec_env, &stored.context);

  return id;
}

void WasmHost::unload_module(int32_t module_id) {
  auto it = modules_.find(module_id);
  if (it == modules_.end()) return;
  cleanup_module(it->second);
  modules_.erase(it);
}

WasmHost::LoadedModule* WasmHost::find_module(int32_t id) {
  auto it = modules_.find(id);
  return it != modules_.end() ? &it->second : nullptr;
}

int32_t WasmHost::call_function(int32_t module_id, const char* func_name) {
  auto* m = find_module(module_id);
  if (!m) {
    last_error_ = "Module not found";
    return -1;
  }

  wasm_function_inst_t func = wasm_runtime_lookup_function(m->instance, func_name);
  if (!func) {
    last_error_ = std::string("Function not found: ") + func_name;
    return -1;
  }

  if (!wasm_runtime_call_wasm(m->exec_env, func, 0, nullptr)) {
    const char* exception = wasm_runtime_get_exception(m->instance);
    last_error_ = std::string("Execution failed: ") + (exception ? exception : "unknown");
    wasm_runtime_clear_exception(m->instance);
    return -1;
  }

  return 0;
}

int32_t WasmHost::call_function_f64(int32_t module_id, const char* func_name, double arg) {
  auto* m = find_module(module_id);
  if (!m) { last_error_ = "Module not found"; return -1; }

  wasm_function_inst_t func = wasm_runtime_lookup_function(m->instance, func_name);
  if (!func) { last_error_ = std::string("Function not found: ") + func_name; return -1; }

  wasm_val_t args[1] = {{.kind = WASM_F64, .of = {.f64 = arg}}};
  wasm_val_t results[1] = {};

  if (!wasm_runtime_call_wasm_a(m->exec_env, func, 0, results, 1, args)) {
    const char* exception = wasm_runtime_get_exception(m->instance);
    last_error_ = std::string("Execution failed: ") + (exception ? exception : "unknown");
    wasm_runtime_clear_exception(m->instance);
    return -1;
  }
  return 0;
}

int32_t WasmHost::call_function_i32_f64(int32_t module_id, const char* func_name,
                                         int32_t a, double b) {
  auto* m = find_module(module_id);
  if (!m) { last_error_ = "Module not found"; return -1; }

  wasm_function_inst_t func = wasm_runtime_lookup_function(m->instance, func_name);
  if (!func) { last_error_ = std::string("Function not found: ") + func_name; return -1; }

  wasm_val_t args[2] = {
    {.kind = WASM_I32, .of = {.i32 = a}},
    {.kind = WASM_F64, .of = {.f64 = b}},
  };
  wasm_val_t results[1] = {};

  if (!wasm_runtime_call_wasm_a(m->exec_env, func, 0, results, 2, args)) {
    const char* exception = wasm_runtime_get_exception(m->instance);
    last_error_ = std::string("Execution failed: ") + (exception ? exception : "unknown");
    wasm_runtime_clear_exception(m->instance);
    return -1;
  }
  return 0;
}

int32_t WasmHost::call_function_i32_i32(int32_t module_id, const char* func_name,
                                         int32_t a, int32_t b) {
  auto* m = find_module(module_id);
  if (!m) { last_error_ = "Module not found"; return -1; }

  wasm_function_inst_t func = wasm_runtime_lookup_function(m->instance, func_name);
  if (!func) { last_error_ = std::string("Function not found: ") + func_name; return -1; }

  wasm_val_t args[2] = {
    {.kind = WASM_I32, .of = {.i32 = a}},
    {.kind = WASM_I32, .of = {.i32 = b}},
  };
  wasm_val_t results[1] = {};

  if (!wasm_runtime_call_wasm_a(m->exec_env, func, 0, results, 2, args)) {
    const char* exception = wasm_runtime_get_exception(m->instance);
    last_error_ = std::string("Execution failed: ") + (exception ? exception : "unknown");
    wasm_runtime_clear_exception(m->instance);
    return -1;
  }
  return 0;
}

void WasmHost::set_draw_list(int32_t module_id, canvas::DrawList* dl) {
  auto* m = find_module(module_id);
  if (m) m->context.draw_list = dl;
}

void WasmHost::set_frame_state(int32_t module_id, FrameState* fs) {
  auto* m = find_module(module_id);
  if (m) m->context.frame_state = fs;
}

void WasmHost::set_audio_callback(int32_t module_id, AudioTriggerCallback cb, void* userdata) {
  auto* m = find_module(module_id);
  if (m) {
    m->context.audio_callback = cb;
    m->context.audio_userdata = userdata;
  }
}

void WasmHost::set_state_doc(int32_t module_id, bridge::StateDocument* doc) {
  auto* m = find_module(module_id);
  if (m) m->context.state_doc = doc;
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
