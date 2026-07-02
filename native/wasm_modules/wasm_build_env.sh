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
  # Declare a memory MAXIMUM (512 MB). Without one, V8 reserves ~10 GB of
  # virtual address space PER LIVE INSTANCE (4 GB + guard pages) against a
  # ~1 TB per-process wasm budget — so ~96 concurrent instances exhaust it and
  # every later WebAssembly.instantiate throws Out-of-memory. The web engine
  # holds a WasmHost per warmed effect + per chain entry (hundreds), which blew
  # that cap. A declared max bounds the reservation to 512 MB, far above any
  # real effect heap, and WAMR (native) simply honors it.
  -Wl,--max-memory=536870912
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

# Shared HLSL include directory. Effects can `#include "nano_coords.hlsl"`
# (etc.) — see wasm_modules/shaders_common/.
SHADERS_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/shaders_common" && pwd)"

# --- Shader hygiene gate ------------------------------------------------
# Fail the build if any shader uses the isnan()/isinf() intrinsics. They
# compile to SPIR-V but make the downstream PSO build fail SILENTLY at
# runtime (the effect never initializes -> blank output, no build error).
# Use `x != x` for NaN + clamp() for +/-Inf (shaders_common/nano_sanitize.hlsl).
# Crude but comprehensive: scans every effect shader on each build. The regex
# requires a "(" so prose like "isnan / isinf" in comments doesn't trip it.
_WASM_MODULES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_forbidden_intrinsics="$(grep -rnE '\bis(nan|inf)[[:space:]]*\(' "$_WASM_MODULES_DIR" --include='*.hlsl' 2>/dev/null || true)"
if [ -n "$_forbidden_intrinsics" ]; then
  echo "ERROR: forbidden shader intrinsic isnan()/isinf() — these break PSO" >&2
  echo "       compilation (the effect silently fails to initialize). Use" >&2
  echo "       'x != x' for NaN and clamp() for +/-Inf (nano_sanitize.hlsl):" >&2
  echo "$_forbidden_intrinsics" | sed 's/^/       /' >&2
  exit 1
fi

# compile_shaders_compute_var <effect> <variant_name> <wgsl_storage_format>
# [<access>] [<source_basename>]
#
#   Compile <effect>/<source_basename>.hlsl (default: "compute") to a
#   single named variant. The WGSL output's storage-texture format is
#   replaced with <wgsl_storage_format> (e.g. "rgba8unorm",
#   "rgba16float", "r32float"). Optional <access> is "write" (default)
#   or "read_write" — the latter is for in-place read-write storage
#   textures.
#
#   Emits files <TMP_DIR>/<effect>_<variant_name>.wgsl / .metal but does
#   NOT emit the header. Call `_emit_shader_header <effect> <variants...>`
#   once you've compiled all the variants you need.
compile_shaders_compute_var() {
  local effect="$1"
  local variant="$2"
  local fmt="$3"
  local access="${4:-write}"
  local src="${5:-compute}"
  glslc -fshader-stage=compute -x hlsl \
    -I "$SHADERS_COMMON_DIR" \
    "../${effect}/${src}.hlsl" -o "$TMP_DIR/${effect}_${variant}.spv"
  naga "$TMP_DIR/${effect}_${variant}.spv" "$TMP_DIR/${effect}_${variant}.wgsl"
  sed -i '' "s/rgba32float,read_write/${fmt},${access}/g" "$TMP_DIR/${effect}_${variant}.wgsl"
  sed -i '' "s/rgba32float/${fmt}/g" "$TMP_DIR/${effect}_${variant}.wgsl"
  naga --metal-version 2.0 "$TMP_DIR/${effect}_${variant}.spv" "$TMP_DIR/${effect}_${variant}.metal"
}

# compile_shaders_compute <effect> — for effects with a single compute.hlsl
# emitting an rgba8unorm storage texture (the common case).
compile_shaders_compute() {
  local effect="$1"
  compile_shaders_compute_var "$effect" compute rgba8unorm
  _emit_shader_header "$effect" compute
  echo "  ${effect} shaders compiled (compute)"
}

