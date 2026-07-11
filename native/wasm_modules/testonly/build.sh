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

# particles_renderer — instanced quad VS reading a GPU storage buffer of
# particle positions + a trivial passthrough FS. No compute stage, so we
# invoke DXC directly for vs+ps (mirrors flash_particles in nano/build.sh).
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../particles_renderer/vertex.hlsl   -Fo "$TMP_DIR/particles_renderer_vertex.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../particles_renderer/fragment.hlsl -Fo "$TMP_DIR/particles_renderer_fragment.spv"
_emit_spv_header_var particles_renderer vertex fragment
echo "  particles_renderer shaders compiled (SPV: vertex + fragment)"

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

# rw_storage_test — read-write storage-texture round trip. Two storage
# textures of different formats: an r32f read_write scratch (pinned via
# [[vk::image_format]]) + an rgba8unorm write output (rewritten by the
# registerShaderSPV override). Plain SPV — no build-time sed.
compile_shaders_compute_spv rw_storage_test

# lut3d_test — 3D-texture round trip. init fills a 16^3 identity LUT
# (texture_storage_3d write), apply does a nearest-cell lookup (sampled
# texture_3d + storage_2d output). Storage formats (rgba8unorm) are supplied
# at registerShaderSPV time, so plain SPV variants suffice here.
compile_shaders_compute_var_spv lut3d_test init
compile_shaders_compute_var_spv lut3d_test apply
_emit_spv_header_var lut3d_test init apply
echo "  lut3d_test shaders compiled (SPV: init + apply)"

# motion_rect has two compute shaders (color + motion) compiled from
# separate .hlsl sources. The motion variant is registered with
# rgba16float so the velocity texture survives [-1,1] writes.
compile_shaders_compute_var_spv motion_rect color
compile_shaders_compute_var_spv motion_rect motion
_emit_spv_header_var motion_rect color motion
echo "  motion_rect shaders compiled (SPV: color + motion)"

# motion_swarm — multi-rect curl-field swarm; same color/motion pass
# layout as motion_rect but reads per-rect data from a storage buffer.
compile_shaders_compute_var_spv motion_swarm color
compile_shaders_compute_var_spv motion_swarm motion
_emit_spv_header_var motion_swarm color motion
echo "  motion_swarm shaders compiled (SPV: color + motion)"

# motion_static — per-pixel thresholded-noise velocity field; stress
# test for fine-grained vector input to motion_blur. Both shaders
# include common.hlsl (shared math) — no extra build step needed since
# DXC handles #include automatically.
compile_shaders_compute_var_spv motion_static color
compile_shaders_compute_var_spv motion_static motion
_emit_spv_header_var motion_static color motion
echo "  motion_static shaders compiled (SPV: color + motion)"

# motion_blur — velocity-pyramid McGuire reconstruction. Mirrored from
# core so render-outputs E2E tests can load testonly without pulling
# core in. See core/build.sh for shader semantics.
compile_shaders_compute_var_spv motion_blur reconstruct
compile_shaders_compute_var_spv motion_blur pyramid_reduce
_emit_spv_header_var motion_blur reconstruct pyramid_reduce
echo "  motion_blur shaders compiled (SPV: reconstruct + pyramid_reduce)"

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
  ../env_adsr/main.cpp \
  ../mod_remap/main.cpp \
  ../mod_combine/main.cpp \
  ../mod_smooth/main.cpp \
  ../mod_delay/main.cpp \
  ../mod_envelope/main.cpp \
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
  ../motion_swarm/main.cpp \
  ../motion_static/main.cpp \
  ../motion_blur/main.cpp \
  ../trap_test/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
