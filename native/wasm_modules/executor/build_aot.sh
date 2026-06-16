#!/bin/bash
# Build executor.aot from executor.wasm via WAMR's AOT compiler (wamrc).
#
# AOT removes the per-frame interpreter cost on the NATIVE barrel (the web host
# is JIT, so it stays on the portable .wasm). Two halves:
#   1. LOAD side — the runtime must be built with AOT loading enabled:
#        cmake -B build -S . -DNANO_EXECUTOR_AOT=ON
#   2. PRODUCE side — this script. WasmExecutorDriver then prefers executor.aot
#        over executor.wasm automatically (falls back to .wasm if absent).
#
# Requires `wamrc`. It is NOT built here (it needs LLVM). Either:
#   - build it from native/build/_deps/wamr-src/wamr-compiler (see WAMR docs), or
#   - download a WAMR release that ships wamrc,
# then put it on PATH or set WAMRC=/path/to/wamrc.
#
# This is scaffolding for task #107 (retire the in-process native executor). Run
# it after measuring interp perf, if AOT is needed to hit parity.
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
WASM="$OUT_DIR/executor.wasm"
AOT="$OUT_DIR/executor.aot"

WAMRC="${WAMRC:-wamrc}"
if ! command -v "$WAMRC" >/dev/null 2>&1; then
  echo "ERROR: wamrc not found (set WAMRC=/path/to/wamrc or add it to PATH)."
  echo "  AOT is optional — without it the barrel loads executor.wasm (interpreted)."
  exit 1
fi
if [ ! -f "$WASM" ]; then
  echo "ERROR: $WASM not found — run ./build.sh first."
  exit 1
fi

# wamrc defaults to the host triple (the barrel runs natively). Pass --target /
# --cpu explicitly here if you ever cross-compile the .aot for another host.
echo "Compiling executor.aot from executor.wasm..."
"$WAMRC" -o "$AOT" "$WASM"
echo "Built: $AOT ($(wc -c < "$AOT") bytes)"
