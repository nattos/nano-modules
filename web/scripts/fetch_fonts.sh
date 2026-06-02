#!/bin/bash
# fetch_fonts.sh — fetch the web text engine's bundled, parity-guaranteed fonts.
#
# The text engine reproduces native "for realz" pixels only when BOTH sides
# shape identical sfnt bytes (see FONTS.md). To make that deterministic we ship
# a small bundled set of OFL (open-source, redistributable) Noto faces rather
# than relying on a host's OS fonts. The binaries are large and NOT committed —
# this script downloads them at a PINNED google/fonts commit and verifies their
# sha256, so every checkout (and the native host) gets byte-identical files.
#
#   web/public/fonts/default.ttf     primary font (face 0) — Noto Sans
#   web/public/fonts/noto-sans.ttf   family "Noto Sans"
#   web/public/fonts/noto-serif.ttf  family "Noto Serif"
#
# The DEFAULT_FONTS manifest in web/src/text-engine.ts maps the family names to
# these served URLs. Add faces (CJK / Arabic / Hebrew for full i18n) by
# extending FILES below + the manifest.
set -euo pipefail
cd "$(dirname "$0")/../public/fonts"

# Pinned google/fonts commit — change this (and the sha256s) to update fonts.
PIN=647e52b1cbc941916c322994994bbe2e3a08ca6e
BASE="https://cdn.jsdelivr.net/gh/google/fonts@${PIN}"

# out-file  url-path  sha256
FILES=(
  "noto-sans.ttf|ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf|bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d"
  "noto-serif.ttf|ofl/notoserif/NotoSerif%5Bwdth%2Cwght%5D.ttf|4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713"
)

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

for entry in "${FILES[@]}"; do
  IFS='|' read -r out path want <<<"$entry"
  if [ -f "$out" ] && [ "$(sha "$out")" = "$want" ]; then
    echo "  $out already present (sha ok)"; continue
  fi
  echo "  fetching $out"
  curl -fsSL --max-time 60 -o "$out" "$BASE/$path"
  got="$(sha "$out")"
  if [ "$got" != "$want" ]; then
    echo "  ERROR: $out sha256 mismatch (got $got, want $want)"; rm -f "$out"; exit 1
  fi
done

# Primary font (face 0) = Noto Sans, so a fresh checkout boots without an
# OS-derived default.ttf. Copy (don't symlink) so the served bytes are stable.
cp -f noto-sans.ttf default.ttf
echo "Done. Bundled fonts in web/public/fonts (default.ttf = Noto Sans, OFL)."
