#!/bin/bash
# legacy — ports of shipped dnode/NanoGraph effects (com.nano.legacy).
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=legacy

echo "=== Compiling shaders (legacy) ==="
source ../wasm_build_env.sh

# bicolor_grad — content-adaptive two-colour gradient.
#   hist    (compute) — RGB→YIQ hue histogram, atomic scatter into 64 bins.
#   analyze (compute, 1 thread) — pick major/minor/off hues + colours, locate
#                                 spatial centroids, temporally smooth.
#   render  (compute) — paint the bicolor gradient + composite over input.
compile_shaders_compute_var_spv bicolor_grad hist
compile_shaders_compute_var_spv bicolor_grad analyze
compile_shaders_compute_var_spv bicolor_grad render
_emit_spv_header_var bicolor_grad hist analyze render
echo "  bicolor_grad shaders compiled (SPV: hist + analyze + render)"

# glisten — image-anchored sparkle fans.
#   findanchor (compute, 1 thread) — coarse/fine brightest-spot search +
#                                    local luma/colour gradient extraction.
#   prefill    (compute) — copy tex_in × input_alpha → tex_out base.
#   vs/fs      (vert/frag) — instanced triangle-fan sparkle, additive blend.
compile_shaders_compute_var_spv glisten findanchor
compile_shaders_compute_var_spv glisten prefill
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../glisten/vs.hlsl -Fo "$TMP_DIR/glisten_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../glisten/fs.hlsl -Fo "$TMP_DIR/glisten_fs.spv"
_emit_spv_header_var glisten findanchor prefill vs fs
echo "  glisten shaders compiled (SPV: findanchor + prefill + vs + fs)"

# double_chamber — P field-particles + Big attractors (DoubleChamber v2).
compile_shaders_compute_var_spv double_chamber big_update
compile_shaders_compute_var_spv double_chamber p_update
compile_shaders_compute_var_spv double_chamber prefill
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../double_chamber/vs.hlsl -Fo "$TMP_DIR/double_chamber_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../double_chamber/fs.hlsl -Fo "$TMP_DIR/double_chamber_fs.spv"
_emit_spv_header_var double_chamber big_update p_update prefill vs fs
echo "  double_chamber shaders compiled (SPV: big_update + p_update + prefill + vs + fs)"

# Shared Gaussian blur helper (effect_blur.h) — double_chamber's image smoothing.
compile_shaders_compute_spv blur
echo "  blur shader compiled (SPV) for effect_blur.h"

echo "=== Building WASM (legacy) ==="

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
  ../bicolor_grad/main.cpp \
  ../glisten/main.cpp \
  ../double_chamber/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
