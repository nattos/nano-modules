#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=testonly

echo "=== Compiling shaders (testonly) ==="
source ../wasm_build_env.sh
compile_shaders_compute_fused_spv brightness_contrast
compile_shaders_compute_fused_spv solid_color
compile_shaders_compute_spv video_blend
# Test-only fusion-aware mappers + generator — back the multi-stage
# fusion tests (mapper + mapper) and the strict-output top tests
# (generator + mapper).
compile_shaders_compute_fused_spv fuse_add
compile_shaders_compute_fused_spv fuse_mul
compile_shaders_compute_fused_spv fuse_solid
compile_shaders_full_spv gpu_test
compile_shaders_full_spv spinningtris

# hdr_test compiles the same compute.hlsl twice; the SPV is identical
# for both variants, but the runtime registers each under its own name
# with a different storage-format hint so naga emits matching
# `texture_storage_2d<...>` declarations.
compile_shaders_compute_var_spv hdr_test out16f compute
compile_shaders_compute_var_spv hdr_test out8   compute
_emit_spv_header_var hdr_test out16f out8
echo "  hdr_test shaders compiled (SPV: out16f + out8)"

# atomic_test has two shaders compiled from separate .hlsl files.
compile_shaders_compute_var_spv atomic_test count
compile_shaders_compute_var_spv atomic_test visualize
_emit_spv_header_var atomic_test count visualize
echo "  atomic_test shaders compiled (SPV: count + visualize)"

# mrt_test has all three stages: vertex, fragment (writes 2 targets),
# and a combine compute pass.
compile_shaders_full_spv mrt_test

# motion_rect has two compute shaders (color + motion) compiled from
# separate .hlsl sources. The motion variant is registered with
# rgba16float so the velocity texture survives [-1,1] writes.
compile_shaders_compute_var_spv motion_rect color
compile_shaders_compute_var_spv motion_rect motion
_emit_spv_header_var motion_rect color motion
echo "  motion_rect shaders compiled (SPV: color + motion)"

# motion_blur is the production consumer of the RenderOutputs rail.
# Mirrored into the testonly bundle so render-outputs E2E tests can
# exercise the producer + consumer pair without pulling in `core`.
compile_shaders_compute_spv motion_blur

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
  ../lut3d_test/main.cpp \
  ../motion_rect/main.cpp \
  ../motion_blur/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
