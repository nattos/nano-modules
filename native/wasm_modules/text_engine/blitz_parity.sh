#!/bin/bash
# blitz_parity.sh — native end-to-end of the Blitz complex-layout mode, and the
# cross-target run-parity check.
#
#   HTML/CSS → text_blitz (Rust: Stylo+Taffy+parley) → pre-shaped runs →
#   text_engine (FreeType+msdfgen) rasterize-by-GID → PNG
#
# 1) Builds libtext_blitz.a (native) + text_blitz.wasm.
# 2) Builds the native blitz_dump tool (engine + lib), runs it → PNG + digest +
#    raw run buffer.
# 3) Runs the SAME doc through text_blitz.wasm and asserts the run buffers are
#    BYTE-IDENTICAL — Blitz layout+shaping is deterministic native↔wasm, so the
#    web simulator reproduces the native pixels.
set -euo pipefail
cd "$(dirname "$0")"

ROOT="../../.."
SRC="../../src/text"
TP="$ROOT/native/third_party"
BLITZ="$ROOT/native/text_blitz"
OUT="$ROOT/build/text-dumps"
mkdir -p "$OUT"

FONT="${TE_FONT:-$ROOT/web/public/fonts/default.ttf}"
FALLBACK="${TE_FALLBACK:-}"
# Use the caller's HTML, else materialize a sample doc so BOTH tools read the
# exact same bytes (no risk of two divergent built-in copies).
HTML="${1:-}"
if [ -z "$HTML" ]; then
  HTML=/tmp/blitz_doc.html
  cat > "$HTML" <<'EOF'
<!DOCTYPE html><html><head><style>
body{margin:0;font-family:sans-serif;color:#fff;}
.wrap{display:flex;gap:16px;padding:24px;}
h1{font-size:40px;font-weight:700;margin:0 0 8px;}
p{font-size:18px;line-height:1.4;width:320px;}
.badge{font-size:14px;font-weight:700;color:#6cf;}
</style></head><body><div class="wrap"><div>
<h1>Blitz layout</h1>
<p>Real CSS flexbox and text wrapping, shaped by parley, emitted as positioned glyph runs for the MSDF atlas.</p>
<span class="badge">PARITY · MSDF · GPU</span>
</div></div></body></html>
EOF
fi

echo "[1/4] building text_blitz (native staticlib + wasm)"
( cd "$BLITZ" && cargo build --release >/dev/null 2>&1 \
              && cargo build --release --target wasm32-wasip1 >/dev/null 2>&1 )
LIB="$BLITZ/target/release/libtext_blitz.a"

echo "[2/4] building native blitz_dump (engine + FreeType + msdfgen + libtext_blitz.a)"
[ -d "$TP/freetype" ] || bash "$TP/fetch_deps.sh"
FTSRC=""; for s in base/ftbase base/ftinit base/ftsystem base/ftdebug base/ftbitmap base/ftmm sfnt/sfnt truetype/truetype psnames/psnames cff/cff psaux/psaux pshinter/pshinter; do FTSRC="$FTSRC $TP/freetype/src/$s.c"; done
MDSRC=""; for c in Contour DistanceMapping EdgeHolder MSDFErrorCorrection Projection Scanline Shape contour-combiners edge-coloring edge-segments edge-selectors equation-solver msdf-error-correction msdfgen rasterization render-sdf sdf-error-estimation shape-description; do MDSRC="$MDSRC $TP/msdfgen/core/$c.cpp"; done
UBOBJ=""; for s in linebreak linebreakdata linebreakdef unibreakbase unibreakdef eastasianwidthdef eastasianwidthdata; do
  clang -std=c11 -O2 -I"$TP/libunibreak/src" -c "$TP/libunibreak/src/$s.c" -o "/tmp/ub_$s.o"; UBOBJ="$UBOBJ /tmp/ub_$s.o"; done

# Rust staticlib on macOS pulls a few system frameworks/libs (resolver, etc.).
RUSTLIBS="-framework CoreFoundation -framework Security -framework SystemConfiguration -liconv -lobjc"

clang++ -std=c++17 -fno-exceptions -fno-rtti -O2 \
  -DFT2_BUILD_LIBRARY '-DFT_CONFIG_OPTIONS_H="ftoption_custom.h"' '-DFT_CONFIG_MODULES_H="ftmodule_custom.h"' \
  -I"$TP/freetype/include" -I"$TP/ft-config" -I"$TP/msdf-config" -I"$TP/msdfgen" -I"$TP/libunibreak/src" -I"$SRC" \
  $FTSRC $MDSRC $UBOBJ "$SRC/text_engine.cpp" "$SRC/tools/blitz_dump.cpp" \
  "$LIB" $RUSTLIBS -o /tmp/blitz_dump

echo "[3/4] native: HTML → Blitz → engine → PNG"
export TE_FONT="$FONT" TE_FALLBACK="$FALLBACK"
TE_PNG="$OUT/blitz_native.png" TE_RUNS=/tmp/blitz_native.runs /tmp/blitz_dump "$HTML" > /tmp/blitz_native.json
cat /tmp/blitz_native.json
echo "  PNG: $OUT/blitz_native.png"

echo "[4/4] wasm run parity (text_blitz.wasm) — runs must be byte-identical"
TE_FONT="$FONT" TE_FALLBACK="$FALLBACK" node run_blitz_wasm.mjs "$HTML" > /tmp/blitz_wasm.runs
if cmp -s /tmp/blitz_native.runs /tmp/blitz_wasm.runs; then
  echo "✅ BLITZ RUN PARITY: native lib == wasm lib (byte-identical pre-shaped runs)"
else
  echo "❌ run buffers differ:"; cmp -l /tmp/blitz_native.runs /tmp/blitz_wasm.runs | head; exit 1
fi
