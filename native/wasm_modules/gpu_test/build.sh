#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../build}"
mkdir -p "$OUT_DIR"

echo "=== Compiling shaders (HLSL → SPIR-V → WGSL + MSL) ==="
glslc -fshader-stage=compute -x hlsl compute.hlsl -o "$OUT_DIR/gpu_test_compute.spv"
glslc -fshader-stage=vertex -x hlsl vertex.hlsl -o "$OUT_DIR/gpu_test_vertex.spv"
glslc -fshader-stage=fragment -x hlsl fragment.hlsl -o "$OUT_DIR/gpu_test_fragment.spv"

for name in compute vertex fragment; do
  naga "$OUT_DIR/gpu_test_${name}.spv" "$OUT_DIR/gpu_test_${name}.wgsl"
  naga "$OUT_DIR/gpu_test_${name}.spv" "$OUT_DIR/gpu_test_${name}.metal"
done
echo "  Shaders compiled (WGSL + MSL)"

# Generate C header with both WGSL and MSL
{
  echo '/* Auto-generated fat shader header. Do not edit. */'
  echo '#ifndef GPU_TEST_SHADERS_H'
  echo '#define GPU_TEST_SHADERS_H'
  for name in compute vertex fragment; do
    for lang in wgsl metal; do
      if [ "$lang" = "wgsl" ]; then suffix="WGSL"; else suffix="MSL"; fi
      varname=$(echo "${name}_${suffix}" | tr '[:lower:]' '[:upper:]')
      echo "static const char ${varname}[] ="
      sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$OUT_DIR/gpu_test_${name}.${lang}"
      echo '  ;'
    done
  done
  echo '#endif'
} > "$OUT_DIR/gpu_test_shaders.h"

echo "=== Building WASM ==="
CLANG=""
for candidate in /opt/homebrew/opt/llvm/bin/clang /usr/local/opt/llvm/bin/clang clang; do
  if [ -x "$candidate" ] 2>/dev/null && "$candidate" --print-targets 2>/dev/null | grep -qi wasm; then
    CLANG="$candidate"; break
  fi
done
if [ -z "$CLANG" ]; then echo "ERROR: No WASM clang"; exit 1; fi

"$CLANG" --target=wasm32-unknown-unknown -nostdlib -O2 -std=c11 \
  -I"$OUT_DIR" \
  -Wl,--no-entry \
  -Wl,--export=init -Wl,--export=tick -Wl,--export=render \
  -Wl,--export=on_param_change -Wl,--export=on_state_changed \
  -Wl,--allow-undefined \
  main.c -o "$OUT_DIR/gpu_test.wasm"

echo "Built: $OUT_DIR/gpu_test.wasm ($(wc -c < "$OUT_DIR/gpu_test.wasm")B)"
