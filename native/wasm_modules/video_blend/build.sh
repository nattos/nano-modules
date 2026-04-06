#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=video_blend

echo "=== Compiling shader (HLSL → SPIR-V → WGSL + MSL) ==="
glslc -fshader-stage=compute -x hlsl compute.hlsl -o "$TMP_DIR/vb_compute.spv"
naga "$TMP_DIR/vb_compute.spv" "$TMP_DIR/vb_compute.wgsl"
# Fix storage texture format for WebGPU
sed -i '' 's/rgba32float,read_write/rgba8unorm,write/g' "$TMP_DIR/vb_compute.wgsl"
sed -i '' 's/rgba32float/rgba8unorm/g' "$TMP_DIR/vb_compute.wgsl"
naga --metal-version 2.0 "$TMP_DIR/vb_compute.spv" "$TMP_DIR/vb_compute.metal"
echo "  Shader compiled"

{
  echo '/* Auto-generated shader header. Do not edit. */'
  echo '#pragma once'
  for lang in wgsl metal; do
    if [ "$lang" = "wgsl" ]; then suffix="WGSL"; else suffix="MSL"; fi
    varname="COMPUTE_${suffix}"
    echo "static const char ${varname}[] ="
    sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$TMP_DIR/vb_compute.${lang}"
    echo '  ;'
  done
} > "$TMP_DIR/video_blend_shaders.h"

echo "=== Building WASM ==="
source ../wasm_build_env.sh
WASM_EXPORTS=()
wasm_build -I"$TMP_DIR" -I../include main.cpp
echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
