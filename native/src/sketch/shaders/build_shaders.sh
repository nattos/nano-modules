#!/bin/bash
# build_shaders.sh [out_dir] — bake the executor's own shaders to SPIR-V.
#
# The executor (sketch_executor.cpp → both the native lib and executor.wasm)
# runs on Metal, WebGPU and D3D11, and gpu_create_shader_module compiles source
# VERBATIM in the host's language. These shaders used to ship as hand-written
# MSL+WGSL twins picked by `gpu_get_backend() == 1 ? WGSL : MSL`, which silently
# fed MSL to any third backend. They are now authored once as HLSL here and
# translated by the host at PSO-build time, exactly like effect shaders.
#
# Both build systems call this (native/CMakeLists.txt and
# wasm_modules/executor/build.sh), writing into the same native/build/tmp that
# effect bundles use, so the headers are never stale.
set -e
cd "$(dirname "$0")"

OUT_DIR="${1:-../../../build/tmp}"
mkdir -p "$OUT_DIR"

source ../../../cmake/spv_bake.sh
spv_bake_require_tools

# One header per shader: each host_*.h includes only its own, so a TU that
# pulls in one doesn't carry the others' byte arrays.
for stage in blend output_blit sidechannel_blit; do
  spv_bake_header "$OUT_DIR" "$OUT_DIR/exec_${stage}_spv.h" \
    "cs_6_0:${stage}.hlsl:${stage}"
done
echo "  executor shaders compiled (SPV: blend + output_blit + sidechannel_blit)"
