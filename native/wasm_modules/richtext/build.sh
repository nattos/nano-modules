#!/bin/bash
# Build richtext.wasm — the gen.richtext effect. Like text.wasm it ships NO
# shaders: it builds a {mode:"html"} spec and calls the host text.* service,
# which lays the document out in its Blitz mode (text_blitz.wasm on web) and
# rasterizes through the shared MSDF atlas + compositor.
set -e
cd "$(dirname "$0")"

OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=richtext

source ../wasm_build_env.sh

WASM_COMMON_EXPORTS=(
  -Wl,--export=nano_module_main
  -Wl,--export=malloc
  -Wl,--export=free
  -Wl,--export=__indirect_function_table
)

echo "Building richtext.wasm (gen.richtext)"
wasm_build \
  -I"$TMP_DIR" \
  -I../include \
  -I../../src \
  main.cpp

echo "  -> $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm") bytes)"
