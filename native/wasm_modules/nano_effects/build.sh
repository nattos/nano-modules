#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=nano_effects

# ================================================================
# Shader compilation for all GPU modules
# ================================================================

echo "=== Compiling shaders ==="

# brightness_contrast: compute only
glslc -fshader-stage=compute -x hlsl ../brightness_contrast/compute.hlsl -o "$TMP_DIR/bc_compute.spv"
naga "$TMP_DIR/bc_compute.spv" "$TMP_DIR/bc_compute.wgsl"
sed -i '' 's/rgba32float,read_write/rgba8unorm,write/g' "$TMP_DIR/bc_compute.wgsl"
sed -i '' 's/rgba32float/rgba8unorm/g' "$TMP_DIR/bc_compute.wgsl"
naga --metal-version 2.0 "$TMP_DIR/bc_compute.spv" "$TMP_DIR/bc_compute.metal"
{
  echo '/* Auto-generated shader header. Do not edit. */'
  echo '#pragma once'
  for lang in wgsl metal; do
    if [ "$lang" = "wgsl" ]; then suffix="WGSL"; else suffix="MSL"; fi
    echo "static const char COMPUTE_${suffix}[] ="
    sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$TMP_DIR/bc_compute.${lang}"
    echo '  ;'
  done
} > "$TMP_DIR/brightness_contrast_shaders.h"
echo "  brightness_contrast shaders compiled"

# solid_color: compute only
glslc -fshader-stage=compute -x hlsl ../solid_color/compute.hlsl -o "$TMP_DIR/sc_compute.spv"
naga "$TMP_DIR/sc_compute.spv" "$TMP_DIR/sc_compute.wgsl"
sed -i '' 's/rgba32float,read_write/rgba8unorm,write/g' "$TMP_DIR/sc_compute.wgsl"
sed -i '' 's/rgba32float/rgba8unorm/g' "$TMP_DIR/sc_compute.wgsl"
naga --metal-version 2.0 "$TMP_DIR/sc_compute.spv" "$TMP_DIR/sc_compute.metal"
{
  echo '/* Auto-generated shader header. Do not edit. */'
  echo '#pragma once'
  for lang in wgsl metal; do
    if [ "$lang" = "wgsl" ]; then suffix="WGSL"; else suffix="MSL"; fi
    echo "static const char COMPUTE_${suffix}[] ="
    sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$TMP_DIR/sc_compute.${lang}"
    echo '  ;'
  done
} > "$TMP_DIR/solid_color_shaders.h"
echo "  solid_color shaders compiled"

# video_blend: compute only
glslc -fshader-stage=compute -x hlsl ../video_blend/compute.hlsl -o "$TMP_DIR/vb_compute.spv"
naga "$TMP_DIR/vb_compute.spv" "$TMP_DIR/vb_compute.wgsl"
sed -i '' 's/rgba32float,read_write/rgba8unorm,write/g' "$TMP_DIR/vb_compute.wgsl"
sed -i '' 's/rgba32float/rgba8unorm/g' "$TMP_DIR/vb_compute.wgsl"
naga --metal-version 2.0 "$TMP_DIR/vb_compute.spv" "$TMP_DIR/vb_compute.metal"
{
  echo '/* Auto-generated shader header. Do not edit. */'
  echo '#pragma once'
  for lang in wgsl metal; do
    if [ "$lang" = "wgsl" ]; then suffix="WGSL"; else suffix="MSL"; fi
    echo "static const char COMPUTE_${suffix}[] ="
    sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$TMP_DIR/vb_compute.${lang}"
    echo '  ;'
  done
} > "$TMP_DIR/video_blend_shaders.h"
echo "  video_blend shaders compiled"

# gpu_test: compute + vertex + fragment
glslc -fshader-stage=compute -x hlsl ../gpu_test/compute.hlsl -o "$TMP_DIR/gpu_test_compute.spv"
glslc -fshader-stage=vertex -x hlsl ../gpu_test/vertex.hlsl -o "$TMP_DIR/gpu_test_vertex.spv"
glslc -fshader-stage=fragment -x hlsl ../gpu_test/fragment.hlsl -o "$TMP_DIR/gpu_test_fragment.spv"
for name in compute vertex fragment; do
  naga "$TMP_DIR/gpu_test_${name}.spv" "$TMP_DIR/gpu_test_${name}.wgsl"
  naga "$TMP_DIR/gpu_test_${name}.spv" "$TMP_DIR/gpu_test_${name}.metal"
done
{
  echo '/* Auto-generated fat shader header. Do not edit. */'
  echo '#pragma once'
  for name in compute vertex fragment; do
    for lang in wgsl metal; do
      if [ "$lang" = "wgsl" ]; then suffix="WGSL"; else suffix="MSL"; fi
      varname=$(echo "${name}_${suffix}" | tr '[:lower:]' '[:upper:]')
      echo "static const char ${varname}[] ="
      sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$TMP_DIR/gpu_test_${name}.${lang}"
      echo '  ;'
    done
  done
} > "$TMP_DIR/gpu_test_shaders.h"
echo "  gpu_test shaders compiled"

# spinningtris: compute + vertex + fragment
glslc -fshader-stage=compute -x hlsl ../spinningtris/compute.hlsl -o "$TMP_DIR/st_compute.spv"
glslc -fshader-stage=vertex -x hlsl ../spinningtris/vertex.hlsl -o "$TMP_DIR/st_vertex.spv"
glslc -fshader-stage=fragment -x hlsl ../spinningtris/fragment.hlsl -o "$TMP_DIR/st_fragment.spv"
for name in compute vertex fragment; do
  naga "$TMP_DIR/st_${name}.spv" "$TMP_DIR/st_${name}.wgsl"
  naga "$TMP_DIR/st_${name}.spv" "$TMP_DIR/st_${name}.metal"
done
{
  echo '/* Auto-generated from HLSL -> SPIR-V -> WGSL pipeline. Do not edit. */'
  echo '#pragma once'
  for name in compute vertex fragment; do
    for lang in wgsl metal; do
      if [ "$lang" = "wgsl" ]; then suffix="WGSL"; else suffix="MSL"; fi
      varname=$(echo "${name}_${suffix}" | tr '[:lower:]' '[:upper:]')
      echo "static const char ${varname}[] ="
      sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$TMP_DIR/st_${name}.${lang}"
      echo '  ;'
    done
  done
} > "$TMP_DIR/spinningtris_shaders.h"
echo "  spinningtris shaders compiled"

# ================================================================
# Build combined WASM module
# ================================================================

echo "=== Building WASM ==="
source ../wasm_build_env.sh

# Override exports for the combined module
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
  ../env_lfo/main.cpp \
  ../video_blend/main.cpp \
  ../gpu_test/main.cpp \
  ../spinningtris/main.cpp \
  ../paramlinker/main.cpp \
  ../nanolooper/main.cpp \
  ../nanolooper/core.cpp \
  ../particles_emitter/main.cpp \
  ../particles_renderer/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
