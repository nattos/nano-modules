#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=nanolooper

source ../wasm_build_env.sh

WASM_EXPORTS=()

echo "Building $MODULE_NAME.wasm..."
wasm_build -I../../src main.cpp core.cpp
echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
