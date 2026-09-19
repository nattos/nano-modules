#!/bin/bash
# build_shaders.sh [out_dir] — bake the executor's own shaders to SPIR-V.
#
# The executor (sketch_executor.cpp → both the native lib and executor.wasm)
# runs on Metal, WebGPU and D3D11, and gpu_create_shader_module compiles source
# VERBATIM in the host's language. Its inline shaders used to ship as
# hand-written MSL+WGSL twins picked by `gpu_get_backend() == 1 ? WGSL : MSL`
# — which silently fed MSL to any third backend. They are now authored once as
# HLSL and translated by the host at PSO-build time, exactly like effect
# shaders: DXC bakes SPIR-V here, the host runs spvToMsl / spvToHlsl / naga.
#
# Both build systems call this (native/CMakeLists.txt and
# wasm_modules/executor/build.sh), writing into the same native/build/tmp that
# effect bundles use, so the headers are never stale.
set -e
cd "$(dirname "$0")"

OUT_DIR="${1:-../../../build/tmp}"
mkdir -p "$OUT_DIR"

EMIT="../../../wasm_modules/_emit_spv_header.py"

if ! command -v dxc >/dev/null 2>&1; then
  echo "ERROR: dxc not found on PATH (needed to bake the executor's shaders)." >&2
  echo "  macOS: brew install dxc" >&2
  exit 1
fi
if [ -z "${PYTHON:-}" ]; then
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1 && \
       "$c" -c 'import sys; sys.exit(0 if sys.version_info[0]==3 else 1)' 2>/dev/null; then
      PYTHON="$c"; break
    fi
  done
fi
if [ -z "${PYTHON:-}" ]; then
  echo "ERROR: python 3 not found on PATH (needed to bake SPIR-V into headers)." >&2
  exit 1
fi

# One header per shader: each host_*.h includes only its own, so a TU that
# pulls in one doesn't carry the others' byte arrays.
for stage in blend output_blit sidechannel_blit; do
  dxc -T cs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
    "${stage}.hlsl" -Fo "$OUT_DIR/exec_${stage}.spv"
  "$PYTHON" "$EMIT" "$OUT_DIR/exec_${stage}_spv.h" \
    "${stage}=$OUT_DIR/exec_${stage}.spv"
done
echo "  executor shaders compiled (SPV: blend + output_blit + sidechannel_blit)"
