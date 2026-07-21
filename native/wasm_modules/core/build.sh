#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=core

echo "=== Compiling shaders (core) ==="
source ../wasm_build_env.sh
compile_shaders_compute_fused_spv brightness_contrast
compile_shaders_compute_fused_spv solid_color
compile_shaders_compute_spv video_blend
compile_shaders_compute_spv video_layer
compile_shaders_compute_spv video_file
compile_shaders_compute_fused_spv bake_alpha
compile_shaders_compute_fused_spv curve
compile_shaders_compute_fused_spv exposure
compile_shaders_compute_fused_spv color_temperature
compile_shaders_compute_fused_spv invert
compile_shaders_compute_fused_spv alpha_remap
compile_shaders_compute_fused_spv posterize
compile_shaders_compute_fused_spv levels
compile_shaders_compute_fused_spv hsl
compile_shaders_compute_fused_spv color_space
compile_shaders_compute_fused_spv hue_basis
compile_shaders_compute_fused_spv saturate
compile_shaders_compute_fused_spv vibrance
compile_shaders_compute_fused_spv colorize
compile_shaders_compute_fused_spv vignette
compile_shaders_compute_spv blur
compile_shaders_compute_var_spv fast_blur down
compile_shaders_compute_var_spv fast_blur up
_emit_spv_header_var fast_blur down up
echo "  fast_blur shaders compiled (down + up, SPV)"
compile_shaders_compute_spv sharpen
compile_shaders_compute_spv local_contrast combine
compile_shaders_compute_spv edges
compile_shaders_compute_spv crop
compile_shaders_compute_spv transform
compile_shaders_compute_spv twitch_mask
compile_shaders_compute_fused_spv gradient
compile_shaders_compute_fused_spv grid
compile_shaders_compute_fused_spv noise

# motion_blur — velocity-pyramid McGuire reconstruction. pyramid_reduce
# builds a max-magnitude mip chain from the per-pixel motion texture;
# reconstruct gathers along the dominant velocity at the appropriate
# pyramid level. The previous TileMax+NeighborMax variant has been
# dropped — the pyramid produced fewer artifacts at every quality
# level for similar compute cost (see git history if you need the
# old shaders back).
compile_shaders_compute_var_spv motion_blur reconstruct
compile_shaders_compute_var_spv motion_blur pyramid_reduce
_emit_spv_header_var motion_blur reconstruct pyramid_reduce
echo "  motion_blur shaders compiled (SPV: reconstruct + pyramid_reduce)"

# auto_level — histogram auto-leveler. minmax → hist → buildlut → apply,
# sharing the histogram→CDF math in shaders_common/nano_histogram.hlsl.
compile_shaders_compute_var_spv auto_level minmax
compile_shaders_compute_var_spv auto_level hist
compile_shaders_compute_var_spv auto_level buildlut
compile_shaders_compute_var_spv auto_level apply
_emit_spv_header_var auto_level minmax hist buildlut apply
echo "  auto_level shaders compiled (SPV: minmax+hist+buildlut+apply)"

echo "=== Building WASM (core) ==="

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
  ../video_file/main.cpp \
  ../video_blend/main.cpp \
  ../video_layer/main.cpp \
  ../paramlinker/main.cpp \
  ../barrel_macros/main.cpp \
  ../dashboard/main.cpp \
  ../sketch_output/main.cpp \
  ../sidechannel_out/main.cpp \
  ../sidechannel_in/main.cpp \
  ../sidechannel_scalar_out/main.cpp \
  ../sidechannel_scalar_in/main.cpp \
  ../bake_alpha/main.cpp \
  ../curve/main.cpp \
  ../exposure/main.cpp \
  ../color_temperature/main.cpp \
  ../invert/main.cpp \
  ../alpha_remap/main.cpp \
  ../video_delay/main.cpp \
  ../posterize/main.cpp \
  ../levels/main.cpp \
  ../hsl/main.cpp \
  ../color_space/main.cpp \
  ../hue_basis/main.cpp \
  ../saturate/main.cpp \
  ../vibrance/main.cpp \
  ../colorize/main.cpp \
  ../vignette/main.cpp \
  ../blur/main.cpp \
  ../fast_blur/main.cpp \
  ../sharpen/main.cpp \
  ../local_contrast/main.cpp \
  ../edges/main.cpp \
  ../crop/main.cpp \
  ../transform/main.cpp \
  ../gradient/main.cpp \
  ../grid/main.cpp \
  ../noise/main.cpp \
  ../motion_blur/main.cpp \
  ../auto_level/main.cpp \
  ../twitch_mask/main.cpp \
  ../mod_remap/main.cpp \
  ../mod_combine/main.cpp \
  ../mod_flip/main.cpp \
  ../mod_latch/main.cpp \
  ../mod_time/main.cpp \
  ../transport_core/main.cpp \
  ../transport_follow/main.cpp \
  ../mod_bpm/main.cpp \
  ../mod_smooth/main.cpp \
  ../mod_motion/main.cpp \
  ../mod_transient/main.cpp \
  ../mod_delay/main.cpp \
  ../mod_envelope/main.cpp \
  ../mod_threshold/main.cpp \
  ../mod_invert/main.cpp \
  ../env_lfo/main.cpp \
  ../env_adsr/main.cpp \
  ../trigger_beat/main.cpp \
  ../trigger_out/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
