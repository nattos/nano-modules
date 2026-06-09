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
compile_shaders_compute_spv orthomod           render
compile_shaders_compute_spv lights_sim           render

# soft_glow has two compute shaders — color (rgba8) and motion
# (rgba16f). Separate variants because naga substitutes one storage-
# texture format per shader module.
compile_shaders_compute_var_spv soft_glow color
compile_shaders_compute_var_spv soft_glow motion
_emit_spv_header_var soft_glow color motion
echo "  soft_glow shaders compiled (SPV: color + motion)"

# bounce_resonator: GPU-resident sim + color + motion passes.
compile_shaders_compute_var_spv bounce_resonator sim
compile_shaders_compute_var_spv bounce_resonator color
compile_shaders_compute_var_spv bounce_resonator motion
_emit_spv_header_var bounce_resonator sim color motion
echo "  bounce_resonator shaders compiled (SPV: sim + color + motion)"

compile_shaders_compute_var_spv side_jet sim
compile_shaders_compute_var_spv side_jet color
compile_shaders_compute_var_spv side_jet motion
_emit_spv_header_var side_jet sim color motion
echo "  side_jet shaders compiled (SPV: sim + color + motion)"

compile_shaders_compute_var_spv motion_blobs color
compile_shaders_compute_var_spv motion_blobs motion
_emit_spv_header_var motion_blobs color motion
echo "  motion_blobs shaders compiled (SPV: color + motion)"

compile_shaders_compute_var_spv block_dehance update
compile_shaders_compute_var_spv block_dehance render
compile_shaders_compute_var_spv block_dehance motion
_emit_spv_header_var block_dehance update render motion
echo "  block_dehance shaders compiled (SPV: update + render + motion)"

compile_shaders_compute_var_spv tingle_top update
compile_shaders_compute_var_spv tingle_top prefill
compile_shaders_compute_var_spv tingle_top motion
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../tingle_top/vs.hlsl -Fo "$TMP_DIR/tingle_top_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../tingle_top/fs.hlsl -Fo "$TMP_DIR/tingle_top_fs.spv"
_emit_spv_header_var tingle_top update prefill vs fs motion
echo "  tingle_top shaders compiled (SPV: update + prefill + vs + fs + motion)"

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
  ../plasma_beam_cannon/main.cpp \
  ../orthomod/main.cpp \
  ../bounce_resonator/main.cpp \
  ../side_jet/main.cpp \
  ../motion_blobs/main.cpp \
  ../lights_sim/main.cpp \
  ../block_dehance/main.cpp \
  ../tingle_top/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
