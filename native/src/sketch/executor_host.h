#pragma once
/*
 * executor_host.h — native host integration for executor.wasm.
 *
 * Registers the "effrt" WAMR host functions (the executor's effect-orchestration
 * imports) over the native EffectRuntime. Call ONCE after WAMR init (it's
 * process-global), then effrtSetRuntime(rt) before each frame. The "gpu" imports
 * are covered by the standard gpu_symbols table in host_functions.cpp.
 */

namespace sketch_executor {

// Register the "effrt" namespace host functions. Returns false on failure.
bool registerEffrtHostFunctions();

}  // namespace sketch_executor
