#!/bin/bash
# stage_resources.sh — assemble the SHARED RESOURCE ROOT that both halves read.
#
# One directory serves the Electron renderer and the native NanoBarrel plugin:
#
#   <root>/nano-resources.json   marker; both sides look for it
#   <root>/app/                  the built web app (web/dist)
#   <root>/wasm/*.wasm           effect bundles, web + native
#   <root>/wasm/*-<arch>.aot     per-arch sidecars, native only
#   <root>/fonts/default.ttf     the text service's primary face, native side
#   <root>/ffgl/                 NanoBarrel.bundle + libbridge_server.dylib
#   <root>/ffgl-win/             NanoBarrel.dll + libbridge_server.dll
#
# In a dev tree the root IS the repo's build/, which is where the wasm already
# lands and where the plugin finds it by walking up from its own image — so this
# script only has to add app/ and the plugin directories. The packaging step
# (electron-builder) ships the same layout under Contents/Resources/nano, and
# maps ONE of the two plugin directories to nano/ffgl per target.
#
# ffgl-win/ is staged on macOS too, because the Windows package cross-builds
# from here: the Windows barrel is a cross-compiled artifact of this same tree
# (native/build-win), not something a Windows machine produces.
#
# Run after `npm run build` (from web/). Idempotent.
#
#   SKIP_FFGL=1   don't stage the plugin (web-only checkout, or CI)
set -euo pipefail
cd "$(dirname "$0")/.."          # web/
web="$PWD"
repo="$(cd .. && pwd)"
root="$repo/build"

if [ ! -d "$web/dist" ]; then
  echo "error: $web/dist not found — run 'npm run build' first" >&2
  exit 1
fi

mkdir -p "$root"

# The marker. Normally written by the native CMake deploy, but a web-only
# checkout never configures CMake and still needs a valid root.
if [ ! -f "$root/nano-resources.json" ]; then
  if [ -f "$repo/native/tools/nano-resources.json" ]; then
    cp "$repo/native/tools/nano-resources.json" "$root/nano-resources.json"
  else
    printf '{\n  "kind": "nano-resources",\n  "version": 1\n}\n' > "$root/nano-resources.json"
  fi
fi

# The app. Replaced wholesale rather than merged: a stale hashed chunk left
# behind from a previous build is invisible until something still references it.
rm -rf "$root/app"
mkdir -p "$root/app"
cp -R "$web/dist/." "$root/app/"

# Fonts for the native text service. The web app carries its own copy inside
# app/ (Vite copies public/), so this is only the primary face the C++ side
# installs; see effect_runtime::textInstallDefaultFonts.
if [ -f "$web/public/fonts/default.ttf" ]; then
  mkdir -p "$root/fonts"
  cp -f "$web/public/fonts/default.ttf" "$root/fonts/default.ttf"
else
  echo "warning: web/public/fonts/default.ttf missing — run web/scripts/fetch_fonts.sh" >&2
fi

if [ ! -f "$root/wasm/core.wasm" ]; then
  echo "error: $root/wasm/core.wasm missing — run native/wasm_modules/build_all.sh" >&2
  exit 1
fi

# The FFGL plugin, staged so Resolume can be pointed at it and so the plugin
# resolves THIS root by walking up from itself. libbridge_server.dylib must be
# the bundle's DIRECT SIBLING: dlopen shares one image only for the same path,
# and two copies means two WsServers fighting over :8081.
if [ "${SKIP_FFGL:-0}" != "1" ] && [ "$(uname -s)" = "Darwin" ]; then
  nb="$repo/native/build/NanoBarrel.bundle"
  dylib="$repo/native/build/libbridge_server.dylib"
  if [ -d "$nb" ] && [ -f "$dylib" ]; then
    mkdir -p "$root/ffgl"
    rm -rf "$root/ffgl/NanoBarrel.bundle"
    cp -R "$nb" "$root/ffgl/NanoBarrel.bundle"
    cp -f "$dylib" "$root/ffgl/libbridge_server.dylib"
    # Copying a signed bundle preserves its signature, but the dylib's path
    # changed, so re-seal both. Ad-hoc unless told otherwise.
    id="${NANOBARREL_CODESIGN_IDENTITY:--}"
    codesign --force --sign "$id" "$root/ffgl/libbridge_server.dylib" 2>/dev/null || true
    bash "$repo/native/tools/codesign_bundle.sh" "$id" "$root/ffgl/NanoBarrel.bundle" >/dev/null 2>&1 || true
  else
    echo "note: no built NanoBarrel.bundle — staging the app without the plugin"
  fi
fi

# The WINDOWS plugin, into its own directory. Kept apart from ffgl/ rather than
# merged: the mac package copies ffgl/ wholesale, and a stray pair of .dll files
# inside a signed .app is 30 MB of something the notary has to be told about.
# electron-builder's win block maps this to nano/ffgl, so the layout the plugin
# walks up into is identical on both platforms.
#
# No .aot sidecars go with it: the Windows build sets NANO_WASM_AOT=OFF because
# a sidecar is per-ABI as well as per-arch, so the barrel loads the portable
# .wasm there. Nothing to stage, nothing to keep in step.
if [ "${SKIP_FFGL:-0}" != "1" ]; then
  wb="$repo/native/build-win"
  if [ -f "$wb/NanoBarrel.dll" ] && [ -f "$wb/libbridge_server.dll" ]; then
    mkdir -p "$root/ffgl-win"
    cp -f "$wb/NanoBarrel.dll" "$root/ffgl-win/NanoBarrel.dll"
    cp -f "$wb/libbridge_server.dll" "$root/ffgl-win/libbridge_server.dll"
    # Same strip the standalone diag package does — these carry full DWARF
    # otherwise, and libbridge_server.dll alone is 29 MB of it.
    strip_bin="$(command -v llvm-strip || echo /opt/homebrew/opt/llvm/bin/llvm-strip)"
    if [ -x "$strip_bin" ]; then
      "$strip_bin" --strip-all "$root/ffgl-win/NanoBarrel.dll" 2>/dev/null || true
      "$strip_bin" --strip-all "$root/ffgl-win/libbridge_server.dll" 2>/dev/null || true
    fi
  else
    # Not an error on a mac-only build, but `npm run package:remote:win` needs it.
    echo "note: no built native/build-win/NanoBarrel.dll — a Windows package"
    echo "      from this root would carry no plugin (Live mode offline only)"
  fi
fi

# The desktop app's native addon (shared preview surfaces). macOS only for
# now; the script is a no-op elsewhere, and the app falls back without it.
if [ "${SKIP_NATIVE_ADDON:-0}" != "1" ]; then
  bash "$web/native/build.sh" || echo "note: native addon not built — previews will use the socket transport"
fi

echo "staged resource root: $root"
du -sh "$root/app" "$root/wasm" 2>/dev/null || true
