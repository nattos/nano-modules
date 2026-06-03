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

## Fallback chain (CJK and other missing codepoints)

When a run's face lacks a codepoint (e.g. CJK in a Latin font), the engine
consults an ordered **fallback chain** and shapes that codepoint with the first
covering face — so 你好 renders real glyphs instead of tofu. The host installs
the chain via `addFallbackFont(bytes, lang)` (web: `DEFAULT_FALLBACKS` in
`text-engine.ts`, fetched by `fetch_fonts.sh`). Selection is a 4-pass match in
descending preference: **lang+style → lang → style → any**. So the chosen
fallback matches both the run's **region** (`lang`: ja / ko / zh-Hant / zh-Hans,
for correct regional Han forms) and its **style** (serif vs sans, auto-detected
from each face's OS/2 `sFamilyClass`) — a serif primary (e.g. Times, or the
`serif` generic) pulls a serif CJK face, mirroring OS font fallback.

The bundled chain is **Noto Sans + Noto Serif** in **SC / TC / JP / KR**, all
glyf-flavored (byte-exact parity), covering Simplified + Traditional Chinese,
Japanese (kana), and Korean (hangul) in both styles. These are large (~130 MB of
CJK across the 8 faces); they're fetched (not committed) and gitignored. Extend
(Arabic, Hebrew, …) by adding files to `fetch_fonts.sh` + `DEFAULT_FALLBACKS`.

FreeType is built with both the TrueType (`glyf`) and **CFF** drivers, so
OpenType-CFF OS fonts (many CJK faces) open too — though CFF charstring
interpretation adds a few LSB of FP noise to the atlas, so CFF faces have
perceptual rather than byte-exact parity (the bundled glyf faces are byte-exact).

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
