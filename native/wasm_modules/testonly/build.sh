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
compile_shaders_full gpu_test
compile_shaders_full spinningtris

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
  ../env_lfo/main.cpp \
  ../gpu_test/main.cpp \
  ../spinningtris/main.cpp \
  ../particles_emitter/main.cpp \
  ../particles_renderer/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
