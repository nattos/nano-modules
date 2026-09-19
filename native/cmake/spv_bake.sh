#!/bin/bash
# spv_bake.sh — SOURCE this. Bakes .hlsl → SPIR-V → a C++ byte-array header.
#
# The host translates SPIR-V to whatever the live backend speaks (spvToMsl,
# spvToHlsl, naga), so every shader in this tree is authored once as HLSL and
# baked to SPIR-V at build time. Effect bundles do it through
# wasm_modules/wasm_build_env.sh; the shaders the HOST itself owns — the
# executor's blend and blits, the text compositor — come through here, because
# their build has nothing to do with the wasm toolchain.
#
# Callers:
#   source "<repo>/native/cmake/spv_bake.sh"
#   spv_bake_require_tools
#   spv_bake_header <out_dir> <header_path> <profile:src.hlsl:VAR> ...
#
# Each spec emits `static const unsigned char <VAR>_SPV[]` plus `<VAR>_SPV_SIZE`
# into the header (see wasm_modules/_emit_spv_header.py).
#
# THE ENTRY POINT IS ALWAYS `main`, which is why it isn't in the spec. One blob
# per entry, and the name is fixed by the far end: spirv-cross emits HLSL whose
# function is called `main` whatever the SPIR-V entry was named, so a shader
# with several differently-named entries would collapse onto one on the D3D11
# leg and none of them would be findable. Effect bundles run on the same rule
# (`dxc -E main` throughout wasm_build_env.sh), and the host maps "main" →
# "main0" for Metal, where spirv-cross renames it (gpu_impls.cpp).

_SPV_BAKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_SPV_BAKE_EMIT="$_SPV_BAKE_DIR/../wasm_modules/_emit_spv_header.py"

spv_bake_require_tools() {
  if ! command -v dxc >/dev/null 2>&1; then
    echo "ERROR: dxc not found on PATH (needed to bake shaders to SPIR-V)." >&2
    echo "  macOS: brew install dxc" >&2
    return 1
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
    return 1
  fi
}

spv_bake_header() {
  local out_dir="$1"; shift
  local header="$1"; shift
  local stem
  stem="$(basename "$header")"; stem="${stem%.h}"
  local pairs=()
  local spec profile rest src var spv
  for spec in "$@"; do
    profile="${spec%%:*}"; rest="${spec#*:}"
    src="${rest%%:*}"; var="${rest##*:}"
    spv="$out_dir/${stem}_${var}.spv"
    dxc -T "$profile" -E main -spirv -fspv-target-env=vulkan1.1 \
        "$src" -Fo "$spv"
    pairs+=("${var}=${spv}")
  done
  "$PYTHON" "$_SPV_BAKE_EMIT" "$header" "${pairs[@]}"
}
