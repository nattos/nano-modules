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

  // --- Generic dispatch primitives (for effect lifecycle, EffectDesc_v2). ---
  // The fixed-signature call_function_* helpers above cover bridge_server's
  // needs; effect modules need arbitrary-arity calls (on_state_patched has 6
  // args) and calls by indirect-function-table index (the EffectDesc_v2 fn
  // fields are table indices, not export names). These use WAMR's packed-argv
  // convention: `argv` is a buffer of uint32 slots (an f64/i64 occupies two);
  // arguments and results share it, so size it to max(arg_slots, result_slots)
  // and read results back from argv[0..] on success.

  /// Call an exported function by name with packed argv. Returns true on success.
  bool call_export_v(int32_t module_id, const char* func_name, uint32_t argc, uint32_t argv[]);
  /// Call a function by indirect-table index (an EffectDesc_v2 fn pointer).
  bool call_indirect(int32_t module_id, uint32_t func_idx, uint32_t argc, uint32_t argv[]);

  // --- Linear-memory access (for marshalling EffectDesc_v2 strings, patches). ---
  /// The loaded module instance / exec env, for host-function code that holds a
  /// module_id. nullptr if the id is unknown.
  wasm_module_inst_t module_inst(int32_t module_id);
  wasm_exec_env_t exec_env_for(int32_t module_id);
  /// Validate + translate a wasm app address to a native pointer. nullptr if the
  /// range is out of bounds or the address is 0.
  void* app_to_native(int32_t module_id, uint32_t app_addr, uint32_t size);
  /// Read a NUL-terminated string from linear memory. Empty on null/invalid.
  std::string read_cstring(int32_t module_id, uint32_t app_addr);

  /// Effects this module's nano_module_main registered (captured by the
  /// `module.register_effect` host import). Empty for an unknown id or a module
  /// whose nano_module_main hasn't been called yet.
  const std::vector<WasmEffectDesc>& registered_effects(int32_t module_id);

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
