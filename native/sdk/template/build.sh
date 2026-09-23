#!/bin/bash
# Build this effect bundle into out/<MODULE_NAME>.wasm.
#
#   NANO_SDK=/path/to/nano-sdk ./build.sh             # build
#   NANO_SDK=/path/to/nano-sdk ./build.sh --install   # ...and copy it into the
#                                                     # per-user Modules folder
#
# Needs a wasm-capable clang (wasi-sdk) and dxc on PATH — see README.md.
set -euo pipefail
cd "$(dirname "$0")"

# The bundle's file name, and so its id: com.nano.<MODULE_NAME>. A bundle with
# the same name as another replaces it, so pick one nobody else will use.
MODULE_NAME="${MODULE_NAME:-my_effects}"

# Inside an unpacked SDK the template sits at <sdk>/template, so default to that.
if [ -z "${NANO_SDK:-}" ] && [ -f ../scripts/wasm_build_env.sh ]; then
  NANO_SDK="$(cd .. && pwd)"
fi
: "${NANO_SDK:?set NANO_SDK to the Nano effect SDK directory (the one holding scripts/ and include/)}"

OUT_DIR="${OUT_DIR:-$PWD/out}"
TMP_DIR="${TMP_DIR:-$OUT_DIR/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"

# Effects are the folders beside this script.
NANO_EFFECTS_ROOT="$PWD"
source "$NANO_SDK/scripts/wasm_build_env.sh"

echo "=== Shaders ==="
# One line per shader-carrying effect. compile_shaders_compute_spv <folder>
# compiles <folder>/compute.hlsl and writes <folder>_shaders.h (COMPUTE_SPV)
# into TMP_DIR. The SDK's scripts/wasm_build_env.sh has variants for several
# compute shaders, vertex+fragment pairs, and fusable per-pixel kernels.
compile_shaders_compute_spv tint

echo "=== Link ==="
wasm_build \
  -I"$TMP_DIR" \
  -I"$NANO_INCLUDE_DIR" \
  bundle.cpp \
  tint/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm") bytes)"

if [ "${1:-}" = "--install" ]; then
  # The Modules folder the apps and the Resolume plugin scan. Mapping out/ in
  # Settings -> Modules instead gives you live reload on every rebuild.
  if [ -n "${NANO_MODULES_DIR:-}" ]; then
    dest="$NANO_MODULES_DIR"
  elif [ -n "${APPDATA:-}" ]; then
    dest="$APPDATA/Nano Modules/Modules"
  else
    dest="$HOME/Library/Application Support/Nano Modules/Modules"
  fi
  mkdir -p "$dest"
  cp -f "$OUT_DIR/$MODULE_NAME.wasm" "$dest/"
  echo "Installed: $dest/$MODULE_NAME.wasm"
fi
