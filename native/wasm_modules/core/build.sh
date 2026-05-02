#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=core

echo "=== Compiling shaders (core) ==="
source ../wasm_build_env.sh
compile_shaders_compute brightness_contrast
compile_shaders_compute solid_color
compile_shaders_compute video_blend
compile_shaders_compute bake_alpha
compile_shaders_compute curve
compile_shaders_compute exposure
compile_shaders_compute invert
compile_shaders_compute posterize
compile_shaders_compute levels
compile_shaders_compute hsl
compile_shaders_compute vibrance
compile_shaders_compute vignette

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
  ../vibrance/main.cpp \
  ../vignette/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
