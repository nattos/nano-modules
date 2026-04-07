#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=bridge_core

SRC_DIR=../../src
NLOHMANN_DIR=../../build/_deps/nlohmann_json-src/include

# Verify nlohmann/json headers exist (populated by CMake FetchContent)
if [ ! -f "$NLOHMANN_DIR/nlohmann/json.hpp" ]; then
  echo "ERROR: nlohmann/json not found at $NLOHMANN_DIR"
  echo "Run 'cmake -B ../../build -S ../..' first to fetch dependencies."
  exit 1
fi

source ../wasm_build_env.sh

# Override common exports — bridge_core has its own API, not the module API
WASM_COMMON_EXPORTS=()

# Export all bridge_core_* C API functions
WASM_EXPORTS=(
  -Wl,--export=bridge_core_create
  -Wl,--export=bridge_core_destroy
  -Wl,--export=bridge_core_tick
  -Wl,--export=bridge_core_connect_client
  -Wl,--export=bridge_core_disconnect_client
  -Wl,--export=bridge_core_receive_message
  -Wl,--export=bridge_core_poll_outgoing
  -Wl,--export=bridge_core_register_plugin
  -Wl,--export=bridge_core_register_with_schema
  -Wl,--export=bridge_core_declare_param
  -Wl,--export=bridge_core_declare_io
  -Wl,--export=bridge_core_log
  -Wl,--export=bridge_core_log_structured
  -Wl,--export=bridge_core_set_plugin_state
  -Wl,--export=bridge_core_get_plugin_state
  -Wl,--export=bridge_core_apply_client_patch
  -Wl,--export=bridge_core_get_param
  -Wl,--export=bridge_core_set_param
  -Wl,--export=bridge_core_queue_param_write
  -Wl,--export=bridge_core_set_param_path
  -Wl,--export=bridge_core_get_param_path
  -Wl,--export=bridge_core_set_at
  -Wl,--export=bridge_core_get_at
  -Wl,--export=bridge_core_get_plugin_key
  -Wl,--export=malloc
  -Wl,--export=free
)

SOURCES=(
  "$SRC_DIR/bridge/bridge_core.cpp"
  "$SRC_DIR/bridge/bridge_core_api.cpp"
  "$SRC_DIR/bridge/state_document.cpp"
  "$SRC_DIR/bridge/observer_registry.cpp"
  "$SRC_DIR/bridge/param_cache.cpp"
  "$SRC_DIR/bridge/composition_cache.cpp"
  "$SRC_DIR/resolume/composition.cpp"
  "$SRC_DIR/json/json_patch.cpp"
  "$SRC_DIR/json/json_doc.cpp"
)

echo "Building $MODULE_NAME.wasm..."
"$CLANG" "${WASM_CXXFLAGS[@]}" \
  -DBRIDGE_SINGLE_THREADED \
  -I"$SRC_DIR" \
  -I"$NLOHMANN_DIR" \
  "${WASM_LDFLAGS[@]}" \
  "${WASM_EXPORTS[@]}" \
  "${SOURCES[@]}" \
  -o "$OUT_DIR/$MODULE_NAME.wasm"

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm") bytes)"
