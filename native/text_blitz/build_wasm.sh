#!/bin/bash
# build_wasm.sh — build text_blitz.wasm (the Rust Blitz layout lib) and stage it
# where the web app serves it (web/public/wasm/text_blitz.wasm). The web text
# engine loads it as the optional complex-layout mode (see web/src/text-engine.ts
# initBlitz). Pixel-parity with native is checked by ../wasm_modules/text_engine/
# blitz_parity.sh.
set -euo pipefail
cd "$(dirname "$0")"

cargo build --release --target wasm32-wasip1
SRC="target/wasm32-wasip1/release/text_blitz.wasm"
DEST="../../web/public/wasm/text_blitz.wasm"
cp -f "$SRC" "$DEST"
echo "  -> $DEST ($(wc -c < "$DEST") bytes)"
