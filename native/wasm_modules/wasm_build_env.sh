#!/bin/bash
# Shared WASM C++ build environment.
# Source this from module build scripts: source ../wasm_build_env.sh

WASI_LIBC=/opt/homebrew/opt/wasi-libc/share/wasi-sysroot
WASI_CXX=/opt/homebrew/opt/wasi-runtimes/share/wasi-sysroot

# Find WASM-capable clang
CLANG=""
for candidate in /opt/homebrew/opt/llvm/bin/clang++ /usr/local/opt/llvm/bin/clang++ clang++; do
  if [ -x "$candidate" ] 2>/dev/null; then
    if "$candidate" --print-targets 2>/dev/null | grep -qi wasm; then
      CLANG="$candidate"; break
    fi
  fi
done
if [ -z "$CLANG" ]; then echo "ERROR: No WASM-capable clang++"; exit 1; fi

WASM_CXXFLAGS=(
  --target=wasm32-wasip1
  --sysroot="$WASI_LIBC"
  -isystem "$WASI_CXX/include/wasm32-wasip1/c++/v1"
  -O2 -std=c++17
  -fno-exceptions -fno-rtti
)

WASM_LDFLAGS=(
  -L"$WASI_CXX/lib/wasm32-wasip1"
  -lc++ -lc++abi
  -Wl,--no-entry
  -Wl,--allow-undefined
)

# Common exports all modules share
WASM_COMMON_EXPORTS=(
  -Wl,--export=init
  -Wl,--export=tick
  -Wl,--export=render
  -Wl,--export=on_param_change
  -Wl,--export=on_state_patched
  -Wl,--export=malloc
  -Wl,--export=free
)

wasm_build() {
  local SOURCES=("$@")
  echo "  clang++: ${SOURCES[*]}"
  "$CLANG" "${WASM_CXXFLAGS[@]}" "${WASM_LDFLAGS[@]}" "${WASM_EXPORTS[@]}" "${WASM_COMMON_EXPORTS[@]}" "${SOURCES[@]}" -o "$OUT_DIR/$MODULE_NAME.wasm"
}

# ----------------------------------------------------------------------
# Shader compilation helpers.
#
# Each effect's shaders live in its own dir under wasm_modules/ as
# <stage>.hlsl files. Helpers compile them to SPIR-V, then transpile via
# `naga` to WGSL + Metal, then bake into a C++ header named
# `<effect>_shaders.h` placed in $TMP_DIR. The corresponding effect main.cpp
# `#include`s that header.
#
# Bundles call these helpers once per effect they ship — output is placed in
# a common $TMP_DIR shared across bundles, so a re-run picks up only changed
# inputs (the headers can be safely regenerated).
# ----------------------------------------------------------------------

# Internal: emit the C++ header with the named shader stages baked into
# `static const char <STAGE>_<LANG>[]` arrays.
_emit_shader_header() {
  local effect="$1"; shift
  local stages=("$@")
  local header="$TMP_DIR/${effect}_shaders.h"
  {
    echo '/* Auto-generated shader header. Do not edit. */'
    echo '#pragma once'
    for stage in "${stages[@]}"; do
      for lang in wgsl metal; do
        if [ "$lang" = "wgsl" ]; then suffix="WGSL"; else suffix="MSL"; fi
        local varname
        varname=$(echo "${stage}_${suffix}" | tr '[:lower:]' '[:upper:]')
        echo "static const char ${varname}[] ="
        sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$TMP_DIR/${effect}_${stage}.${lang}"
        echo '  ;'
      done
    done
  } > "$header"
}

# compile_shaders_compute <effect> — for effects with a single compute.hlsl.
# Applies the rgba32float→rgba8unorm WGSL fixup the existing pipeline relies on.
compile_shaders_compute() {
  local effect="$1"
  glslc -fshader-stage=compute -x hlsl "../${effect}/compute.hlsl" -o "$TMP_DIR/${effect}_compute.spv"
  naga "$TMP_DIR/${effect}_compute.spv" "$TMP_DIR/${effect}_compute.wgsl"
  sed -i '' 's/rgba32float,read_write/rgba8unorm,write/g' "$TMP_DIR/${effect}_compute.wgsl"
  sed -i '' 's/rgba32float/rgba8unorm/g' "$TMP_DIR/${effect}_compute.wgsl"
  naga --metal-version 2.0 "$TMP_DIR/${effect}_compute.spv" "$TMP_DIR/${effect}_compute.metal"
  _emit_shader_header "$effect" compute
  echo "  ${effect} shaders compiled (compute)"
}

# compile_shaders_full <effect> — for effects with compute + vertex + fragment.
compile_shaders_full() {
  local effect="$1"
  for stage in compute vertex fragment; do
    glslc -fshader-stage=${stage} -x hlsl "../${effect}/${stage}.hlsl" -o "$TMP_DIR/${effect}_${stage}.spv"
    naga "$TMP_DIR/${effect}_${stage}.spv" "$TMP_DIR/${effect}_${stage}.wgsl"
    naga "$TMP_DIR/${effect}_${stage}.spv" "$TMP_DIR/${effect}_${stage}.metal"
  done
  _emit_shader_header "$effect" compute vertex fragment
  echo "  ${effect} shaders compiled (compute+vertex+fragment)"
}
