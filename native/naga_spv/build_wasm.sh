#!/bin/bash
# build_wasm.sh — build naga_spv.wasm (SPIR-V -> WGSL) and stage it where the
# web app loads it (build/wasm/naga_spv.wasm, served as /wasm/naga_spv.wasm).
#
# This is the packaged app's shader pipeline. Without it, a build that isn't
# sitting behind the Vite dev server has no way to turn the SPIR-V baked into
# the effect bundles into the WGSL WebGPU wants — see web/src/naga-wgsl.ts and
# the comment at the top of Cargo.toml.
#
# Mirrors ../text_blitz/build_wasm.sh; same toolchain requirement:
#   rustup target add wasm32-wasip1
set -euo pipefail
cd "$(dirname "$0")"

cargo build --release --target wasm32-wasip1
SRC="target/wasm32-wasip1/release/naga_spv.wasm"
DEST="../../build/wasm/naga_spv.wasm"
mkdir -p "$(dirname "$DEST")"
cp -f "$SRC" "$DEST"
echo "  -> $DEST ($(wc -c < "$DEST") bytes)"
