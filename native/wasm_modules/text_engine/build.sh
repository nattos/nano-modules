#!/bin/bash
# Build text_engine.wasm — the single shared text engine the WEB host worker
# loads once. Compiled from the same native/src/text sources that link natively
# into effect_runtime, statically including the vendored FreeType + msdfgen
# (Phase 1) so CPU output is byte-identical across environments.
#
# Vendored dep sources are fetched by native/third_party/fetch_deps.sh (not
# committed); the hand-authored config lives in third_party/{ft-config,
# msdf-config,wasm-shim}. See third_party/PHASE1_DEPS.md.
set -euo pipefail
cd "$(dirname "$0")"
source ../wasm_build_env.sh

SRC_DIR="../../src/text"
TP="../../third_party"
OUT_DIR="${1:-../../../build/wasm}"
mkdir -p "$OUT_DIR"

if [ ! -d "$TP/freetype" ] || [ ! -d "$TP/msdfgen" ] || [ ! -d "$TP/libunibreak" ]; then
  echo "Vendored deps missing — running fetch_deps.sh"; bash "$TP/fetch_deps.sh"
fi

# Include paths: setjmp shim first (shadow wasi-libc's erroring header).
INCS=(-I"$TP/wasm-shim" -I"$TP/freetype/include" -I"$TP/ft-config"
      -I"$TP/msdf-config" -I"$TP/msdfgen" -I"$TP/libunibreak/src" -I"$SRC_DIR")
FTDEFS=(-DFT2_BUILD_LIBRARY '-DFT_CONFIG_OPTIONS_H="ftoption_custom.h"'
        '-DFT_CONFIG_MODULES_H="ftmodule_custom.h"')

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
objs=()

echo "Building text_engine.wasm (FreeType + msdfgen + engine)"
# FreeType subset (C).
for s in base/ftbase base/ftinit base/ftsystem base/ftdebug base/ftbitmap base/ftmm \
         sfnt/sfnt truetype/truetype psnames/psnames \
         cff/cff psaux/psaux pshinter/pshinter; do
  o="$TMP/ft_$(basename "$s").o"
  "$CLANG" "${WASM_CXXFLAGS[@]}" "${INCS[@]}" "${FTDEFS[@]}" -c "$TP/freetype/src/$s.c" -o "$o"
  objs+=("$o")
done
# libunibreak (C): UAX#14 line breaking for CJK-aware wrapping. Must build as C
# (it relies on C's implicit enum/void* conversions that C++ rejects).
UB_CFLAGS=(--target=wasm32-wasip1 --sysroot="$WASI_LIBC" -O2 -x c -std=c11 -fno-exceptions)
for s in linebreak linebreakdata linebreakdef unibreakbase unibreakdef \
         eastasianwidthdef eastasianwidthdata; do
  o="$TMP/ub_$s.o"
  "$CLANG" "${UB_CFLAGS[@]}" -I"$TP/libunibreak/src" -c "$TP/libunibreak/src/$s.c" -o "$o"
  objs+=("$o")
done
# msdfgen core subset (C++), excludes ext/ + save-*/export-svg.
for c in Contour DistanceMapping EdgeHolder MSDFErrorCorrection Projection Scanline Shape \
         contour-combiners edge-coloring edge-segments edge-selectors equation-solver \
         msdf-error-correction msdfgen rasterization render-sdf sdf-error-estimation shape-description; do
  o="$TMP/md_$c.o"
  "$CLANG" "${WASM_CXXFLAGS[@]}" "${INCS[@]}" -c "$TP/msdfgen/core/$c.cpp" -o "$o"
  objs+=("$o")
done
# Engine + wasm ABI.
for s in text_engine text_engine_wasm; do
  o="$TMP/$s.o"
  "$CLANG" "${WASM_CXXFLAGS[@]}" "${INCS[@]}" -c "$SRC_DIR/$s.cpp" -o "$o"
  objs+=("$o")
done

EXPORTS=(te_set_font te_add_font te_has_font te_add_fallback_font te_set_default_lang te_layout te_layout_glyphs te_measure te_glyph_count te_glyphs te_release
         te_rasterize te_atlas_width te_atlas_height te_atlas_page_count te_atlas_page_ptr te_next_dirty_region
         malloc free __wasm_call_ctors)
EXPFLAGS=(); for e in "${EXPORTS[@]}"; do EXPFLAGS+=(-Wl,--export="$e"); done

"$CLANG" "${WASM_CXXFLAGS[@]}" "${WASM_LDFLAGS[@]}" "${EXPFLAGS[@]}" \
  "${objs[@]}" -o "$OUT_DIR/text_engine.wasm"
echo "  -> $OUT_DIR/text_engine.wasm ($(wc -c < "$OUT_DIR/text_engine.wasm") bytes)"
