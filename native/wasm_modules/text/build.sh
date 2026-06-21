#!/bin/bash
# Build text.wasm — the bundle containing the source.text.plain effect. Unlike most
# effects, source.text.plain ships NO shaders: it drives the host `text.*` service
# (the shared FreeType+msdfgen engine + GPU compositor live in the host), so
# this is just the tiny effect that builds a JSON spec and calls text.layout /
# text.render.
set -e
cd "$(dirname "$0")"

OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=text

source ../wasm_build_env.sh

# v2 instance ABI: the host calls create/init/render/etc. via function-table
# indices, so the indirect function table must be exported alongside
# nano_module_main + malloc/free.
WASM_COMMON_EXPORTS=(
  -Wl,--export=nano_module_main
  -Wl,--export=malloc
  -Wl,--export=free
  -Wl,--export=__indirect_function_table
)

echo "Building text.wasm (source.text.plain)"
wasm_build \
  -I"$TMP_DIR" \
  -I../include \
  -I../../src \
  main.cpp

echo "  -> $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm") bytes)"