# compile_shaders_compute_spv <effect> [<src_basename>=compute]
#
#   Emit ONLY the SPIR-V form of a compute shader. The runtime
#   translates SPV → WGSL via the dev-server's naga endpoint at load
#   time, so effects no longer carry per-platform shader text. Bundle
#   shrinks (no WGSL/MSL strings) and effect main.cpp loses its
#   `metal ? COMPUTE_MSL : COMPUTE_WGSL` boilerplate.
#
#   Effect main.cpp consumes the bundled bytes via:
#     state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
#     auto cs = gpu::Device::createShaderModuleByName("compute");
compile_shaders_compute_spv() {
  local effect="$1"
  local src="${2:-compute}"
  if ! command -v dxc >/dev/null 2>&1; then
    echo "ERROR: dxc not found. See compile_shaders_compute_fused for install hints."
    return 1
  fi
  dxc -T cs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
    -I "$SHADERS_COMMON_DIR" \
    "../${effect}/${src}.hlsl" -Fo "$TMP_DIR/${effect}_${src}.spv"
  python3 "$(dirname "${BASH_SOURCE[0]}")/_emit_spv_header.py" \
    "$TMP_DIR/${effect}_shaders.h" \
    "${src}=${TMP_DIR}/${effect}_${src}.spv"
  echo "  ${effect} shaders compiled (SPV)"
}

# compile_shaders_full_spv <effect>
#
#   Compile compute + vertex + fragment for an effect to SPIR-V via
#   DXC. Mirrors compile_shaders_full but emits SPV blobs only.
#   Effects use:
#     state::registerShaderSPV("compute",  COMPUTE_SPV,  COMPUTE_SPV_SIZE);
#     state::registerShaderSPV("vertex",   VERTEX_SPV,   VERTEX_SPV_SIZE);
#     state::registerShaderSPV("fragment", FRAGMENT_SPV, FRAGMENT_SPV_SIZE);
#   then `gpu::Device::createShaderModuleByName("vertex")` etc.
compile_shaders_full_spv() {
  local effect="$1"
  if ! command -v dxc >/dev/null 2>&1; then
    echo "ERROR: dxc not found"
    return 1
  fi
  dxc -T cs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
    -I "$SHADERS_COMMON_DIR" \
    "../${effect}/compute.hlsl"  -Fo "$TMP_DIR/${effect}_compute.spv"
  dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
    -I "$SHADERS_COMMON_DIR" \
    "../${effect}/vertex.hlsl"   -Fo "$TMP_DIR/${effect}_vertex.spv"
  dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
    -I "$SHADERS_COMMON_DIR" \
    "../${effect}/fragment.hlsl" -Fo "$TMP_DIR/${effect}_fragment.spv"
  python3 "$(dirname "${BASH_SOURCE[0]}")/_emit_spv_header.py" \
    "$TMP_DIR/${effect}_shaders.h" \
    "compute=${TMP_DIR}/${effect}_compute.spv" \
    "vertex=${TMP_DIR}/${effect}_vertex.spv" \
    "fragment=${TMP_DIR}/${effect}_fragment.spv"
  echo "  ${effect} shaders compiled (SPV: compute + vertex + fragment)"
}

# compile_shaders_compute_var_spv <effect> <variant> [<src_basename>]
#
#   Compile a single named compute variant to SPIR-V via DXC. Works
#   like `compile_shaders_compute_spv` but accepts an arbitrary
#   variant name + source basename — used by effects with multiple
#   compute shaders (fast_blur, atomic_test, hdr_test). The variant
#   name controls the C symbol that ends up in `<effect>_shaders.h`,
#   and is also the name effects pass to `state::registerShaderSPV`
#   at runtime.
#
#   Emits a per-variant SPV file under TMP_DIR. Caller must follow
#   with `_emit_spv_header_var` once all variants are compiled.
compile_shaders_compute_var_spv() {
  local effect="$1"
  local variant="$2"
  local src="${3:-$variant}"
  if ! command -v dxc >/dev/null 2>&1; then
    echo "ERROR: dxc not found"
    return 1
  fi
  dxc -T cs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
    -I "$SHADERS_COMMON_DIR" \
    "../${effect}/${src}.hlsl" -Fo "$TMP_DIR/${effect}_${variant}.spv"
}

# _emit_spv_header_var <effect> <variant1> [<variant2> ...]
#   Bundle the per-variant SPV files into <effect>_shaders.h.
_emit_spv_header_var() {
  local effect="$1"; shift
  local args=()
  for variant in "$@"; do
    args+=("${variant}=${TMP_DIR}/${effect}_${variant}.spv")
  done
  python3 "$(dirname "${BASH_SOURCE[0]}")/_emit_spv_header.py" \
    "$TMP_DIR/${effect}_shaders.h" "${args[@]}"
}

