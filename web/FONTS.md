# Text engine fonts & the parity rule

The text engine reproduces the native FFGL ("for realz") pixels in the browser
simulator by compiling **one** shared CPU engine (FreeType + msdfgen) both ways
and feeding it **identical font bytes** on both sides. Pixel parity therefore
holds exactly when, and only when, the same sfnt bytes exist natively and on the
web for the family a run names.

## How fonts are resolved

A layout spec's run carries an optional `"family"`. The host font provider maps
that name → sfnt bytes:

- **Native host** (FFGL, path #3): Core Text enumerates OS fonts and yields the
  sfnt bytes; shaping/rasterization is still FreeType + msdfgen (Core Text is a
  byte source only). Bundled faces below are also read from disk.
- **Web host** (`web/src/text-engine.ts`): the bundled set (below) is registered
  at init; arbitrary OS fonts are resolved on demand via the Local Font Access
  API (`queryLocalFonts`, Chromium, behind a one-time permission prompt). A run
  whose family is not (yet) registered falls back to the **primary font**
  (face 0) for that frame; lazily-resolved OS faces swap in on a later frame.

The engine itself is multi-face: `setFont` installs the primary (face 0),
`addFont(name, bytes)` registers a named face, and glyphs are cached by
`(faceId, glyphIndex)` in one shared atlas.

## The parity-guaranteed bundled set

Large OFL binaries are **not committed**. `web/scripts/fetch_fonts.sh`
downloads them at a **pinned `google/fonts` commit** and verifies each file's
**sha256**, so every checkout and the native host get byte-identical files:

| Family       | File                          | Role             |
|--------------|-------------------------------|------------------|
| (primary)    | `public/fonts/default.ttf`    | face 0 — Noto Sans |
| `Noto Sans`  | `public/fonts/noto-sans.ttf`  | bundled          |
| `Noto Serif` | `public/fonts/noto-serif.ttf` | bundled          |

Run `bash web/scripts/fetch_fonts.sh` once after checkout. To update or extend
the set (e.g. Noto CJK / Arabic / Hebrew for full i18n, path #8): add an entry
to `FILES` in the script (with its sha256), bump the pin, and add the family to
`DEFAULT_FONTS` in `web/src/text-engine.ts`.

License: the bundled Noto faces are under the SIL Open Font License 1.1.

## Non-parity fonts

An OS-only font present natively but absent on the web (or vice versa) **cannot**
be reproduced pixel-for-pixel by the simulator. Prefer the bundled families (or
explicitly uploaded faces) for parity-critical work; treat Local-Font-Access
faces as best-effort. Font bytes are content-addressed, so a host can detect a
mismatch and surface it as a non-parity state.
