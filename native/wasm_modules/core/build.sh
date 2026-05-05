#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=core

echo "=== Compiling shaders (core) ==="
source ../wasm_build_env.sh
compile_shaders_compute_fused_spv brightness_contrast
compile_shaders_compute_fused_spv solid_color
compile_shaders_compute_spv video_blend
compile_shaders_compute_fused_spv bake_alpha
compile_shaders_compute_fused_spv curve
compile_shaders_compute_fused_spv exposure
compile_shaders_compute_fused_spv invert
compile_shaders_compute_fused_spv posterize
compile_shaders_compute_fused_spv levels
compile_shaders_compute_fused_spv hsl
compile_shaders_compute_fused_spv color_space
compile_shaders_compute_fused_spv hue_basis
compile_shaders_compute_fused_spv saturate
compile_shaders_compute_fused_spv vibrance
compile_shaders_compute_fused_spv vignette
compile_shaders_compute_spv blur
compile_shaders_compute_var_spv fast_blur down
compile_shaders_compute_var_spv fast_blur up
_emit_spv_header_var fast_blur down up
echo "  fast_blur shaders compiled (down + up, SPV)"
compile_shaders_compute_spv sharpen
compile_shaders_compute_spv edges
compile_shaders_compute_spv crop
compile_shaders_compute_spv transform
compile_shaders_compute_fused_spv gradient
compile_shaders_compute_fused_spv grid
compile_shaders_compute_fused_spv noise

echo "=== Building WASM (core) ==="

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
  ../paramlinker/main.cpp \
  ../bake_alpha/main.cpp \
  ../curve/main.cpp \
  ../exposure/main.cpp \
  ../invert/main.cpp \
  ../posterize/main.cpp \
  ../levels/main.cpp \
  ../hsl/main.cpp \
  ../color_space/main.cpp \
  ../hue_basis/main.cpp \
  ../saturate/main.cpp \
  ../vibrance/main.cpp \
  ../vignette/main.cpp \
  ../blur/main.cpp \
  ../fast_blur/main.cpp \
  ../sharpen/main.cpp \
  ../edges/main.cpp \
  ../crop/main.cpp \
  ../transform/main.cpp \
  ../gradient/main.cpp \
  ../grid/main.cpp \
  ../noise/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
