#!/usr/bin/env bash
# barrel_wasm_parity.sh — headless A/B pixel-parity check for the barrel-loads-
# WASM cutover. Runs a sketch through ffgl_runner twice — the static-linked
# effects vs NANO_BARREL_WASM_EFFECTS (loaded from .wasm) — and asserts the
# output is byte-identical. No Resolume required.
#
# Usage: barrel_wasm_parity.sh [build_dir] [sketch.json]
#   build_dir : dir holding ffgl_runner + NanoBarrel.bundle (default: ../build)
#   sketch    : sketch JSON to run (default: a brightness_contrast chain)
#
# Requires ImageMagick (`magick`). Exits non-zero on any pixel difference.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="${1:-$here/../build}"
runner="$build/ffgl_runner"
bundle="$build/NanoBarrel.bundle"
wasmdir="$here/../../build/wasm"   # native/tools -> text/build/wasm

[ -x "$runner" ] || { echo "FAIL: ffgl_runner not built ($runner)"; exit 1; }
[ -d "$bundle" ] || { echo "FAIL: NanoBarrel.bundle not built ($bundle)"; exit 1; }
command -v magick >/dev/null || { echo "FAIL: ImageMagick (magick) not found"; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

sketch="${2:-}"
if [ -z "$sketch" ]; then
  sketch="$tmp/sketch.json"
  cat > "$sketch" <<'JSON'
{ "columns": [ { "chain": [
      { "module_type": "video.brightness_contrast", "instance_key": "k0" } ] } ],
  "instances": { "k0": { "module_type": "video.brightness_contrast",
      "state": { "brightness": 0.75, "contrast": 0.5 } } } }
JSON
fi

run() {  # $1=out_png  $2=static|wasm
  if [ "$2" = wasm ]; then
    NANO_BARREL_WASM_EFFECTS=1 NANO_BARREL_WASM_DIR="$wasmdir" \
      "$runner" "$bundle" 64 64 8 "$1" --config "$sketch" >/dev/null 2>&1
  else
    # WASM is the default now — force the statically-linked path explicitly.
    NANO_BARREL_WASM_EFFECTS=0 \
      "$runner" "$bundle" 64 64 8 "$1" --config "$sketch" >/dev/null 2>&1
  fi
}

run "$tmp/static.png" static
run "$tmp/wasm.png"   wasm

ae="$(magick compare -metric AE "$tmp/static.png" "$tmp/wasm.png" "$tmp/diff.png" 2>&1 || true)"
echo "AE (differing pixels): $ae"
if [ "$ae" = "0" ]; then
  echo "PASS: WASM-loaded effects are pixel-identical to the static-linked path"
else
  cp "$tmp/diff.png" /tmp/barrel_wasm_parity_diff.png 2>/dev/null || true
  echo "FAIL: WASM vs static differ ($ae px); diff -> /tmp/barrel_wasm_parity_diff.png"
  exit 1
fi
