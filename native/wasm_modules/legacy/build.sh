#!/bin/bash
# legacy — ports of shipped dnode/NanoGraph effects (com.nano.legacy).
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=legacy

echo "=== Compiling shaders (legacy) ==="
source ../wasm_build_env.sh

# bicolor_grad — content-adaptive two-colour gradient.
#   hist    (compute) — RGB→YIQ hue histogram, atomic scatter into 64 bins.
#   analyze (compute, 1 thread) — pick major/minor/off hues + colours, locate
#                                 spatial centroids, temporally smooth.
#   render  (compute) — paint the bicolor gradient + composite over input.
compile_shaders_compute_var_spv bicolor_grad hist
compile_shaders_compute_var_spv bicolor_grad analyze
compile_shaders_compute_var_spv bicolor_grad render
_emit_spv_header_var bicolor_grad hist analyze render
echo "  bicolor_grad shaders compiled (SPV: hist + analyze + render)"

# glisten — image-anchored sparkle fans.
#   findanchor (compute, 1 thread) — coarse/fine brightest-spot search +
#                                    local luma/colour gradient extraction.
#   prefill    (compute) — copy tex_in × input_alpha → tex_out base.
#   vs/fs      (vert/frag) — instanced triangle-fan sparkle, additive blend.
compile_shaders_compute_var_spv glisten findanchor
compile_shaders_compute_var_spv glisten prefill
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../glisten/vs.hlsl -Fo "$TMP_DIR/glisten_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../glisten/fs.hlsl -Fo "$TMP_DIR/glisten_fs.spv"
_emit_spv_header_var glisten findanchor prefill vs fs
echo "  glisten shaders compiled (SPV: findanchor + prefill + vs + fs)"

# double_chamber — P field-particles + Big attractors (DoubleChamber v2).
compile_shaders_compute_var_spv double_chamber big_update
compile_shaders_compute_var_spv double_chamber p_update
compile_shaders_compute_var_spv double_chamber prefill
compile_shaders_compute_var_spv double_chamber trace
compile_shaders_compute_var_spv double_chamber bridger
compile_shaders_compute_var_spv double_chamber motion_prefill
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../double_chamber/vs.hlsl -Fo "$TMP_DIR/double_chamber_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../double_chamber/fs.hlsl -Fo "$TMP_DIR/double_chamber_fs.spv"
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../double_chamber/line_vs.hlsl -Fo "$TMP_DIR/double_chamber_line_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../double_chamber/line_fs.hlsl -Fo "$TMP_DIR/double_chamber_line_fs.spv"
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../double_chamber/motion_vs.hlsl -Fo "$TMP_DIR/double_chamber_motion_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../double_chamber/motion_fs.hlsl -Fo "$TMP_DIR/double_chamber_motion_fs.spv"
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../double_chamber/line_motion_vs.hlsl -Fo "$TMP_DIR/double_chamber_line_motion_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../double_chamber/line_motion_fs.hlsl -Fo "$TMP_DIR/double_chamber_line_motion_fs.spv"
_emit_spv_header_var double_chamber big_update p_update prefill trace bridger motion_prefill \
  vs fs line_vs line_fs motion_vs motion_fs line_motion_vs line_motion_fs
echo "  double_chamber shaders compiled (SPV: + motion_prefill/vs/fs + line_motion vs/fs)"

# d_wave — Darkburst's polar radial-ripple distortion field ("D wave").
#   field (compute) — stateful wave field: inject grain at centre, advect outward, decay.
#   particles (compute) — forward-integrate the dampening-flash pool (mid-radius band).
#   blob_vs/fs (vert/frag) — splat flashes into the RGBA16F damp texture (subtracted at warp).
#   warp  (compute) — polar lookup (wave − damp) + radial UV warp + composite.
compile_shaders_compute_var_spv d_wave field
compile_shaders_compute_var_spv d_wave particles
compile_shaders_compute_var_spv d_wave warp
compile_shaders_compute_var_spv d_wave motion
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../d_wave/blob_vs.hlsl -Fo "$TMP_DIR/d_wave_blob_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../d_wave/blob_fs.hlsl -Fo "$TMP_DIR/d_wave_blob_fs.spv"
_emit_spv_header_var d_wave field particles warp motion blob_vs blob_fs
echo "  d_wave shaders compiled (SPV: field + particles + warp + motion + blob_vs/fs)"

# lut_collection — "LUT Collection 1": baked preset colour LUTs (Wire "LUT 2").
#   fill  (compute) — copy a baked 32^3 rgba8 cube (storage buffer) into a 3D texture.
#   apply (compute) — pow pregain curve + single hardware-trilinear 3D LUT sample + mix.
compile_shaders_compute_var_spv lut_collection fill
compile_shaders_compute_var_spv lut_collection apply
_emit_spv_header_var lut_collection fill apply
echo "  lut_collection shaders compiled (SPV: fill + apply)"

# zoom_scroller — procedural pan/zoom sequence camera (Wire "ZoomScroller").
#   apply (compute) — scale+translate sample of tex_in + analytic gizmo box.
#   All sequencing/state-machine logic lives in main.cpp (tick).
compile_shaders_compute_var_spv zoom_scroller apply
_emit_spv_header_var zoom_scroller apply
echo "  zoom_scroller shaders compiled (SPV: apply)"

# subtle_blur — light Gaussian blur + drifting chromatic offset (Wire "Subtle Blur").
#   chroma (compute) — resample R/G/B at a slowly-rotating 120°-split basis.
#   Blur stage uses the shared fx::GaussianBlur (effect_blur.h / blur shader below).
compile_shaders_compute_var_spv subtle_blur chroma
_emit_spv_header_var subtle_blur chroma
echo "  subtle_blur shaders compiled (SPV: chroma)"

# Shared Gaussian blur helper (effect_blur.h) — double_chamber's image smoothing,
# subtle_blur's blur stage.
compile_shaders_compute_spv blur
echo "  blur shader compiled (SPV) for effect_blur.h"

echo "=== Building WASM (legacy) ==="

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
  ../bicolor_grad/main.cpp \
  ../glisten/main.cpp \
  ../double_chamber/main.cpp \
  ../d_wave/main.cpp \
  ../lut_collection/main.cpp \
  ../zoom_scroller/main.cpp \
  ../subtle_blur/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
