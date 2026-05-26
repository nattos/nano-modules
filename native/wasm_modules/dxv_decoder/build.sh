#!/bin/bash
# Build the dxv_decoder WASM service module.
#
# Service module = registers no EffectDesc, just exposes C functions the
# TS host wrapper calls directly. See main.cpp for the export surface.
#
# No shader is bundled — BC1 decode happens in WebGPU hardware on the TS
# side (bc1-rgba-unorm sample → rgba8unorm blit).

set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=dxv_decoder

echo "=== Building WASM (dxv_decoder) ==="
source ../wasm_build_env.sh

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
  -Wl,--export=dxv_lz_decompress_frame
)

wasm_build \
  -I../include \
  -I../../src \
  main.cpp \
  dxv_demux.cpp \
  dxv_lz.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
