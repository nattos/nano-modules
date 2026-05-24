#!/bin/bash
# Lights bundle build — show effects for the LED-bar performance.
# See SHOW_EFFECTS_PLAN.md at the repo root for the design.
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=lights

echo "=== Compiling shaders (lights) ==="
source ../wasm_build_env.sh

# Each call compiles one .hlsl file and emits a <effect>_shaders.h with
# the variant baked in. All four v1 effects use a single `render.hlsl`
# compute pass.
compile_shaders_compute_spv strobe_channel     render
compile_shaders_compute_spv dispersion         render
compile_shaders_compute_spv plasma_beam_cannon render

# soft_glow has two compute shaders — color (rgba8) and motion
# (rgba16f). Separate variants because naga substitutes one storage-
# texture format per shader module.
compile_shaders_compute_var_spv soft_glow color
compile_shaders_compute_var_spv soft_glow motion
_emit_spv_header_var soft_glow color motion
echo "  soft_glow shaders compiled (SPV: color + motion)"

echo "=== Building WASM (lights) ==="

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
  ../strobe_channel/main.cpp \
  ../soft_glow/main.cpp \
  ../dispersion/main.cpp \
  ../plasma_beam_cannon/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
