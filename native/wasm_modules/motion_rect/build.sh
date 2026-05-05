#!/bin/bash
# Standalone build for debug.motion_rect — only used to spot-check the
# shader compile output. The effect ships as part of the testonly bundle.
set -e
cd "$(dirname "$0")"
TMP_DIR="${1:-../../build/tmp}"
mkdir -p "$TMP_DIR"
source ../wasm_build_env.sh
compile_shaders_compute_var_spv motion_rect color
compile_shaders_compute_var_spv motion_rect motion
_emit_spv_header_var motion_rect color motion
echo "  motion_rect shaders compiled (SPV: color + motion)"
