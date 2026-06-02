#!/bin/bash
# Build text_engine.wasm — the single shared text engine the WEB host worker
# loads ONCE and drives on behalf of every effect's text.* calls. Compiled from
# the exact same native/src/text sources that link natively into effect_runtime,
# so its CPU output (atlas + geometry + metrics) is byte-identical across
# environments — the basis of web↔native pixel parity.
#
# Unlike an effect module, this is a plain WASM library: it exports a flat te_*
# C ABI (not init/tick/render) plus malloc/free for the host to stage the spec
# JSON into linear memory.
set -euo pipefail

cd "$(dirname "$0")"
source ../wasm_build_env.sh

SRC_DIR="../../src/text"
OUT_DIR="${1:-../../../build/wasm}"
mkdir -p "$OUT_DIR"

# Engine-specific exports (te_* surface). malloc/free/__wasm_call_ctors let the
# host stage input and run static initializers after instantiate.
TE_EXPORTS=(
  -Wl,--export=te_layout
  -Wl,--export=te_measure
  -Wl,--export=te_glyph_count
  -Wl,--export=te_glyphs
  -Wl,--export=te_release
  -Wl,--export=te_rasterize
  -Wl,--export=te_atlas_width
  -Wl,--export=te_atlas_height
  -Wl,--export=te_atlas_ptr
  -Wl,--export=te_next_dirty_region
  -Wl,--export=malloc
  -Wl,--export=free
  -Wl,--export=__wasm_call_ctors
)

SOURCES=(
  "$SRC_DIR/text_engine.cpp"
  "$SRC_DIR/text_engine_wasm.cpp"
)

echo "Building text_engine.wasm"
echo "  clang++: ${SOURCES[*]}"
"$CLANG" "${WASM_CXXFLAGS[@]}" "${WASM_LDFLAGS[@]}" "${TE_EXPORTS[@]}" \
  -I "$SRC_DIR" \
  "${SOURCES[@]}" -o "$OUT_DIR/text_engine.wasm"

echo "  -> $OUT_DIR/text_engine.wasm ($(wc -c < "$OUT_DIR/text_engine.wasm") bytes)"
