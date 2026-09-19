#!/bin/bash
# build_shaders.sh [out_dir] — bake the text compositor's shaders to SPIR-V.
#
# Six stages out of one shared source (text_composite.hlsli), each its own tiny
# .hlsl with a `main` entry, each its own SPIR-V blob and its own shader module
# at runtime. The host translates them per backend, so the Metal path gets
# spirv-cross MSL where it used to get a hand-written MSL string, and D3D11 gets
# HLSL where it used to get that same MSL and fail on `#include <metal_stdlib>`.
set -e
cd "$(dirname "$0")"

OUT_DIR="${1:-../../../build/tmp}"
mkdir -p "$OUT_DIR"

source ../../../cmake/spv_bake.sh
spv_bake_require_tools

spv_bake_header "$OUT_DIR" "$OUT_DIR/text_composite_spv.h" \
  "vs_6_0:text_bg_vs.hlsl:bg_vs"       "ps_6_0:text_bg_fs.hlsl:bg_fs" \
  "vs_6_0:text_box_vs.hlsl:box_vs"     "ps_6_0:text_box_fs.hlsl:box_fs" \
  "vs_6_0:text_glyph_vs.hlsl:glyph_vs" "ps_6_0:text_glyph_fs.hlsl:glyph_fs"
echo "  text compositor shaders compiled (SPV: bg + box + glyph, vs+fs)"
