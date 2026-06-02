#!/bin/bash
# parity_check.sh — prove the text engine is byte-identical native vs wasm.
#
# Builds text_engine.wasm + the native parity_dump tool, runs both on the same
# spec(s), and structurally compares their digests (float tolerance, ignoring
# the memory-pointer field which is legitimately environment-specific). This is
# the headline Phase-0 guarantee: the web simulator reproduces the native
# "for realz" pixels.
set -euo pipefail
cd "$(dirname "$0")"

ROOT="../../.."
SRC="../../src/text"

echo "[1/3] building text_engine.wasm"
bash build.sh >/dev/null

echo "[2/3] building native parity_dump"
clang++ -std=c++17 -fno-exceptions -fno-rtti -O2 \
  "$SRC/text_engine.cpp" "$SRC/tools/parity_dump.cpp" -I "$SRC" -o /tmp/te_parity_dump

DUMP_DIR="$ROOT/build/text-dumps"
mkdir -p "$DUMP_DIR"

# Specs to check (add tricky cases here as the engine grows).
SPECS=(
  '{"text":"Hello\nWorld!","runs":[{"start":0,"len":12,"size_px":48}],"constraints":{"max_width_px":300}}'
  '{"text":"wrap me onto many lines please","constraints":{"max_width_px":160,"size_px":24}}'
  '{"text":"€ é ✓ 你好","size_px":32}'
)

echo "[3/3] comparing digests + dumping PNGs"
fail=0
i=0
for spec in "${SPECS[@]}"; do
  i=$((i+1))
  TE_PNG="$DUMP_DIR/case${i}_native.png" /tmp/te_parity_dump "$spec" > /tmp/te_native.json
  TE_PNG="$DUMP_DIR/case${i}_wasm.png" node parity_dump.mjs "$spec" > /tmp/te_wasm.json
  if node compare_digests.mjs /tmp/te_native.json /tmp/te_wasm.json; then
    echo "  ✅ parity (geometry + pixels): $spec"
  else
    echo "  ❌ MISMATCH: $spec"; fail=1
  fi
done
echo "  PNGs in $DUMP_DIR"

[ "$fail" -eq 0 ] && echo "ALL PARITY CHECKS PASSED" || { echo "PARITY FAILURES"; exit 1; }
