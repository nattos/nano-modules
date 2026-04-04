#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>
#include <functional>

#include "wasm_export.h"
#include "wasm/wasm_context.h"

namespace bridge {
class ParamCache;
}

namespace canvas {
struct DrawList;
}

namespace wasm {

/// Manages WAMR runtime and loaded WASM modules.
/// Supports dynamic loading/unloading of modules at runtime.
class WasmHost {
public:
  explicit WasmHost(bridge::ParamCache& cache);
  ~WasmHost();

  /// Initialize the WAMR runtime. Must be called once before loading modules.
  bool init();

  /// Shut down the WAMR runtime.
  void shutdown();

  bool is_initialized() const { return initialized_; }

  /// Load a WASM module from bytecode. Returns a module_id >= 0 on success, -1 on failure.
  int32_t load_module(const uint8_t* bytecode, uint32_t len);

  /// Unload a previously loaded module.
  void unload_module(int32_t module_id);

  /// Call an exported function by name (no arguments). Returns 0 on success, -1 on failure.
  int32_t call_function(int32_t module_id, const char* func_name);

  /// Call an exported function with a single f64 argument.
  int32_t call_function_f64(int32_t module_id, const char* func_name, double arg);

  /// Call an exported function with i32 + f64 arguments.
  int32_t call_function_i32_f64(int32_t module_id, const char* func_name, int32_t a, double b);

  /// Call an exported function with two i32 arguments.
  int32_t call_function_i32_i32(int32_t module_id, const char* func_name, int32_t a, int32_t b);

  /// Get the last error message.
  const std::string& last_error() const { return last_error_; }

  /// Log callback — set to capture log output (for testing).
  using LogCallback = std::function<void(const std::string&)>;
  void set_log_callback(LogCallback cb) { log_callback_ = std::move(cb); }

  bridge::ParamCache& param_cache() { return cache_; }

  void log(const std::string& msg);

  /// Set the DrawList for canvas host functions to write to.
  void set_draw_list(int32_t module_id, canvas::DrawList* dl);

  /// Set the FrameState for host timing/parameter functions.
  void set_frame_state(int32_t module_id, FrameState* fs);

  /// Set the audio trigger callback.
  void set_audio_callback(int32_t module_id, AudioTriggerCallback cb, void* userdata);

  /// Set the StateDocument for state host functions.
  void set_state_doc(int32_t module_id, bridge::StateDocument* doc);

  /// Set the GPU backend for gpu.* host functions.
  void set_gpu_backend(int32_t module_id, gpu::GPUBackend* backend);

private:
  struct LoadedModule {
    std::vector<uint8_t> bytecode;
    wasm_module_t module = nullptr;
    wasm_module_inst_t instance = nullptr;
    wasm_exec_env_t exec_env = nullptr;
    WasmContext context;
  };

  bridge::ParamCache& cache_;
  bool initialized_ = false;
  int32_t next_id_ = 0;
  std::unordered_map<int32_t, LoadedModule> modules_;
  std::string last_error_;
  LogCallback log_callback_;

  void cleanup_module(LoadedModule& m);
  LoadedModule* find_module(int32_t id);
};

} // namespace wasm
