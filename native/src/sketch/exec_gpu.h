#pragma once
/*
 * exec_gpu.h — the GPU host ABI the unified executor (sketch_executor →
 * executor.wasm) calls. A focused SUBSET of the effect "gpu" ABI
 * (wasm_modules/include/gpu.h) plus a handful of executor-only ops effects
 * never use (per-stage render target, format query, submit-batch coalescing,
 * no-layout fused-chain PSO).
 *
 * Dual-impl, exactly like the effect headers: in the wasm32 build each function
 * resolves to a host import from the "gpu" module; in the native build the
 * attributes are dropped and the linker binds to the extern-C symbols in
 * native/src/runtime/gpu_impls.cpp (the SAME singleton-backend impls effects
 * use). Declared minimal + extern-C so it drags in no C++ wrappers / namespaces
 * that would clash with the native gpu/gpu_backend.h the executor also sees.
 */

#include <cstdint>

#ifdef __wasm__
#define EXEC_GPU_IMPORT(nm) __attribute__((import_module("gpu"), import_name(nm)))
#else
#define EXEC_GPU_IMPORT(nm)
#endif

extern "C" {

// Texture lifecycle / blits.
EXEC_GPU_IMPORT("create_texture")  int32_t gpu_create_texture(int32_t w, int32_t h, int32_t format);
EXEC_GPU_IMPORT("release")         void    gpu_release(int32_t handle);
EXEC_GPU_IMPORT("copy_texture")    void    gpu_copy_texture(int32_t src, int32_t dst);
EXEC_GPU_IMPORT("clear_texture")   void    gpu_clear_texture(int32_t tex, float r, float g, float b, float a);

// Executor-only host ops (see gpu_impls.cpp "Executor-only GPU ops").
EXEC_GPU_IMPORT("set_surface")        void    gpu_set_surface(int32_t tex, int32_t w, int32_t h);
EXEC_GPU_IMPORT("get_texture_format") int32_t gpu_get_texture_format(int32_t handle);
// Set the sketch working format (what TextureFormat::SketchDefault resolves
// to): 1 = RGBA8, 3 = RGBA16F. Called once per execute() from the sketch's
// outputFormat.bitDepth; effect texture/PSO creation resolves against it.
EXEC_GPU_IMPORT("set_default_texture_format") void gpu_set_default_texture_format(int32_t format);
// Live backend: 0 = Metal, 1 = WebGPU, -1 = none (gpu::Backend). Executor-side
// shader sources (the wet/dry blend) pick MSL vs WGSL from this — the executor
// runs as executor.wasm on BOTH backends, and create_shader_module compiles the
// source verbatim in the host's native language.
EXEC_GPU_IMPORT("get_backend")        int32_t gpu_get_backend(void);
EXEC_GPU_IMPORT("begin_submit_batch") void    gpu_begin_submit_batch(void);
EXEC_GPU_IMPORT("end_submit_batch")   void    gpu_end_submit_batch(void);

// Fused-chain compute kernel (no-layout PSO + shader module from generated src).
EXEC_GPU_IMPORT("create_shader_module") int32_t gpu_create_shader_module(const char* src, int32_t src_len);
EXEC_GPU_IMPORT("create_compute_pso")   int32_t gpu_create_compute_pso(int32_t shader, const char* entry, int32_t entry_len);

// Small uniform buffers (the wet/dry opacity blend pass).
EXEC_GPU_IMPORT("create_buffer") int32_t gpu_create_buffer(int32_t size, int32_t usage);
EXEC_GPU_IMPORT("write_buffer")  void    gpu_write_buffer(int32_t buf, int32_t offset, const void* data, int32_t data_len);

// Compute pass dispatch.
EXEC_GPU_IMPORT("begin_compute_pass") int32_t gpu_begin_compute_pass(void);
EXEC_GPU_IMPORT("compute_set_pso")    void    gpu_compute_set_pso(int32_t pass, int32_t pso);
EXEC_GPU_IMPORT("compute_set_texture")void    gpu_compute_set_texture(int32_t pass, int32_t tex, int32_t slot, int32_t access);
EXEC_GPU_IMPORT("compute_set_buffer") void    gpu_compute_set_buffer(int32_t pass, int32_t buf, int32_t offset, int32_t slot);
EXEC_GPU_IMPORT("compute_dispatch")   void    gpu_compute_dispatch(int32_t pass, int32_t x, int32_t y, int32_t z);
EXEC_GPU_IMPORT("end_compute_pass")   void    gpu_end_compute_pass(int32_t pass);

}  // extern "C"
