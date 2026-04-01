#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>
#include <functional>

#include "wasm_export.h"

namespace bridge {
class ParamCache;
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
  /// The bytecode is copied internally.
  int32_t load_module(const uint8_t* bytecode, uint32_t len);

  /// Unload a previously loaded module.
  void unload_module(int32_t module_id);

  /// Call an exported function by name. Returns 0 on success, -1 on failure.
  int32_t call_function(int32_t module_id, const char* func_name);

  /// Get the last error message.
  const std::string& last_error() const { return last_error_; }

  /// Log callback — set to capture log output (for testing).
  using LogCallback = std::function<void(const std::string&)>;
  void set_log_callback(LogCallback cb) { log_callback_ = std::move(cb); }

  bridge::ParamCache& param_cache() { return cache_; }

  void log(const std::string& msg);

private:
  struct LoadedModule {
    std::vector<uint8_t> bytecode;     // Owned copy (WAMR requires writable buffer)
    wasm_module_t module = nullptr;
    wasm_module_inst_t instance = nullptr;
    wasm_exec_env_t exec_env = nullptr;
  };

  bridge::ParamCache& cache_;
  bool initialized_ = false;
  int32_t next_id_ = 0;
  std::unordered_map<int32_t, LoadedModule> modules_;
  std::string last_error_;
  LogCallback log_callback_;

  void cleanup_module(LoadedModule& m);
};

} // namespace wasm
