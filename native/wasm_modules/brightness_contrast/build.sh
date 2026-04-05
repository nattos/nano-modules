#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=brightness_contrast

echo "=== Compiling shader (HLSL → SPIR-V → WGSL + MSL) ==="
glslc -fshader-stage=compute -x hlsl compute.hlsl -o "$TMP_DIR/bc_compute.spv"
naga "$TMP_DIR/bc_compute.spv" "$TMP_DIR/bc_compute.wgsl"
# Fix storage texture format and access mode for WebGPU compatibility:
# - naga defaults to rgba32float, but we use rgba8unorm textures
# - WebGPU doesn't support read_write storage textures without extensions
sed -i '' 's/rgba32float,read_write/rgba8unorm,write/g' "$TMP_DIR/bc_compute.wgsl"
sed -i '' 's/rgba32float/rgba8unorm/g' "$TMP_DIR/bc_compute.wgsl"
naga --metal-version 2.0 "$TMP_DIR/bc_compute.spv" "$TMP_DIR/bc_compute.metal"
echo "  Shader compiled"

# Generate C++ header with both WGSL and MSL
{
  echo '/* Auto-generated shader header. Do not edit. */'
  echo '#pragma once'
  for lang in wgsl metal; do
    if [ "$lang" = "wgsl" ]; then suffix="WGSL"; else suffix="MSL"; fi
    varname="COMPUTE_${suffix}"
    echo "static const char ${varname}[] ="
    sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$TMP_DIR/bc_compute.${lang}"
    echo '  ;'
  done
} > "$TMP_DIR/brightness_contrast_shaders.h"

echo "=== Building WASM ==="
source ../wasm_build_env.sh

WASM_EXPORTS=()

wasm_build -I"$TMP_DIR" -I../include main.cpp
echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
