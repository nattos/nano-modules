#!/bin/bash
# metal_parity.sh — native GPU (Metal) parity for the Blitz complex-layout mode.
#
#   HTML/CSS → text_blitz (Rust) → pre-shaped runs → text_engine (FreeType+msdfgen)
#            → GlyphQuads + BoxQuads + MSDF atlas
#            → CPU golden  Engine::rasterize        (blitz_dump)   → reference RGBA
#            → Metal GPU   MSL quad compositor       (blitz_metal) → GPU RGBA
#
# Asserts the Metal composite matches the CPU golden (Engine::rasterize) within a
# perceptual envelope. The difference is hardware-sampler precision: the GPU
# computes bilinear weights for the MSDF atlas at reduced sub-texel precision
# (~8-bit fractional steps), and the steep screenPxRange MSDF ramp amplifies that
# to a handful of single-shade pixels right on glyph/border edges (observed: maxΔ
# ~32, but <0.2% of bytes, mean Δ <4). This is the SAME class of difference the
# real WebGPU app path has — both GPU backends use hardware linear filtering, so
# they match each other; both differ from the full-float CPU golden only at edge
# texels. The CPU golden is the available headless proxy for "do the GPU pixels
# look right"; this proves the native Metal compositor reproduces them.
#
# The gate is robust on FRACTION + MEAN, not max: a real layout/positioning bug
# shifts MANY pixels (fraction + mean spike), whereas edge-bilinear noise is
# high-max / tiny-fraction / low-mean. Tunable via TE_MAXPCT / TE_MAXMEAN.
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
# Robust gates (see header). FRACTION is the primary discriminator: a layout /
# positioning regression shifts whole glyphs and lights up a halo everywhere
# (fraction → several %), whereas hardware-bilinear noise is a 1px rind on glyph
# /border edges (fraction ~0.1%, content-independent). Mean-over-differing-bytes
# is only a coarse severity backstop — it's color-magnitude sensitive (saturated
# glyphs inflate per-edge-byte deltas without any extra pixels differing), so its
# bound is generous on purpose.
MAXPCT="${TE_MAXPCT:-1.0}"      # PRIMARY: fail if >this % of bytes differ at all
MAXMEAN="${TE_MAXMEAN:-16.0}"   # backstop: mean Δ over differing bytes (color-sensitive)
HARDMAX="${TE_HARDMAX:-64}"     # gross-corruption floor on the single worst byte