# compile_shaders_compute_fused_spv <effect>
#
#   SPV-only counterpart to compile_shaders_compute_fused — compiles
#   compute.hlsl AND pixel.hlsl (via the same wrapper trick that
#   preserves [noinline] fuse_transform), bundling both as SPV bytes
#   under names "compute" and "pixel". Runtime owns the fragment-
#   extraction + composition step (see Phase 5 plan), so we don't
#   strip anything at build time.
compile_shaders_compute_fused_spv() {
  local effect="$1"
  local effect_dir
  effect_dir="$(cd ../${effect} && pwd)"
  local pixel="${effect_dir}/pixel.hlsl"
  if [ ! -f "$pixel" ]; then
    echo "ERROR: ${effect}/pixel.hlsl not found (required for fusion build)"
    return 1
  fi
  if ! command -v dxc >/dev/null 2>&1; then
    echo "ERROR: dxc not found"
    return 1
  fi

  # 1. Standalone compute shader.
  dxc -T cs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
    -I "$SHADERS_COMMON_DIR" \
    "../${effect}/compute.hlsl" -Fo "$TMP_DIR/${effect}_compute.spv"

  # 2. Fragment SPV — synthetic wrapper around pixel.hlsl (same trick
  # as compile_shaders_compute_fused: gives DXC a main() to hang the
  # entry point on, so [noinline] survives and naga later emits real
  # functions instead of inlined main).
  local second_arg
  if grep -qE 'fuse_transform\s*\(\s*uint2[^,]*,\s*uint2' "$pixel"; then
    second_arg='uint2(0, 0)'
  else
    second_arg='float4(0, 0, 0, 0)'
  fi
  local wrapper="$TMP_DIR/${effect}_pixel_wrapper.hlsl"
  cat > "$wrapper" <<EOF
#include "${pixel}"
RWTexture2D<float4> _fuse_out : register(u1);
[numthreads(1, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint2 _g = gid.xy;
  float4 _r = fuse_transform(_g, ${second_arg});
  _fuse_out[uint2(0, 0)] = _r;
}
EOF
  dxc -T cs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
    -I "$SHADERS_COMMON_DIR" \
    "$wrapper" -Fo "$TMP_DIR/${effect}_pixel.spv"

  python3 "$(dirname "${BASH_SOURCE[0]}")/_emit_spv_header.py" \
    "$TMP_DIR/${effect}_shaders.h" \
    "compute=${TMP_DIR}/${effect}_compute.spv" \
    "pixel=${TMP_DIR}/${effect}_pixel.spv"
  echo "  ${effect} shaders compiled (SPV: compute + pixel)"
}

# compile_shaders_compute_fused <effect>
#   For fusion-aware effects. Compiles compute.hlsl as today (standalone),
#   then ALSO compiles pixel.hlsl as a fragment that the runtime fuser can
#   splice into a composed compute shader.
#
#   pixel.hlsl must declare `[noinline] float4 fuse_transform(uint2, float4)`
#   (or `(uint2, uint2)` for StrictOutput) plus `ConstantBuffer<FuseUniforms>
#   u_fuse : register(b0)`. See native/wasm_modules/saturate/pixel.hlsl for a
#   reference.
#
#   The fragment is compiled via DXC (not glslc) — DXC honors [noinline] so
#   `fuse_transform` survives as a real function instead of being inlined.
#   We wrap pixel.hlsl with a synthetic no-op main, transpile via naga, then
#   strip the wrapper via _fragment_strip.py. The result is exactly the
#   per-pixel kernel: structs, the uniform var, and the (named) functions.
#
#   Emits PIXEL_WGSL[] / PIXEL_MSL[] alongside COMPUTE_WGSL/COMPUTE_MSL in
#   <effect>_shaders.h.
compile_shaders_compute_fused() {
  local effect="$1"
  local effect_dir
  effect_dir="$(cd ../${effect} && pwd)"
  local pixel="${effect_dir}/pixel.hlsl"
  if [ ! -f "$pixel" ]; then
    echo "ERROR: ${effect}/pixel.hlsl not found (required for fusion build)"
    return 1
  fi
  if ! command -v dxc >/dev/null 2>&1; then
    echo "ERROR: dxc not found on PATH. Install DirectXShaderCompiler:"
    echo "  https://github.com/microsoft/DirectXShaderCompiler/releases"
    echo "  or place the binary at /usr/local/bin/dxc."
    return 1
  fi

  # 1. Standalone compute path — unchanged.
  compile_shaders_compute_var "$effect" compute rgba8unorm

  # 2. Fragment build: wrap pixel.hlsl in a synthetic main, run through
  # DXC + naga, strip the wrapper.
  #
  # The wrapper's signature has to match fuse_transform — mappers take
  # (uint2 gid, float4 c), strict-output takes (uint2 gid, uint2
  # vp_size). Detect by greping pixel.hlsl for the strict-out shape so
  # the author doesn't have to pass a separate flag.
  local second_arg
  if grep -qE 'fuse_transform\s*\(\s*uint2[^,]*,\s*uint2' "$pixel"; then
    second_arg='uint2(0, 0)'   # strict-output: vp_size
  else
    second_arg='float4(0, 0, 0, 0)'  # mapper: input color
  fi
  local wrapper="$TMP_DIR/${effect}_pixel_wrapper.hlsl"
  cat > "$wrapper" <<EOF
// Auto-generated wrapper — gives DXC an entry point so it accepts pixel.hlsl
// as a complete compute shader. Stripped after transpilation.
#include "${pixel}"

RWTexture2D<float4> _fuse_out : register(u1);
[numthreads(1, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint2 _g = gid.xy;
  float4 _r = fuse_transform(_g, ${second_arg});
  _fuse_out[uint2(0, 0)] = _r;
}
EOF
  dxc -T cs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
    -I "$SHADERS_COMMON_DIR" \
    "$wrapper" -Fo "$TMP_DIR/${effect}_pixel.spv"
  naga "$TMP_DIR/${effect}_pixel.spv" "$TMP_DIR/${effect}_pixel_raw.wgsl"
  naga --metal-version 2.0 "$TMP_DIR/${effect}_pixel.spv" \
    "$TMP_DIR/${effect}_pixel_raw.metal"

  python3 "$(dirname "${BASH_SOURCE[0]}")/_fragment_strip.py" \
    wgsl "$TMP_DIR/${effect}_pixel_raw.wgsl" "$TMP_DIR/${effect}_pixel.wgsl"
  python3 "$(dirname "${BASH_SOURCE[0]}")/_fragment_strip.py" \
    msl  "$TMP_DIR/${effect}_pixel_raw.metal" "$TMP_DIR/${effect}_pixel.metal"

  _emit_shader_header "$effect" compute pixel
  echo "  ${effect} shaders compiled (compute + pixel fragment)"
}

# compile_shaders_full <effect> — for effects with compute + vertex + fragment.
compile_shaders_full() {
  local effect="$1"
  for stage in compute vertex fragment; do
    glslc -fshader-stage=${stage} -x hlsl \
      -I "$SHADERS_COMMON_DIR" \
      "../${effect}/${stage}.hlsl" -o "$TMP_DIR/${effect}_${stage}.spv"
    naga "$TMP_DIR/${effect}_${stage}.spv" "$TMP_DIR/${effect}_${stage}.wgsl"
    # Same storage-texture format fixup compile_shaders_compute applies.
    # naga emits rgba32float,read_write for HLSL `RWTexture2D<float4>`,
    # but our textures are bound as rgba8unorm and the shader only writes —
    # downgrade to write-only rgba8unorm.
    if [ "$stage" = "compute" ]; then
      sed -i '' 's/rgba32float,read_write/rgba8unorm,write/g' "$TMP_DIR/${effect}_${stage}.wgsl"
      sed -i '' 's/rgba32float/rgba8unorm/g' "$TMP_DIR/${effect}_${stage}.wgsl"
    fi
    # MSL 2.0 enables read-write storage textures (and other modern features
    # that naga's MSL output relies on for storage-texture access).
    naga --metal-version 2.0 "$TMP_DIR/${effect}_${stage}.spv" "$TMP_DIR/${effect}_${stage}.metal"
  done
  _emit_shader_header "$effect" compute vertex fragment
  echo "  ${effect} shaders compiled (compute+vertex+fragment)"
}
