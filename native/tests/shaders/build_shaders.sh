#!/bin/bash
# build_shaders.sh [out_dir] — bake the test-only shaders to SPIR-V.
#
# A test that needs its own kernel gets it the same way everything else does:
# authored once as HLSL, translated by the host at PSO-build time. Raw MSL
# literals in tests silently make those tests Metal-only.
set -e
cd "$(dirname "$0")"

OUT_DIR="${1:-../../build/tmp}"
mkdir -p "$OUT_DIR"

source ../../cmake/spv_bake.sh
spv_bake_require_tools

spv_bake_header "$OUT_DIR" "$OUT_DIR/test_shaders_spv.h" \
  "cs_6_0:copy_word.hlsl:copy_word"
echo "  test shaders compiled (SPV: copy_word)"
