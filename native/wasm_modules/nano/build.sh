#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=nano

echo "=== Compiling shaders (nano) ==="
source ../wasm_build_env.sh

# motion_field — image-driven motion vector generator. Two compute
# shaders sharing common.hlsl (DXC handles #include automatically).
compile_shaders_compute_var_spv motion_field color
compile_shaders_compute_var_spv motion_field motion
_emit_spv_header_var motion_field color motion
echo "  motion_field shaders compiled (SPV: color + motion)"

# flash_particles — mask-driven particle compositor.
#   update  (compute) — per-particle lifetime + respawn.
#   prefill (compute) — copy a source tex (× scale) to a dest storage
#                       tex. Same SPV is registered twice with
#                       different storage-format hints (color = rgba8,
#                       motion = rgba16f) so each PSO gets the right
#                       naga substitution.
#   vs      (vertex)  — instanced quad vertex shader, shared by both
#                       fragment passes.
#   fs_color  (pixel) — color compositing, blends onto pre-filled
#                       tex_out. Two PSOs (alpha and additive blend)
#                       share this fragment.
#   fs_motion (pixel) — motion vectors with mask=alpha; alpha blend
#                       acts as a mask-controlled overwrite.
compile_shaders_compute_var_spv flash_particles update
compile_shaders_compute_var_spv flash_particles prefill
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../flash_particles/vs.hlsl -Fo "$TMP_DIR/flash_particles_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../flash_particles/fs_color.hlsl -Fo "$TMP_DIR/flash_particles_fs_color.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../flash_particles/fs_motion.hlsl -Fo "$TMP_DIR/flash_particles_fs_motion.spv"
_emit_spv_header_var flash_particles update prefill vs fs_color fs_motion
echo "  flash_particles shaders compiled (SPV: update + prefill + vs + fs_color + fs_motion)"

# local_delay — stylized motion-driven local delay. Pyramidal Lucas-Kanade
# flow + forward-advection lookup, sharing common.hlsl:
#   luma     — input → half-res Rec.601 luma (downsample first).
#   down     — 2x2 luma pyramid downsample (half→quarter→eighth).
#   lk       — windowed structure-tensor Lucas-Kanade, one level (run 3x).
#   upsample — half-res flow → full res.
#   align    — colinear flow polish + temporal flow EMA + mask + index.
#   color    — forward-advect along the flow, sample the input at the endpoint.
#   motion   — modulated render_outputs/motion.
# luma/down write r32float; lk/upsample/align/motion write rgba16f;
# color writes rgba8.
compile_shaders_compute_var_spv local_delay luma
compile_shaders_compute_var_spv local_delay down
compile_shaders_compute_var_spv local_delay lk
compile_shaders_compute_var_spv local_delay upsample
compile_shaders_compute_var_spv local_delay align
compile_shaders_compute_var_spv local_delay color
compile_shaders_compute_var_spv local_delay motion
_emit_spv_header_var local_delay luma down lk upsample align color motion
echo "  local_delay shaders compiled (SPV: luma+down+lk+upsample+align+color+motion)"

echo "=== Building WASM (nano) ==="

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
  ../nanolooper/main.cpp \
  ../nanolooper/core.cpp \
  ../motion_field/main.cpp \
  ../flash_particles/main.cpp \
  ../local_delay/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
