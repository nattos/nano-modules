#!/bin/bash
set -e
cd "$(dirname "$0")"

OUT_DIR="${1:-../../build}"
mkdir -p "$OUT_DIR"

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
  exit 1
fi

echo "Using: $CLANG"
echo "Building paramlinker.wasm..."

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
  -Wl,--export=on_state_changed \
  -Wl,--export=on_resolume_param \
  -Wl,--allow-undefined \
  main.c \
  -o "$OUT_DIR/paramlinker.wasm"

echo "Built: $OUT_DIR/paramlinker.wasm"
ls -la "$OUT_DIR/paramlinker.wasm"
