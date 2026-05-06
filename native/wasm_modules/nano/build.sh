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
  ../motion_field/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
