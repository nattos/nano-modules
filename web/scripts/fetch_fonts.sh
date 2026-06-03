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
#   web/public/fonts/default.ttf       primary font (face 0) — Noto Sans
#   web/public/fonts/noto-sans.ttf     family "Noto Sans"
#   web/public/fonts/noto-serif.ttf    family "Noto Serif"
#   web/public/fonts/noto-sans-sc.ttf  CJK fallback — Simplified Chinese / Han
#   web/public/fonts/noto-sans-tc.ttf  CJK fallback — Traditional Chinese
#   web/public/fonts/noto-sans-jp.ttf  CJK fallback — Japanese (kana + kanji)
#   web/public/fonts/noto-sans-kr.ttf  CJK fallback — Korean (hangul)
#
# DEFAULT_FONTS / DEFAULT_FALLBACKS in web/src/text-engine.ts map these to served
# URLs. All CJK faces are glyf-flavored (not CFF) so they keep byte-exact parity.
# Han ideographs resolve to the first chain face (SC) regardless of language;
# per-run lang-based regional selection is a later refinement. Add faces (Arabic
# / Hebrew for full i18n) by extending FILES below + the manifest.
set -euo pipefail
cd "$(dirname "$0")/../public/fonts"

# Pinned google/fonts commit — change this (and the sha256s) to update fonts.
PIN=647e52b1cbc941916c322994994bbe2e3a08ca6e
BASE="https://cdn.jsdelivr.net/gh/google/fonts@${PIN}"        # fast CDN (≤50 MB)
RAW="https://github.com/google/fonts/raw/${PIN}"             # fallback (large files)

# out-file  url-path  sha256
FILES=(
  "noto-sans.ttf|ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf|bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d"
  "noto-serif.ttf|ofl/notoserif/NotoSerif%5Bwdth%2Cwght%5D.ttf|4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713"
  "noto-sans-sc.ttf|ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf|a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
  "noto-sans-tc.ttf|ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf|864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f"
  "noto-sans-jp.ttf|ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf|c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f"
  "noto-sans-kr.ttf|ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf|194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252"
  "noto-serif-sc.ttf|ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf|050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9"
  "noto-serif-tc.ttf|ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf|0077e18f57c6908f4a000969880940bdb0dad057c0e8d98b49dc364c3d1b09c6"
  "noto-serif-jp.ttf|ofl/notoserifjp/NotoSerifJP%5Bwght%5D.ttf|2fd527ba12b6a44ec30d796d633360da0aeba6c5d4af1304ce12bb4dc15a7dfc"
  "noto-serif-kr.ttf|ofl/notoserifkr/NotoSerifKR%5Bwght%5D.ttf|11f8d5de6f1b79195efba3828aaa2ec95c1178f5ae976fb23c8d53250a9938f3"
)

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

for entry in "${FILES[@]}"; do
  IFS='|' read -r out path want <<<"$entry"
  if [ -f "$out" ] && [ "$(sha "$out")" = "$want" ]; then
    echo "  $out already present (sha ok)"; continue
  fi
  echo "  fetching $out"
  # jsdelivr first; fall back to GitHub raw for files over its 50 MB CDN limit
  # (the large CJK serif faces) — verified by sha256 either way.
  curl -fsSL --max-time 120 -o "$out" "$BASE/$path" || true
  if [ "$(sha "$out" 2>/dev/null)" != "$want" ]; then
    curl -fsSL --max-time 300 -o "$out" "$RAW/$path"
  fi
  got="$(sha "$out")"
  if [ "$got" != "$want" ]; then
    echo "  ERROR: $out sha256 mismatch (got $got, want $want)"; rm -f "$out"; exit 1
  fi
done

# Primary font (face 0) = Noto Sans, so a fresh checkout boots without an
# OS-derived default.ttf. Copy (don't symlink) so the served bytes are stable.
cp -f noto-sans.ttf default.ttf
echo "Done. Bundled fonts in web/public/fonts (default.ttf = Noto Sans, OFL)."
