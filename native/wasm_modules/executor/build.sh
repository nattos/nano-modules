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

source ../wasm_build_env.sh

# The executor's OWN shaders (blend / output blit / sidechannel blit) — one
# authored HLSL each, baked to SPIR-V and translated by the host per backend.
# The native CMake build runs the same script into the same TMP_DIR.
"$SRC_DIR/sketch/shaders/build_shaders.sh" "$(cd "$TMP_DIR" && pwd)"

# nlohmann/json — see bridge_core/build.sh. CMake normally fetches it; a
# web-only (or non-macOS) checkout has no native configure step, so fetch here.
ensure_nlohmann "$(dirname "$NLOHMANN_DIR")"

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
  "$SRC_DIR/sketch/trigger_bus.cpp"
  "$SRC_DIR/sketch/executor_api.cpp"
  "$SRC_DIR/sketch/comp/comp_executor.cpp"
  "$SRC_DIR/sketch/comp/comp_api.cpp"
)

echo "Building $MODULE_NAME.wasm..."
"$CLANG" "${WASM_CXXFLAGS[@]}" \
  -I"$SRC_DIR" \
  -I"$TMP_DIR" \
  -I"$NLOHMANN_DIR" \
  "${WASM_LDFLAGS[@]}" \
  "${WASM_EXPORTS[@]}" \
  "${SOURCES[@]}" \
  -o "$OUT_DIR/$MODULE_NAME.wasm"

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm") bytes)"
