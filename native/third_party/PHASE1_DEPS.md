# Phase 1 dependency de-risk — FreeType + msdfgen (FINDINGS)

Goal: prove FreeType + msdfgen vendor cleanly and produce real MSDF glyphs under
**both** native clang and `wasm32-wasip1 -fno-exceptions -fno-rtti`, with
byte-identical output (the prerequisite for web↔native pixel parity in Phase 1).

**Result: ✅ fully de-risked.** Monaco `A` → 48×48 MSDF is **byte-identical**
native vs wasm (9216/9216 bytes). `text_probe.wasm` (FreeType + msdfgen + probe)
= ~382 KB.

## Pinned versions
- FreeType `VER-2-13-3`, msdfgen `v1.12.1` — fetched by `fetch_deps.sh`
  (source trees gitignored; not committed).

## FreeType: minimal config
- **Modules** (`ft-config/ftmodule_custom.h`): TrueType + sfnt + psnames only.
  No autofitter, CFF/Type1, raster/smooth/sdf/svg renderers — we load outlines
  with `FT_LOAD_NO_SCALE | FT_LOAD_NO_HINTING` and decompose them ourselves, so
  no rasterizer is needed. (CFF/OTF support = add cff+psaux+pshinter later.)
- **Options** (`ft-config/ftoption_custom.h`): stock ftoption with
  `USE_ZLIB` and `MAC_FONTS` disabled (no internal gzip, no mac resource forks).
  PNG/HarfBuzz/Brotli are already off by default.
- **Compile set** (9 TUs): `base/{ftbase,ftinit,ftsystem,ftdebug,ftbitmap,ftmm}`,
  `sfnt/sfnt`, `truetype/truetype`, `psnames/psnames`.
  (`ftbitmap`+`ftmm` are required — sfnt/truetype reference `FT_Bitmap_*` and
  `FT_Set_Named_Instance`.)
- **Flags**: `-DFT2_BUILD_LIBRARY -DFT_CONFIG_OPTIONS_H="ftoption_custom.h"
  -DFT_CONFIG_MODULES_H="ftmodule_custom.h" -Ifreetype/include -Ift-config`.

### The one wasm gotcha: `<setjmp.h>`
wasi-libc's `<setjmp.h>` hard-`#error`s without the (non-standard) wasm
exception-handling feature. FreeType's `ftstdlib.h` includes it unconditionally,
but **only the smooth rasterizer actually calls setjmp/longjmp** — and we don't
compile it. Fix: a 1-type shim (`wasm-shim/setjmp.h`) on the include path; the
symbols stay undefined-but-unreferenced (`--allow-undefined` covers them; node
shows them as unused `env` imports). No `-mllvm -wasm-enable-sjlj` needed.

## msdfgen: core only
- **No exceptions**: `grep -rn 'throw|try|catch' core` → **0 hits**. Compiles
  clean with `-fno-exceptions -fno-rtti`.
- **Compile set** (18 core `.cpp`): everything in `core/` except the I/O files
  (`save-*`, `export-svg`) and all of `ext/` (Skia/FreeType-import/png). We build
  the `msdfgen::Shape` ourselves from FreeType outlines.
- **Config**: hand-written `msdf-config/msdfgen/msdfgen-config.h` (defines
  `MSDFGEN_PUBLIC`, version) replaces the CMake-generated one. `-Imsdf-config -Imsdfgen`.

## Pipeline (see `ftmsdf_core.h`)
`FT_New_Memory_Face` (font bytes, sandbox-safe) → `FT_Load_Glyph(NO_SCALE)` →
`FT_Outline_Decompose` building `msdfgen::Shape` (move/line/conic/cubic) →
`shape.normalize()` → fit to tile (bounds + range padding) →
`edgeColoringSimple` → `generateMSDF`. Verified on Monaco/Arial (`A`, `g`).

## Probes (committed, throwaway-grade)
- `ftmsdf_core.h` — shared pipeline (native + wasm use identical code).
- `ftmsdf_probe.cpp` — native CLI → MSDF + coverage PNGs.
- `ftmsdf_wasm.cpp` — wasm export `probe_glyph`; run in node to verify parity.

## Implications for Phase 1 proper
- Engine size with these deps ≈ 350–450 KB wasm (matches the estimate).
- The trimmed FreeType + msdfgen-core go straight into `text_engine.cpp`'s
  `msdf_gen.cpp`, replacing the stub atlas. The setjmp shim + config dirs move
  into the engine's build (`text_engine/build.sh`) and the native `text_engine`
  CMake lib.
- Determinism holds across native/wasm → the existing `parity_check.sh` will keep
  asserting pixel parity once real glyphs replace the stub boxes.
