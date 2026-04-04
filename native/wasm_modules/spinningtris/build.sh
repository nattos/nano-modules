#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../build}"
mkdir -p "$OUT_DIR"

# --- Shader compilation pipeline ---
# HLSL → SPIR-V (via glslc) → WGSL + MSL (via naga) → embedded in C module

echo "=== Compiling shaders (HLSL → SPIR-V → WGSL/MSL) ==="

# Compile HLSL → SPIR-V
glslc -fshader-stage=compute -x hlsl compute.hlsl -o "$OUT_DIR/compute.spv"
glslc -fshader-stage=vertex -x hlsl vertex.hlsl -o "$OUT_DIR/vertex.spv"
glslc -fshader-stage=fragment -x hlsl fragment.hlsl -o "$OUT_DIR/fragment.spv"
echo "  SPIR-V: compute=$(wc -c < "$OUT_DIR/compute.spv")B vertex=$(wc -c < "$OUT_DIR/vertex.spv")B fragment=$(wc -c < "$OUT_DIR/fragment.spv")B"

# Convert SPIR-V → WGSL (via naga)
naga "$OUT_DIR/compute.spv" "$OUT_DIR/compute.wgsl"
naga "$OUT_DIR/vertex.spv" "$OUT_DIR/vertex.wgsl"
naga "$OUT_DIR/fragment.spv" "$OUT_DIR/fragment.wgsl"
echo "  WGSL generated"

# Convert SPIR-V → MSL (via naga) for future native Metal path
naga "$OUT_DIR/compute.spv" "$OUT_DIR/compute.metal"
naga "$OUT_DIR/vertex.spv" "$OUT_DIR/vertex.metal"
naga "$OUT_DIR/fragment.spv" "$OUT_DIR/fragment.metal"
echo "  MSL generated"

# Generate C header with embedded WGSL strings
echo "  Generating shaders.h..."
{
  echo '/* Auto-generated from HLSL -> SPIR-V -> WGSL pipeline. Do not edit. */'
  echo '#ifndef SPINNINGTRIS_SHADERS_H'
  echo '#define SPINNINGTRIS_SHADERS_H'
  for name in compute vertex fragment; do
    varname=$(echo "${name}_WGSL" | tr '[:lower:]' '[:upper:]')
    echo "static const char ${varname}[] ="
    sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$OUT_DIR/${name}.wgsl"
    echo '  ;'
  done
  echo '#endif'
} > "$OUT_DIR/spinningtris_shaders.h"
echo "  shaders.h: $(wc -c < "$OUT_DIR/spinningtris_shaders.h")B"

# --- WASM compilation ---
echo "=== Building WASM module ==="

CLANG=""
for candidate in /opt/homebrew/opt/llvm/bin/clang /usr/local/opt/llvm/bin/clang clang; do
  if [ -x "$candidate" ] 2>/dev/null; then
    if "$candidate" --print-targets 2>/dev/null | grep -qi wasm; then
      CLANG="$candidate"; break
    fi
  fi
done
if [ -z "$CLANG" ]; then echo "ERROR: No WASM clang"; exit 1; fi

"$CLANG" \
  --target=wasm32-unknown-unknown -nostdlib -O2 -std=c11 \
  -I"$OUT_DIR" \
  -Wl,--no-entry \
  -Wl,--export=init -Wl,--export=tick -Wl,--export=render \
  -Wl,--export=on_param_change -Wl,--export=on_state_changed \
  -Wl,--allow-undefined \
  main.c -o "$OUT_DIR/spinningtris.wasm"

echo "Built: $OUT_DIR/spinningtris.wasm ($(wc -c < "$OUT_DIR/spinningtris.wasm")B)"
