#!/bin/bash
# Build the NanoLooper WASM module.
#
# Requires a clang with WebAssembly target support. Install via:
#   brew install llvm
# or download wasi-sdk from https://github.com/WebAssembly/wasi-sdk
#
# Usage:
#   ./build.sh [output_dir]
#
# Output: nanolooper.wasm in the specified directory (default: ../../build/)

set -e
cd "$(dirname "$0")"

OUT_DIR="${1:-../../build}"
mkdir -p "$OUT_DIR"

# Find a WASM-capable clang
CLANG=""
for candidate in \
  /opt/homebrew/opt/llvm/bin/clang \
  /usr/local/opt/llvm/bin/clang \
  /opt/wasi-sdk/bin/clang \
  clang; do
  if [ -x "$candidate" ] 2>/dev/null; then
    if "$candidate" --print-targets 2>/dev/null | grep -qi wasm; then
      CLANG="$candidate"
      break
    fi
  fi
done

if [ -z "$CLANG" ]; then
  echo "ERROR: No WASM-capable clang found."
  echo "Install via: brew install llvm"
  exit 1
fi

echo "Using: $CLANG"
echo "Building nanolooper.wasm..."

"$CLANG" \
  --target=wasm32-unknown-unknown \
  -nostdlib \
  -O2 \
  -std=c11 \
  -Wl,--no-entry \
  -Wl,--export=init \
  -Wl,--export=tick \
  -Wl,--export=render \
  -Wl,--export=on_param_change \
  -Wl,--allow-undefined \
  core.c main.c \
  -o "$OUT_DIR/nanolooper.wasm"

echo "Built: $OUT_DIR/nanolooper.wasm"
ls -la "$OUT_DIR/nanolooper.wasm"