# Caller's HTML, else materialize the shared sample doc (same bytes both tools).
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
.card{background:#234;border-radius:14px;border:3px solid #6cf;padding:16px;overflow:hidden;}
</style></head><body><div class="wrap"><div class="card">
<h1>Blitz layout</h1>
<p>Real CSS flexbox and text wrapping, shaped by parley, emitted as positioned glyph runs for the MSDF atlas.</p>
<span class="badge">PARITY · MSDF · GPU</span>
</div></div></body></html>
EOF
fi

echo "[1/4] building text_blitz (native staticlib)"
( cd "$BLITZ" && cargo build --release >/dev/null 2>&1 )
LIB="$BLITZ/target/release/libtext_blitz.a"

# Shared compile inputs (same set blitz_parity.sh uses).
[ -d "$TP/freetype" ] || bash "$TP/fetch_deps.sh"
FTSRC=""; for s in base/ftbase base/ftinit base/ftsystem base/ftdebug base/ftbitmap base/ftmm sfnt/sfnt truetype/truetype psnames/psnames cff/cff psaux/psaux pshinter/pshinter; do FTSRC="$FTSRC $TP/freetype/src/$s.c"; done
MDSRC=""; for c in Contour DistanceMapping EdgeHolder MSDFErrorCorrection Projection Scanline Shape contour-combiners edge-coloring edge-segments edge-selectors equation-solver msdf-error-correction msdfgen rasterization render-sdf sdf-error-estimation shape-description; do MDSRC="$MDSRC $TP/msdfgen/core/$c.cpp"; done
UBOBJ=""; for s in linebreak linebreakdata linebreakdef unibreakbase unibreakdef eastasianwidthdef eastasianwidthdata; do
  clang -std=c11 -O2 -I"$TP/libunibreak/src" -c "$TP/libunibreak/src/$s.c" -o "/tmp/ub_$s.o"; UBOBJ="$UBOBJ /tmp/ub_$s.o"; done

RUSTLIBS="-framework CoreFoundation -framework Security -framework SystemConfiguration -liconv -lobjc"
INCS="-I$TP/freetype/include -I$TP/ft-config -I$TP/msdf-config -I$TP/msdfgen -I$TP/libunibreak/src -I$SRC"

echo "[2/4] building CPU golden (blitz_dump) + Metal GPU (blitz_metal)"
# CPU golden tool.
clang++ -std=c++17 -fno-exceptions -fno-rtti -O2 \
  -DFT2_BUILD_LIBRARY '-DFT_CONFIG_OPTIONS_H="ftoption_custom.h"' '-DFT_CONFIG_MODULES_H="ftmodule_custom.h"' \
  $INCS $FTSRC $MDSRC $UBOBJ "$SRC/text_engine.cpp" "$SRC/tools/blitz_dump.cpp" \
  "$LIB" $RUSTLIBS -o /tmp/blitz_dump

# Metal tool: compile the ObjC++ harness under ARC on its own, then link with the
# engine + deps (which don't use exceptions/ObjC).
clang++ -ObjC++ -fobjc-arc -std=c++17 -O2 -I"$SRC" -c "$SRC/tools/blitz_metal.mm" -o /tmp/blitz_metal.o
clang++ -std=c++17 -fno-exceptions -fno-rtti -O2 \
  -DFT2_BUILD_LIBRARY '-DFT_CONFIG_OPTIONS_H="ftoption_custom.h"' '-DFT_CONFIG_MODULES_H="ftmodule_custom.h"' \
  $INCS $FTSRC $MDSRC $UBOBJ "$SRC/text_engine.cpp" /tmp/blitz_metal.o \
  "$LIB" $RUSTLIBS -framework Metal -framework Foundation -o /tmp/blitz_metal

echo "[3/4] CPU golden → reference RGBA"
export TE_FONT="$FONT" TE_FALLBACK="$FALLBACK"
TE_PNG="$OUT/blitz_cpu.png" TE_RAW=/tmp/blitz_cpu.raw /tmp/blitz_dump "$HTML" | sed 's/^/  cpu:   /'

echo "[4/4] Metal GPU → composite, compare to golden (maxpct=$MAXPCT mean=$MAXMEAN)"
TE_PNG="$OUT/blitz_metal.png" TE_RAW=/tmp/blitz_metal.raw /tmp/blitz_metal "$HTML" | sed 's/^/  metal: /'
echo "  CPU PNG:   $OUT/blitz_cpu.png"
echo "  Metal PNG: $OUT/blitz_metal.png"

MAXPCT="$MAXPCT" MAXMEAN="$MAXMEAN" HARDMAX="$HARDMAX" node -e '
  const fs=require("node:fs");
  const a=fs.readFileSync("/tmp/blitz_cpu.raw"), b=fs.readFileSync("/tmp/blitz_metal.raw");
  const MAXPCT=Number(process.env.MAXPCT), MAXMEAN=Number(process.env.MAXMEAN), HARDMAX=Number(process.env.HARDMAX);
  if(a.length!==b.length){console.error(`  ❌ size mismatch ${a.length} vs ${b.length}`);process.exit(1);}
  let max=0,nz=0,sum=0; const ds=[];
  for(let k=0;k<a.length;k++){const d=Math.abs(a[k]-b[k]); if(d){nz++;sum+=d; ds.push(d); if(d>max)max=d;}}
  const pct=100*nz/a.length, mean=nz?sum/nz:0;
  ds.sort((p,q)=>p-q); const p999 = ds.length? ds[Math.min(ds.length-1, Math.floor(ds.length*0.999))] : 0;
  const stat=`maxΔ=${max} p99.9=${p999} bytes=${nz} (${pct.toFixed(3)}%) meanΔ=${mean.toFixed(2)}`;
  const fails=[];
  if(pct>MAXPCT)   fails.push(`diff fraction ${pct.toFixed(3)}% > ${MAXPCT}% (suggests a layout/positioning regression, not bilinear noise)`);
  if(mean>MAXMEAN) fails.push(`mean Δ ${mean.toFixed(2)} > ${MAXMEAN}`);
  if(max>HARDMAX)  fails.push(`worst byte ${max} > ${HARDMAX} (gross corruption)`);
  if(fails.length){ console.error(`  ❌ NATIVE METAL PARITY FAILED — ${stat}`); for(const f of fails) console.error(`     · ${f}`); process.exit(1); }
  console.log(`  ✅ NATIVE METAL PIXEL PARITY: Metal ≈ CPU golden — ${stat}`);
  console.log(`     (high max on a few edge texels = hardware-sampler bilinear precision, expected & matches the WebGPU path)`);
'
