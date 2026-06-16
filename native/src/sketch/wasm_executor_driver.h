#pragma once
/*
 * wasm_executor_driver.h — host-side driver for executor.wasm.
 *
 * Loads the unified executor module (preferring an AOT-compiled `executor.aot`
 * when present, else `executor.wasm`), wires its effrt/gpu/trace host imports
 * against a native EffectRuntime + GPUBackend, and drives one frame per
 * execute() call. This is the SAME C++ executor source the in-process
 * `SketchExecutor` runs — so it's the path the FFGL barrel uses behind
 * NANO_BARREL_WASM_EXECUTOR and the `benchmark_barrel --wasm` perf comparison
 * uses, en route to retiring the in-process native executor.
 *
 * One driver owns one executor instance + its WamrHost. Not thread-safe; call
 * from the render thread only.
 */

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>

#include <nlohmann/json.hpp>

namespace bridge { class ParamCache; }
namespace wasm { class WasmHost; }
namespace gpu { class GPUBackend; }
namespace effect_runtime { class EffectRuntime; }

namespace sketch_executor {

class WasmExecutorDriver {
 public:
  WasmExecutorDriver();
  ~WasmExecutorDriver();
  WasmExecutorDriver(const WasmExecutorDriver&) = delete;
  WasmExecutorDriver& operator=(const WasmExecutorDriver&) = delete;

  /**
   * Load + prime. `wasmDir` is the directory holding executor.aot / executor.wasm.
   * `schemas` is the host's `module_type → schema-fields` map (e.g.
   * ModuleRegistry::schemas()) — the executor has no registry of its own and
   * walks the schemas the host hands it. Returns false (leaving valid() == false)
   * on any failure, so callers can fall back to the in-process executor.
   */
  bool init(const std::string& wasmDir,
            effect_runtime::EffectRuntime* rt,
            gpu::GPUBackend* gpu,
            const std::unordered_map<std::string, nlohmann::json>& schemas);

  bool valid() const { return valid_; }
  /** True if the loaded module was the AOT-compiled `executor.aot` (no interp). */
  bool usingAot() const { return usingAot_; }

  /**
   * Drive one frame. `rt` is rebound each call (effrt's runtime pointer is
   * process-global and the frame-local handle table is cleared on bind), so the
   * same driver can serve multiple runtimes across calls. `sketchJson` is the
   * serialized `{chain, instances, wires}` snapshot. `dirty` signals the sketch
   * may have changed (gates the executor's plan rebuild + state re-apply).
   * Returns the output texture handle, or `inHandle` on any failure.
   */
  int32_t execute(effect_runtime::EffectRuntime* rt,
                  const std::string& sketchJson,
                  int32_t inHandle, int32_t outHandle,
                  int W, int H, double dt, bool dirty);

 private:
  uint32_t push(const void* data, size_t len);

  std::unique_ptr<bridge::ParamCache> paramCache_;
  std::unique_ptr<wasm::WasmHost> host_;
  int32_t  module_    = -1;
  uint32_t ptr_       = 0;   // executor_create() handle
  uint32_t sketchOff_ = 0;   // reused linear-memory buffer for the sketch JSON
  uint32_t sketchCap_ = 0;
  bool valid_   = false;
  bool usingAot_ = false;
};

}  // namespace sketch_executor
