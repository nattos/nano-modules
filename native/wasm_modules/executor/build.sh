#!/bin/bash
# Build executor.wasm — the unified sketch executor (C++ single-source, shared
# by the native barrel and the web engine worker). Mirrors bridge_core/build.sh:
# pure-logic module over the gpu/effrt host-import ABIs.
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=executor

SRC_DIR=../../src
NLOHMANN_DIR=../../build/_deps/nlohmann_json-src/include

if [ ! -f "$NLOHMANN_DIR/nlohmann/json.hpp" ]; then
  echo "ERROR: nlohmann/json not found at $NLOHMANN_DIR"
  echo "Run 'cmake -B ../../build -S ../..' first to fetch dependencies."
  exit 1
fi

source ../wasm_build_env.sh

# The executor has its own C API, not the per-effect module API.
WASM_COMMON_EXPORTS=()

WASM_EXPORTS=(
  -Wl,--export=__wasm_call_ctors
  -Wl,--export=executor_create
  -Wl,--export=executor_destroy
  -Wl,--export=executor_register_schema
  -Wl,--export=executor_register_capabilities
  -Wl,--export=executor_execute
  -Wl,--export=executor_set_fusion_enabled
  -Wl,--export=executor_debug_stats
  -Wl,--export=malloc
  -Wl,--export=free
)

SOURCES=(
  "$SRC_DIR/sketch/sketch_executor.cpp"
  "$SRC_DIR/sketch/sketch_augment.cpp"
  "$SRC_DIR/sketch/sidechannel_bus.cpp"
  "$SRC_DIR/sketch/executor_api.cpp"
  "$SRC_DIR/sketch/comp/comp_executor.cpp"
  "$SRC_DIR/sketch/comp/comp_api.cpp"
)

echo "Building $MODULE_NAME.wasm..."
"$CLANG" "${WASM_CXXFLAGS[@]}" \
  -I"$SRC_DIR" \
  -I"$NLOHMANN_DIR" \
  "${WASM_LDFLAGS[@]}" \
  "${WASM_EXPORTS[@]}" \
  "${SOURCES[@]}" \
  -o "$OUT_DIR/$MODULE_NAME.wasm"

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm") bytes)"
