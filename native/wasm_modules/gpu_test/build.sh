#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../build}"
mkdir -p "$OUT_DIR"
MODULE_NAME=gpu_test

echo "=== Compiling shaders (HLSL → SPIR-V → WGSL + MSL) ==="
glslc -fshader-stage=compute -x hlsl compute.hlsl -o "$OUT_DIR/gpu_test_compute.spv"
glslc -fshader-stage=vertex -x hlsl vertex.hlsl -o "$OUT_DIR/gpu_test_vertex.spv"
glslc -fshader-stage=fragment -x hlsl fragment.hlsl -o "$OUT_DIR/gpu_test_fragment.spv"

for name in compute vertex fragment; do
  naga "$OUT_DIR/gpu_test_${name}.spv" "$OUT_DIR/gpu_test_${name}.wgsl"
  naga "$OUT_DIR/gpu_test_${name}.spv" "$OUT_DIR/gpu_test_${name}.metal"
done
echo "  Shaders compiled"

# Generate C++ header with both WGSL and MSL
{
  echo '/* Auto-generated fat shader header. Do not edit. */'
  echo '#pragma once'
  for name in compute vertex fragment; do
    for lang in wgsl metal; do
      if [ "$lang" = "wgsl" ]; then suffix="WGSL"; else suffix="MSL"; fi
      varname=$(echo "${name}_${suffix}" | tr '[:lower:]' '[:upper:]')
      echo "static const char ${varname}[] ="
      sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$OUT_DIR/gpu_test_${name}.${lang}"
      echo '  ;'
    done
  done
} > "$OUT_DIR/gpu_test_shaders.h"

echo "=== Building WASM ==="
source ../wasm_build_env.sh

WASM_EXPORTS=()

wasm_build -I"$OUT_DIR" main.cpp
echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
