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
# SERVED (web/public/fonts/, shipped to the browser):
#   default.ttf       primary font (face 0) — Noto Sans
#   noto-sans.ttf     family "Noto Sans"
#   noto-serif.ttf    family "Noto Serif"
#
# NOT served (web/test-fonts/, parity harness only) — the 4 Noto Sans + 4 Noto
# Serif CJK faces (~123 MB). The web app no longer ships these; it resolves the
# OS's CJK faces at runtime via Local Font Access (web/src/font-access.ts), like
# the native FFGL host pulls system CJK via Core Text. They're still fetched here
# so the native parity harness can feed identical bytes to both engines. All CJK
# faces are glyf-flavored (not CFF) so they keep byte-exact parity in that test.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVED="$HERE/../public/fonts"     # shipped to the browser (Vite copies public/ → dist)
TESTF="$HERE/../test-fonts"        # NOT served — CJK faces for the native parity harness
mkdir -p "$SERVED" "$TESTF"

# Pinned google/fonts commit — change this (and the sha256s) to update fonts.
PIN=647e52b1cbc941916c322994994bbe2e3a08ca6e
BASE="https://cdn.jsdelivr.net/gh/google/fonts@${PIN}"        # fast CDN (≤50 MB)
RAW="https://github.com/google/fonts/raw/${PIN}"             # fallback (large files)

# dest-dir  out-file  url-path  sha256
#
# SERVED is the small Latin set the web app ships. The CJK faces (~123 MB) are
# NO LONGER served — the app resolves OS CJK via Local Font Access at runtime
# (see web/src/font-access.ts). We still fetch them into TESTF so the native
# parity harness (native/wasm_modules/text_engine/*.sh) can feed identical bytes
# to both engines and prove byte-parity.
FILES=(
  "$SERVED|noto-sans.ttf|ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf|bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d"
  "$SERVED|noto-serif.ttf|ofl/notoserif/NotoSerif%5Bwdth%2Cwght%5D.ttf|4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713"
  "$TESTF|noto-sans-sc.ttf|ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf|a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
  "$TESTF|noto-sans-tc.ttf|ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf|864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f"
  "$TESTF|noto-sans-jp.ttf|ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf|c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f"
  "$TESTF|noto-sans-kr.ttf|ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf|194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252"
  "$TESTF|noto-serif-sc.ttf|ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf|050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9"
  "$TESTF|noto-serif-tc.ttf|ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf|0077e18f57c6908f4a000969880940bdb0dad057c0e8d98b49dc364c3d1b09c6"
  "$TESTF|noto-serif-jp.ttf|ofl/notoserifjp/NotoSerifJP%5Bwght%5D.ttf|2fd527ba12b6a44ec30d796d633360da0aeba6c5d4af1304ce12bb4dc15a7dfc"
  "$TESTF|noto-serif-kr.ttf|ofl/notoserifkr/NotoSerifKR%5Bwght%5D.ttf|11f8d5de6f1b79195efba3828aaa2ec95c1178f5ae976fb23c8d53250a9938f3"
)

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# Tidy up: drop any CJK left in the served dir by an older fetch (they used to
# live there and would otherwise still ship in dist).
rm -f "$SERVED"/noto-sans-??.ttf "$SERVED"/noto-serif-??.ttf

for entry in "${FILES[@]}"; do
  IFS='|' read -r dir out path want <<<"$entry"
  dst="$dir/$out"
  if [ -f "$dst" ] && [ "$(sha "$dst")" = "$want" ]; then
    echo "  $out already present (sha ok)"; continue
  fi
  echo "  fetching $out → ${dir##*/}"
  # jsdelivr first; fall back to GitHub raw for files over its 50 MB CDN limit
  # (the large CJK serif faces) — verified by sha256 either way.
  curl -fsSL --max-time 120 -o "$dst" "$BASE/$path" || true
  if [ "$(sha "$dst" 2>/dev/null)" != "$want" ]; then
    curl -fsSL --max-time 300 -o "$dst" "$RAW/$path"
  fi
  got="$(sha "$dst")"
  if [ "$got" != "$want" ]; then
    echo "  ERROR: $out sha256 mismatch (got $got, want $want)"; rm -f "$dst"; exit 1
  fi
done

# Primary font (face 0) = Noto Sans, so a fresh checkout boots without an
# OS-derived default.ttf. Copy (don't symlink) so the served bytes are stable.
cp -f "$SERVED/noto-sans.ttf" "$SERVED/default.ttf"
echo "Done. Served set in web/public/fonts (default.ttf = Noto Sans, OFL);"
echo "      CJK parity-test faces in web/test-fonts (not served)."
