#!/bin/bash
# build_shaders.sh [out_dir] — bake the media pipeline's shaders to SPIR-V.
#
# Host-only (nano_media never enters a wasm bundle), authored once as HLSL and
# translated per backend at PSO-build (runtime/shader_from_spv.h) — the same
# route the executor's own shaders take (src/sketch/shaders).
set -e
cd "$(dirname "$0")"

OUT_DIR="${1:-../../../build/tmp}"
mkdir -p "$OUT_DIR"

source ../../../cmake/spv_bake.sh
spv_bake_require_tools

for stage in frame_blit dxv_blit; do
  spv_bake_header "$OUT_DIR" "$OUT_DIR/media_${stage}_spv.h" \
    "cs_6_0:${stage}.hlsl:${stage}"
done
echo "  media shaders compiled (SPV: frame_blit + dxv_blit)"
