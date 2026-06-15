#pragma once
/*
 * exec_trace.h — editor-preview host ABI for the unified executor.wasm.
 *
 * The executor reports per-chain-entry texture handles (so the editor can show
 * each effect's input/output) and asks which entries are "monitored" so it can
 * split fused groups there (materialising the requested intermediate into a real
 * texture). Natively the barrel sets these as std::function hooks
 * (setChainEntryHook / setSketchOutputHook / setBarrierPredicate) directly on its
 * in-process executor; in the wasm build executor_create() wires those hooks to
 * these host imports instead (module "trace"), so the host (web engine worker /
 * native barrel WAMR) services them the same way it does gpu/effrt.
 *
 * Only REFERENCED under __wasm__ (executor_api.cpp guards the hook wiring with
 * #ifdef __wasm__); natively the attributes drop to plain declarations that are
 * never called/defined, so this header is inert in the native link.
 */

#include <cstdint>

#ifdef __wasm__
#define TRACE_IMPORT(nm) __attribute__((import_module("trace"), import_name(nm)))
#else
#define TRACE_IMPORT(nm)
#endif

extern "C" {

// A chain entry rendered: its input + output texture handles for (colIdx,chainIdx).
TRACE_IMPORT("chain_entry")
void trace_chain_entry(int32_t colIdx, int32_t chainIdx,
                       int32_t inputHandle, int32_t outputHandle,
                       int32_t w, int32_t h);

// The sketch's final output handle for this frame.
TRACE_IMPORT("sketch_output")
void trace_sketch_output(int32_t handle, int32_t w, int32_t h);

// Is (colIdx,chainIdx) monitored — i.e. must its output land in a real texture
// (split it out of any fused group)? Returns non-zero to force a barrier.
TRACE_IMPORT("is_barrier")
int32_t trace_is_barrier(int32_t colIdx, int32_t chainIdx);

}  // extern "C"
