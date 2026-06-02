#!/bin/bash
# fetch_deps.sh — fetch the pinned text-engine C/C++ dependencies.
#
# The full FreeType (~12 MB) and msdfgen source trees are NOT committed; this
# script clones the exact pinned versions the text engine builds against. The
# committed config (ft-config/, msdf-config/, wasm-shim/) + probes are the
# stable, hand-authored glue and ARE in the repo. See PHASE1_DEPS.md.
set -euo pipefail
cd "$(dirname "$0")"

clone() { # repo tag dir
  if [ -d "$3" ]; then echo "  $3 already present"; return; fi
  git clone --depth 1 --branch "$2" "$1" "$3"
  rm -rf "$3/.git"
}

echo "Fetching pinned text-engine deps:"
clone https://github.com/freetype/freetype.git VER-2-13-3 freetype
clone https://github.com/Chlumsky/msdfgen.git    v1.12.1     msdfgen
echo "Done. freetype=$(du -sh freetype|cut -f1) msdfgen=$(du -sh msdfgen|cut -f1)"
