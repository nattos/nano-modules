#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=testonly

echo "=== Compiling shaders (testonly) ==="
source ../wasm_build_env.sh
compile_shaders_compute brightness_contrast
compile_shaders_compute solid_color
compile_shaders_compute video_blend
# Test-only fusion-aware mappers + generator — back the multi-stage
# fusion tests (mapper + mapper) and the strict-output top tests
# (generator + mapper).
compile_shaders_compute_fused fuse_add
compile_shaders_compute_fused fuse_mul
compile_shaders_compute_fused fuse_solid
compile_shaders_full gpu_test
compile_shaders_full spinningtris

# hdr_test compiles the same compute.hlsl twice with different output
# storage formats so the same shader can write to either an rgba16float
# scratch (out16f) or the rgba8unorm visible target (out8).
compile_shaders_compute_var hdr_test out16f rgba16float
compile_shaders_compute_var hdr_test out8   rgba8unorm
_emit_shader_header hdr_test out16f out8
echo "  hdr_test shaders compiled (out16f + out8)"

# atomic_test has two shaders: a counting compute pass (no storage texture
# output, so format is irrelevant — pick anything) and a visualize pass
# that writes the rgba8unorm output. Both compile from their own .hlsl.
compile_shaders_compute_var atomic_test count     rgba8unorm write count
compile_shaders_compute_var atomic_test visualize rgba8unorm write visualize
_emit_shader_header atomic_test count visualize
echo "  atomic_test shaders compiled (count + visualize)"

# mrt_test has all three stages: vertex, fragment (writes 2 targets),
# and a combine compute pass.
compile_shaders_full mrt_test

echo "=== Building WASM (testonly) ==="

WASM_COMMON_EXPORTS=(
  -Wl,--export=nano_module_main
  -Wl,--export=malloc
  -Wl,--export=free
  -Wl,--export=__indirect_function_table
)

wasm_build \
  -I"$TMP_DIR" \
  -I../include \
  -I../../src \
  main.cpp \
  ../brightness_contrast/main.cpp \
  ../solid_color/main.cpp \
  ../video_blend/main.cpp \
  ../fuse_add/main.cpp \
  ../fuse_mul/main.cpp \
  ../fuse_solid/main.cpp \
  ../env_lfo/main.cpp \
  ../gpu_test/main.cpp \
  ../spinningtris/main.cpp \
  ../particles_emitter/main.cpp \
  ../particles_renderer/main.cpp \
  ../hdr_test/main.cpp \
  ../atomic_test/main.cpp \
  ../rw_storage_test/main.cpp \
  ../clear_copy_test/main.cpp \
  ../mrt_test/main.cpp \
  ../lut3d_test/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
