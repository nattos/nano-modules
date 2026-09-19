#!/usr/bin/env bash
# package.sh — build nano_diag and everything it runs, and zip it into
# something you can send to a person with a Windows machine.
#
#   native/tools/nano_diag/package.sh [outdir]
#
# The result is a single folder with no install step: unzip, double-click
# run-diagnostics.bat (or nano_diag.exe), wait, send back the .log. The layout
# is deliberately the one platform/resource_root.h looks for -- a
# nano-resources.json marker beside wasm/ and fonts/ -- so nothing has to be
# configured and no environment variable has to be set by hand.
#
# Requires the cross toolchain (cmake/toolchain-win-zig.cmake, i.e. zig) and a
# macOS `build/` tree carrying the wasm bundles and fonts.

set -euo pipefail

NATIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
BUILD="$NATIVE/build-win"
ROOT="$REPO/build"                 # the shared resource root on this machine
STAMP="$(date +%Y%m%d)"
OUT="${1:-$REPO/dist}"
STAGE="$OUT/nano-diag-$STAMP"

# The suites worth carrying to real hardware. Everything here either asserts
# PIXELS (where a real AMD/NVIDIA/Intel driver can legitimately disagree with
# the macOS goldens in a way wined3d-over-Metal never will) or exercises a
# subsystem CrossOver fakes. The platform-neutral suites -- json, state,
# protocol, the wire vocabulary -- prove nothing new on a different GPU and are
# left behind to keep the download sane.
SUITES=(
  test_texture_copy_format     # the BGRA<->RGBA gate; if it is red, nothing below means anything
  test_gpu_conformance         # the backend's own contract, cheaply
  test_barrel_render           # the plugin's ABI, minus GL
  test_barrel_isolation        # per-instance executor separation
  test_sketch_output_format    # fused vs unfused intermediates
  test_effect_render           # 53 cases of pixel goldens -- the broadest coverage there is
  test_comp_render             # compositions, both backends' shared scenarios
  test_executor_wasm           # executor.wasm under WAMR, pixel-identical to native
  test_plane_shear             # }
  test_tri_shear               # } persistent storage buffers across frames --
  test_recompose               # } the open Metal bug a fresh driver may settle
  test_envelope_warp           # }
  test_effect_driver           # per-effect drive-through
  test_text_fonts              # DirectWrite: the known gap, on a real font stack
  test_text_precise
)

echo "==> configuring $BUILD"
cmake -B "$BUILD" -S "$NATIVE" \
      -DCMAKE_TOOLCHAIN_FILE="$NATIVE/cmake/toolchain-win-zig.cmake" \
      -DCMAKE_BUILD_TYPE=Release \
      -DNANO_BUILD_FFGL=ON >/dev/null

echo "==> building"
cmake --build "$BUILD" --target nano_diag NanoBarrel bridge_server "${SUITES[@]}" -j"$(sysctl -n hw.ncpu)"

echo "==> staging $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/wasm" "$STAGE/fonts"

cp "$BUILD/nano_diag.exe" "$STAGE/"
cp "$BUILD/NanoBarrel.dll" "$STAGE/"
cp "$BUILD/libbridge_server.dll" "$STAGE/"
for s in "${SUITES[@]}"; do cp "$BUILD/$s.exe" "$STAGE/"; done

# The payload, in the shape resource_root.h recognises. The per-arch .aot
# sidecars stay behind: they are per-ABI as well as per-arch, and the Windows
# build loads the portable .wasm.
cp "$NATIVE/tools/nano-resources.json" "$STAGE/nano-resources.json"
cp "$ROOT"/wasm/*.wasm "$STAGE/wasm/"
cp "$ROOT"/fonts/* "$STAGE/fonts/" 2>/dev/null || true

if [ ! -f "$STAGE/wasm/core.wasm" ]; then
  echo "!! no core.wasm under $ROOT/wasm -- run native/wasm_modules/build_all.sh first" >&2
  exit 1
fi

# Debug info is a small fraction of these binaries (they are large because they
# statically link WAMR, Catch2 and the engine), but it is free to drop.
STRIP=""
for c in llvm-strip /opt/homebrew/opt/llvm/bin/llvm-strip x86_64-w64-mingw32-strip; do
  if command -v "$c" >/dev/null 2>&1; then STRIP="$c"; break; fi
done
if [ -n "$STRIP" ]; then
  echo "==> stripping with $STRIP"
  "$STRIP" --strip-all "$STAGE"/*.exe "$STAGE"/*.dll 2>/dev/null || true
fi

cat > "$STAGE/run-diagnostics.bat" <<'BAT'
@echo off
rem Double-click this. It runs for a few minutes and writes a .log file in
rem this folder -- send that file back. Nothing is installed and nothing
rem outside this folder is touched.
cd /d "%~dp0"
nano_diag.exe
BAT

cat > "$STAGE/READ ME FIRST.txt" <<'TXT'
Nano barrel -- Windows diagnostics
==================================

What to do
----------
1. Unzip this whole folder somewhere ordinary (Desktop or Downloads is fine).
   It has to stay together -- the tool reads the files beside it.
2. Double-click  run-diagnostics.bat
3. Wait. It takes a few minutes and prints as it goes.
4. When it finishes it names a file called  nano-diag-<date>-<time>.log
   in this folder. Send that file back. That is the whole job.

Things you might see, none of which are a problem
-------------------------------------------------
* Windows may ask whether to allow network access. Either answer is fine --
  the engine opens a local port for its editor and this tool does not need
  the network at all.
* SmartScreen may say the publisher is unknown, because this is an unsigned
  one-off build. "More info" then "Run anyway", or just delete the folder if
  you would rather not.
* Some checks may say FAIL. That is what the log is for. A failure here is a
  result, not a mistake by you.

What it actually does
---------------------
It reports what graphics hardware and driver the machine has, then runs the
renderer: it opens an OpenGL context and a Direct3D 11 device, shares a
texture between them, renders a frame through the real plugin, and runs the
pixel-comparison test suites. Everything happens in this folder. It installs
nothing, changes no settings, and does not touch Resolume.
TXT

echo "==> zipping"
ZIP="$OUT/nano-diag-$STAMP.zip"
rm -f "$ZIP"
( cd "$OUT" && zip -qr "$(basename "$ZIP")" "$(basename "$STAGE")" )

echo
echo "  folder: $STAGE"
echo "  zip:    $ZIP  ($(du -h "$ZIP" | cut -f1))"
