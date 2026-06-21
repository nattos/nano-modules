#!/bin/bash
# text_host_parity.sh — build + run the native text.* HOST-IMPL parity harness.
#
# Unlike metal_parity.sh (which drives a standalone Metal harness), this compiles
# the REAL FFGL code path — host_impls_text.cpp + effect_runtime + metal_backend
# + the text engine + libtext_blitz.a — and drives text_layout/text_render
# exactly as source.text.plain / source.text.rich do, asserting the GPU composite matches the
# CPU golden (Engine::rasterize) for BOTH an attributed-string spec and a
# mode:html (Blitz) spec.
set -euo pipefail
cd "$(dirname "$0")"

ROOT="../../.."
SRCDIR="$ROOT/native/src"
TXT="$SRCDIR/text"
RT="$SRCDIR/runtime"
TP="$ROOT/native/third_party"
BLITZ="$ROOT/native/text_blitz"
NJSON="$ROOT/native/build/_deps/nlohmann_json-src/single_include"
OUT="$ROOT/build/text-dumps"
mkdir -p "$OUT" /tmp/thp

FONT="${TE_FONT:-$ROOT/web/public/fonts/default.ttf}"
# CJK faces live in web/test-fonts (fetched, not served — see web/scripts/fetch_fonts.sh).
FALLBACK="${TE_FALLBACK:-$ROOT/web/test-fonts/noto-sans-jp.ttf:$ROOT/web/test-fonts/noto-sans-kr.ttf:$ROOT/web/test-fonts/noto-sans-sc.ttf:$ROOT/web/test-fonts/noto-sans-tc.ttf}"

echo "[1/4] building text_blitz (native staticlib)"
( cd "$BLITZ" && cargo build --release >/dev/null 2>&1 )
LIB="$BLITZ/target/release/libtext_blitz.a"

echo "[2/4] compiling vendored engine deps (FreeType + msdfgen + libunibreak)"
[ -d "$TP/freetype" ] || bash "$TP/fetch_deps.sh"
FT_INC="-I$TP/freetype/include -I$TP/ft-config -I$TP/msdf-config -I$TP/msdfgen -I$TP/libunibreak/src -I$TXT"
FTDEF="-DFT2_BUILD_LIBRARY"
OBJ=""
for s in base/ftbase base/ftinit base/ftsystem base/ftdebug base/ftbitmap base/ftmm sfnt/sfnt truetype/truetype psnames/psnames cff/cff psaux/psaux pshinter/pshinter; do
  o="/tmp/thp/ft_$(basename $s).o"
  [ -f "$o" ] || clang -std=c11 -O2 $FTDEF '-DFT_CONFIG_OPTIONS_H="ftoption_custom.h"' '-DFT_CONFIG_MODULES_H="ftmodule_custom.h"' -I"$TP/freetype/include" -I"$TP/ft-config" -c "$TP/freetype/src/$s.c" -o "$o"
  OBJ="$OBJ $o"
done
for c in Contour DistanceMapping EdgeHolder MSDFErrorCorrection Projection Scanline Shape contour-combiners edge-coloring edge-segments edge-selectors equation-solver msdf-error-correction msdfgen rasterization render-sdf sdf-error-estimation shape-description; do
  o="/tmp/thp/md_$c.o"
  [ -f "$o" ] || clang++ -std=c++17 -fno-exceptions -fno-rtti -O2 -I"$TP/msdf-config" -I"$TP/msdfgen" -c "$TP/msdfgen/core/$c.cpp" -o "$o"
  OBJ="$OBJ $o"
done
for s in linebreak linebreakdata linebreakdef unibreakbase unibreakdef eastasianwidthdef eastasianwidthdata; do
  o="/tmp/thp/ub_$s.o"
  [ -f "$o" ] || clang -std=c11 -O2 -I"$TP/libunibreak/src" -c "$TP/libunibreak/src/$s.c" -o "$o"
  OBJ="$OBJ $o"
done
# Engine (pure CPU, -fno-exceptions like the lib build).
clang++ -std=c++17 -fno-exceptions -fno-rtti -O2 $FTDEF '-DFT_CONFIG_OPTIONS_H="ftoption_custom.h"' '-DFT_CONFIG_MODULES_H="ftmodule_custom.h"' \
  $FT_INC -c "$TXT/text_engine.cpp" -o /tmp/thp/text_engine.o
OBJ="$OBJ /tmp/thp/text_engine.o"

echo "[3/4] compiling runtime (host_impls_text + effect_runtime + metal_backend) and harness"
RT_INC="-I$SRCDIR -I$ROOT/native/wasm_modules/include -I$NJSON"
# Runtime C++ TUs (exceptions ON — nlohmann). -Wno-attributes for the WASM
# import_module annotations seen via effect headers.
for f in runtime/effect_runtime runtime/host_impls runtime/host_impls_text runtime/gpu_impls; do
  clang++ -std=c++17 -O2 -Wno-attributes $RT_INC -c "$SRCDIR/$f.cpp" -o "/tmp/thp/$(basename $f).o"
  OBJ="$OBJ /tmp/thp/$(basename $f).o"
done
# Metal backend + harness (ObjC++).
clang++ -ObjC++ -fobjc-arc -std=c++17 -O2 $RT_INC -c "$SRCDIR/gpu/metal_backend.mm" -o /tmp/thp/metal_backend.o
clang++ -ObjC++ -fobjc-arc -std=c++17 -O2 -Wno-attributes $RT_INC -I"$TXT" -c "$TXT/tools/text_host_metal.mm" -o /tmp/thp/text_host_metal.o
OBJ="$OBJ /tmp/thp/metal_backend.o /tmp/thp/text_host_metal.o"

RUSTLIBS="-framework CoreFoundation -framework Security -framework SystemConfiguration -liconv -lobjc"
clang++ -std=c++17 -O2 $OBJ "$LIB" $RUSTLIBS \
  -framework Metal -framework MetalPerformanceShaders -framework Foundation \
  -o /tmp/thp/text_host_metal

echo "[4/4] running host-path parity (source.text.plain JSON + source.text.rich html)"
export TE_FONT="$FONT" TE_FALLBACK="$FALLBACK"
rc=0
TE_PNG="$OUT/host_text.png"  /tmp/thp/text_host_metal text          | sed 's/^/  text: /' || rc=1
TE_PNG="$OUT/host_html.png"  /tmp/thp/text_host_metal html "${1:-}"  | sed 's/^/  html: /' || rc=1
echo "  PNGs: $OUT/host_text.png  $OUT/host_html.png"
exit $rc
