// executor_api.cpp — the C ABI executor.wasm exports for its host (the native
// barrel / the web engine worker). The host instantiates one executor, pushes
// each effect's schema once, then drives a frame per tick. Sketch + schema JSON
// cross as (ptr,len) into the module's linear memory (host writes via malloc).
//
// The executor drives effects + GPU through the effrt/gpu host IMPORTS — the
// host wires those to its EffectRuntime + GPUBackend (native) or WasmHost +
// GPUHost (web). So executor_create takes no backend: the runtime lives in the
// host, reached through the imports.

#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

#include "sketch/sketch_executor.h"
#include "sketch/exec_trace.h"

#ifdef __wasm__
#define EXEC_EXPORT(nm) __attribute__((export_name(nm)))
#else
#define EXEC_EXPORT(nm)
#endif

using sketch_executor::SketchExecutor;

extern "C" {

EXEC_EXPORT("executor_create")
SketchExecutor* executor_create() {
  // No native backend pointers — the wasm executor reaches its runtime through
  // the effrt/gpu imports; the #ifndef __wasm__ runtime-bind/seed in execute()
  // is compiled out.
  SketchExecutor* ex = new SketchExecutor(nullptr, nullptr, nullptr);
#ifdef __wasm__
  // Route the editor-preview hooks to the "trace" host imports (natively the
  // barrel sets these std::functions directly on its in-process executor).
  ex->setChainEntryHook([](int colIdx, int chainIdx, int32_t in, int32_t out,
                           int w, int h) {
    trace_chain_entry(colIdx, chainIdx, in, out, w, h);
  });
  ex->setSketchOutputHook([](int32_t handle, int w, int h) {
    trace_sketch_output(handle, w, h);
  });
  ex->setBarrierPredicate([](int colIdx, int chainIdx) -> bool {
    return trace_is_barrier(colIdx, chainIdx) != 0;
  });
#endif
  return ex;
}

EXEC_EXPORT("executor_destroy")
void executor_destroy(SketchExecutor* ex) { delete ex; }

// Force-disable GPU fusion (every stage takes the standalone path). Mirrors the
// web debug "fusion mode" toggle: force-off → 0, auto/force-on → 1. The native
// barrel doesn't drive this; it exists so the web host's setFusionMode keeps
// working once executor.wasm is the sole web executor.
EXEC_EXPORT("executor_set_fusion_enabled")
void executor_set_fusion_enabled(SketchExecutor* ex, int32_t enabled) {
  if (ex) ex->setFusionEnabled(enabled != 0);
}

// Push (or replace) one module's schema. `schema` is the `fields` sub-object
// JSON. Must be called for every effect the sketch references before execute().
EXEC_EXPORT("executor_register_schema")
void executor_register_schema(SketchExecutor* ex, const char* mt, int32_t mt_len,
                              const char* schema, int32_t schema_len) {
  if (!ex) return;
  auto fields = nlohmann::json::parse(std::string(schema, schema_len), nullptr, false);
  if (fields.is_discarded()) return;
  ex->registerModuleSchema(std::string(mt, mt_len), fields);
}

// Render one frame. `sketch` is the {chain|columns, instances, wires} JSON.
// Returns the output texture handle (or `inTex` for a passthrough). `dirty`
// signals the sketch changed since last frame (rebuild the plan).
EXEC_EXPORT("executor_execute")
int32_t executor_execute(SketchExecutor* ex, const char* sketch, int32_t sketch_len,
                         int32_t inTex, int32_t outTex, int32_t W, int32_t H,
                         double dt, int32_t dirty) {
  if (!ex) return inTex;
  auto j = nlohmann::json::parse(std::string(sketch, sketch_len), nullptr, false);
  if (j.is_discarded()) return inTex;
  return ex->execute(j, inTex, outTex, W, H, dt, dirty != 0);
}

// Write the LAST execute()'s 7 debug counters into `out` (host-allocated, ≥7
// int32s): [effectsExecuted, standaloneDispatches, fusedRuns, fusedStages,
// dispatchesSaved, gpuDispatches, identitySkipped]. The web host reads these
// into its per-frame DebugStats accumulator for the editor's Debug Info panel.
EXEC_EXPORT("executor_debug_stats")
void executor_debug_stats(SketchExecutor* ex, int32_t* out) {
  if (!ex || !out) return;
  ex->fillDebugStats(out);
}

}  // extern "C"
