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

echo "[2/3] building native parity_dump (FreeType + msdfgen + engine)"
TP="$ROOT/native/third_party"
[ -d "$TP/freetype" ] || bash "$TP/fetch_deps.sh"
FTSRC=""; for s in base/ftbase base/ftinit base/ftsystem base/ftdebug base/ftbitmap base/ftmm sfnt/sfnt truetype/truetype psnames/psnames cff/cff psaux/psaux pshinter/pshinter; do FTSRC="$FTSRC $TP/freetype/src/$s.c"; done
MDSRC=""; for c in Contour DistanceMapping EdgeHolder MSDFErrorCorrection Projection Scanline Shape contour-combiners edge-coloring edge-segments edge-selectors equation-solver msdf-error-correction msdfgen rasterization render-sdf sdf-error-estimation shape-description; do MDSRC="$MDSRC $TP/msdfgen/core/$c.cpp"; done
clang++ -std=c++17 -fno-exceptions -fno-rtti -O2 \
  -DFT2_BUILD_LIBRARY '-DFT_CONFIG_OPTIONS_H="ftoption_custom.h"' '-DFT_CONFIG_MODULES_H="ftmodule_custom.h"' \
  -I"$TP/freetype/include" -I"$TP/ft-config" -I"$TP/msdf-config" -I"$TP/msdfgen" -I"$SRC" \
  $FTSRC $MDSRC "$SRC/text_engine.cpp" "$SRC/tools/parity_dump.cpp" -o /tmp/te_parity_dump

DUMP_DIR="$ROOT/build/text-dumps"
mkdir -p "$DUMP_DIR"

# Specs to check (add tricky cases here as the engine grows).
# A distinct second face registered under family "Serif" for the multi-font
# case (both tools register the SAME file the SAME way → byte-identical faces).
export TE_FONT2="${TE_FONT2:-/System/Library/Fonts/Times.ttc}"
export TE_FAMILY2="${TE_FAMILY2:-Serif}"

# CJK fallback face — covers codepoints the Latin primary font lacks. Both tools
# register the SAME file via addFallbackFont → byte-identical fallback glyphs.
export TE_FALLBACK="${TE_FALLBACK:-/System/Library/Fonts/STHeiti Light.ttc}"

SPECS=(
  '{"text":"Hello\nWorld!","runs":[{"start":0,"len":12,"size_px":48}],"constraints":{"max_width_px":300}}'
  '{"text":"wrap me onto many lines please","constraints":{"max_width_px":160,"size_px":24}}'
  '{"text":"€ é ✓ 你好","size_px":32}'
  '{"text":"REDblue","runs":[{"start":0,"len":3,"size_px":120,"rgba":[1,0.2,0.2,1]},{"start":3,"len":4,"size_px":60,"rgba":[0.3,0.5,1,1]}]}'
  '{"text":"MonoSerif","runs":[{"start":0,"len":4,"size_px":72},{"start":4,"len":5,"size_px":72,"family":"Serif","rgba":[0.4,1,0.6,1]}]}'
  '{"text":"Hello 世界 你好","size_px":56}'
)

# Geometry/metrics/atlas are deterministic → compared byte-exact via digests.
# The composite is compared with a per-channel tolerance (bilinear float math
# differs a few LSB across toolchains — perceptual, not byte, parity).
echo "[3/3] comparing digests (exact) + composite (tolerant) + dumping PNGs"
fail=0
i=0
for spec in "${SPECS[@]}"; do
  i=$((i+1))
  TE_PNG="$DUMP_DIR/case${i}_native.png" TE_RAW=/tmp/te_native.bin /tmp/te_parity_dump "$spec" > /tmp/te_native.json
  TE_PNG="$DUMP_DIR/case${i}_wasm.png"   TE_RAW=/tmp/te_wasm.bin   node parity_dump.mjs "$spec" > /tmp/te_wasm.json
  ok=1
  node compare_digests.mjs /tmp/te_native.json /tmp/te_wasm.json || ok=0
  node -e '
    import("node:fs").then(fs=>{
      const a=fs.readFileSync("/tmp/te_native.bin"), b=fs.readFileSync("/tmp/te_wasm.bin"), TOL=4;
      if(a.length!==b.length){console.error("  composite size mismatch");process.exit(1);}
      let max=0,n=0; for(let k=0;k<a.length;k++){const d=Math.abs(a[k]-b[k]); if(d){n++; if(d>max)max=d;}}
      if(max>TOL){console.error(`  composite exceeds tol: maxChannelDiff=${max}`);process.exit(1);}
      process.stderr.write(`  composite Δ≤${max} (${n} bytes) `);
    });' || ok=0
  if [ "$ok" -eq 1 ]; then echo "✅ parity: $spec"; else echo "❌ MISMATCH: $spec"; fail=1; fi
done
echo "  PNGs in $DUMP_DIR"

[ "$fail" -eq 0 ] && echo "ALL PARITY CHECKS PASSED" || { echo "PARITY FAILURES"; exit 1; }
