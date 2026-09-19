#!/bin/bash
# Cross-compile the Windows GPU probes from macOS. Needs `brew install zig` —
# zig ships the mingw-w64 headers, so d3d11.h/d3d12.h come with it and there is
# no Windows SDK or MSVC involved.
set -euo pipefail
cd "$(dirname "$0")"
out="${1:-.}"
for src in d3d11_test chromium_reqs d3d12_test; do
  zig c++ -target x86_64-windows-gnu -O2 -fno-exceptions -fno-rtti \
    -o "$out/$src.exe" "$src.cpp"
  echo "built $out/$src.exe"
done
