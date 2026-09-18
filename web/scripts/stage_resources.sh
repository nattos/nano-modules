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
#
# In a dev tree the root IS the repo's build/, which is where the wasm already
# lands and where the plugin finds it by walking up from its own image — so this
# script only has to add app/ and, on macOS, ffgl/. The packaging step
# (electron-builder) ships the same layout under Contents/Resources/nano.
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

echo "staged resource root: $root"
du -sh "$root/app" "$root/wasm" 2>/dev/null || true
