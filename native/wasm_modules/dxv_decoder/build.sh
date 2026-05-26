#!/bin/bash
# Build the dxv_decoder WASM service module.
#
# Service module = registers no EffectDesc, just exposes C functions the
# TS host wrapper calls directly. See main.cpp for the export surface.

set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=dxv_decoder

echo "=== Compiling shaders (dxv_decoder) ==="
source ../wasm_build_env.sh

# BC1 decode compute shader. The runtime registers it as storage-format
# rgba8unorm/write (see main.cpp's state::registerShaderSPV call) so naga
# emits matching texture_storage_2d<rgba8unorm, write> declarations.
compile_shaders_compute_var_spv dxv_decoder decode
_emit_spv_header_var dxv_decoder decode

echo "=== Building WASM (dxv_decoder) ==="

# Service-module exports. Skip init/tick/render/on_param_change — those are
# effect-style callbacks that this module deliberately doesn't implement.
WASM_COMMON_EXPORTS=(
  -Wl,--export=nano_module_main
  -Wl,--export=malloc
  -Wl,--export=free
  -Wl,--export=dxv_alloc
  -Wl,--export=dxv_free
  -Wl,--export=dxv_parse_container
  -Wl,--export=dxv_frame_count
  -Wl,--export=dxv_video_width
  -Wl,--export=dxv_video_height
  -Wl,--export=dxv_video_fourcc
  -Wl,--export=dxv_get_frame_offset
  -Wl,--export=dxv_get_frame_size
  -Wl,--export=dxv_decode_frame
)

wasm_build \
  -I"$TMP_DIR" \
  -I../include \
  -I../../src \
  main.cpp \
  dxv_demux.cpp \
  dxv_lz.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
