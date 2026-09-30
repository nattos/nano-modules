#!/bin/bash
# Build the desktop app's native addon(s) into the shared resource root:
#   <repo>/build/native/<platform>-<arch>/nano_shared_surface.node
# which electron/main.cjs loads, and the packages ship (resources/nano/native).
#
# Built on macOS, for both platforms: darwin-<arch> with clang, and win32-x64
# cross-compiled with zig (the same toolchain as native/build-win) when zig is
# on PATH — the Windows package is built from a Mac too. Needs Node's headers
# (node_api.h) — Homebrew's node has them; NODE_INCLUDE overrides.
set -euo pipefail
cd "$(dirname "$0")"
repo="$(cd ../.. && pwd)"

if [ "$(uname)" != "Darwin" ]; then
  echo "native addon: skipped (built from macOS)"
  exit 0
fi

inc="${NODE_INCLUDE:-}"
if [ -z "$inc" ]; then
  node_bin="$(command -v node || true)"
  [ -n "$node_bin" ] && inc="$(cd "$(dirname "$(readlink -f "$node_bin")")/../include/node" 2>/dev/null && pwd || true)"
fi
if [ -z "$inc" ] || [ ! -f "$inc/node_api.h" ]; then
  echo "error: node_api.h not found — set NODE_INCLUDE to Node's include/node" >&2
  exit 1
fi

arch="$(uname -m)"; [ "$arch" = "x86_64" ] && arch=x64
out="$repo/build/native/darwin-$arch"
mkdir -p "$out"
clang -O2 -shared -undefined dynamic_lookup -I"$inc" \
  -framework IOSurface -framework CoreFoundation \
  nano_shared_surface/nano_shared_surface.c -o "$out/nano_shared_surface.node"
echo "built $out/nano_shared_surface.node"

# Windows: the addon resolves napi_* from the host executable at run time (see
# the .c), so there is no node.lib to link; the name/open scheme is the
# producer's own header.
if command -v zig >/dev/null 2>&1; then
  wout="$repo/build/native/win32-x64"
  mkdir -p "$wout"
  zig cc -target x86_64-windows-gnu -O2 -shared -I"$inc" -I"$repo/native/src" \
    nano_shared_surface/nano_shared_surface.c -o "$wout/nano_shared_surface.node"
  rm -f "$wout"/nano_shared_surface.lib "$wout"/nano_shared_surface.pdb
  echo "built $wout/nano_shared_surface.node"
else
  echo "note: zig not found — no Windows addon (a Windows package keeps the socket transport)"
fi
