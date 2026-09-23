#!/bin/bash
# Build the desktop app's native addon(s) into the shared resource root:
#   <repo>/build/native/<platform>-<arch>/nano_shared_surface.node
# which electron/main.cjs loads, and the remote package ships (resources/nano/native).
#
# macOS only for now: the Windows side of nano_shared_surface (named D3D11
# NT handles) is not written yet, and the app falls back to the socket
# transport there. Needs clang and Node's headers (node_api.h) — Homebrew's
# node has them; NODE_INCLUDE overrides.
set -euo pipefail
cd "$(dirname "$0")"
repo="$(cd ../.. && pwd)"

if [ "$(uname)" != "Darwin" ]; then
  echo "native addon: skipped (only macOS is implemented)"
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
