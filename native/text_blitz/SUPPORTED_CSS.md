# Blitz complex-layout mode — supported HTML/CSS

The `source.text.rich` effect lays out an HTML/CSS document with **Blitz** (`blitz-dom`
= Stylo cascade + Taffy flex/grid + parley/harfrust shaping) and renders it through
the shared MSDF text engine. It's built for **expressive "headline / VJ" text** —
big, styled, laid-out text and simple cards — **not** full web-page fidelity.

Everything here is **pixel-identical** between the native (FFGL/Metal) and browser
(WASM/WebGPU) renderers — that parity is the whole point, and it's enforced by the
test suites (`blitz_parity.sh`, `parity_check.sh`).

> Status legend: ✅ works · ⚠️ works with caveats · ❌ not rendered
> Underlying engine: **blitz-dom 0.3.0-alpha.4 / parley 0.9 / taffy 0.11** (pinned).
> Some limitations are alpha-version gaps that a future bump may close.

## Using it

`source.text.rich` has three inputs:

- **`html`** — the document body (a full `<!DOCTYPE html>…` works, or just a fragment).
- **`css`** — wrapped in `<style>` and prepended (so it's just author CSS).
- **`scale`** — zoom factor (see *Coordinate model*).

## Coordinate model

The output **texture** is the viewport. With `scale = 1`:

- `100vw` / `100%` (top level) == the full output width; `100vh` == full height.
- `font-size: 48px` == 48 output pixels; all lengths are output pixels.
- `scale = 2` magnifies everything 2× (half as much CSS content fits); `100vw`
  still maps to the output width.

Default text color is **white** and the body margin is **reset to 0** (UA defaults,
so your CSS still wins). The canvas starts opaque black.

---

## ✅ Layout

| Feature | Notes |
|---|---|
| Block flow, nesting | ✅ |
| **Flexbox** (`display:flex`) | ✅ including `gap`, `justify-content`, `align-items`, `flex-direction` |
| **Grid** (`display:grid`) | ✅ tracks / positions — but see the block-child caveat below |
| `inline-block`, `inline`, `display:table` | ✅ (shrink-to-fit — see *fit-content* below) |
| `padding`, `margin`, `gap` | ✅ affect layout |
| `width`/`height`: **px**, **%** | ✅ |
| `max-width`/`min-width`, `line-height`, `text-align` | ✅ |
| Wrapping / multi-line | ✅ greedy line breaking |

### ⚠️ Layout caveats

- **`width: fit-content` / `min-content` / `max-content` → full width.** Taffy's
  block layout doesn't implement the intrinsic-width keywords; they fall back to
  `auto` (= fill the container). **Workaround:** `display: inline-block` (content-
  hugging, flows inline), `display: table` (shrink-wrap, own line), or
  `display: flex; width: fit-content`.
- **`float` and `position: absolute` don't shrink-to-fit** (stay full width).
  General positioning support is limited — prefer fl/grid/flow layout.
- **Flex/grid items whose content is *block-level* don't expand** to their `1fr` /
  `flex:1` / explicit track width (they shrink to min-content). **Workaround:** make
  cell content **inline** (`<span>`, `display:inline`, bare text) instead of nested
  `<div>`/`<h3>`/`<p>`.

---

## ✅ Text

| Feature | Notes |
|---|---|
| `font-family` | ✅ bundled (Noto Sans/Serif + CJK) **and** OS fonts (true-weight faces) |
| `font-weight`, `font-style: italic` | ✅ real static faces; synthetic bold/oblique when the face lacks the style |
| `font-size`, `color`, `currentColor` | ✅ |
| `letter-spacing`, `word-spacing` | ✅ (parley) |
| `text-transform: uppercase/…` | ✅ (Stylo, pre-shaping) |
| `line-height`, `text-align` | ✅ |
| **CJK** (JP / KR / SC / TC) | ✅ regional Han via the `lang` attribute + font fallback chain |
| Shaping: ligatures, kerning, marks | ✅ via parley/harfrust |
| **Vertical text** (`writing-mode: vertical-rl/lr`) | ⚠️ see below |
| Emoji / symbols | ⚠️ glyphs only if a registered font covers them; no color-emoji bitmaps |

### ⚠️ Vertical text

`blitz-dom` alpha.4 doesn't compute `writing-mode`, so the engine reflows vertical
text **itself**:

- Detected **only from an inline `style="writing-mode:vertical-rl"`** on the
  container (not from a `<style>` rule).
- Uses the font's **designed vertical glyphs** (`vert`/`vrt2` GSUB) where they
  exist — real vertical brackets「」, the chōonpu ー, centered 、。 — and **rotates**
  Latin/dashes 90°, leaving CJK ideographs upright.
- The container's explicit width/height isn't honored in vertical mode (columns
  anchor to the viewport); surrounding block layout still treats it as horizontal.

### ⚠️ RTL / complex scripts

`dir="rtl"` / RTL content is **right-aligned/ordered**, but complex-script shaping
(Arabic joining, Indic reordering) is **not reliably supported** in this mode —
treat RTL/complex scripts as experimental.

---

## ✅ Box model (backgrounds, radius, clip, borders)

| Feature | Notes |
|---|---|
| `background-color` (solid) | ✅ incl. `currentColor`; transparent is skipped |
| `border-radius` | ✅ per-corner, circular (elliptical corners approximated as circular) |
| `overflow: hidden` | ✅ clips descendant boxes **and** text to the rounded padding box |
| `border` (uniform) | ✅ solid color, follows `border-radius`, crisp AA (no fringing) |

Painted in document order, **behind** the text. AA matches the glyph AA, and a
border-only box (transparent background) renders its outline.

### ⚠️ Box-model caveats

- **Borders: uniform width + single solid color only.** Per-side widths/colors
  (`border-left: 8px; border-top: 2px red`) with mitered corners are **not**
  modeled — the top side's width/color is used for the whole ring. No
  `dashed`/`dotted`, no `border-image`.
- **`overflow`**: only the **nearest** clipping ancestor is applied (nested
  `overflow:hidden` isn't intersected). `scroll`/`auto` are treated as `hidden`
  (no scrolling). A *translucent* border won't show the background through it.
- **Stacking is simplified**: all backgrounds/borders paint behind all text in
  document order. `z-index` and stacking contexts aren't honored, so an
  overlapping child background can't sit above a parent's text.

---

## ❌ Not rendered

These parse fine (no error) but produce nothing / are ignored:

| Feature | Status |
|---|---|
| `background: linear-gradient(…)` / gradients | ❌ no background drawn |
| `background-image`, `<img>`, any raster images | ❌ |
| `box-shadow`, `filter`, `backdrop-filter` | ❌ |
| `text-decoration` (underline / strikethrough) | ❌ no decoration lines |
| `text-shadow` | ❌ |
| `transform` (rotate/scale/translate on elements) | ❌ elements render at their layout position |
| `opacity` on elements | ❌ (only per-color alpha is honored) |
| CSS animations / transitions | ❌ layout is static per frame |
| Outlines, `::before`/`::after` content, list markers | ❌ / unverified |
| WOFF/WOFF2 font files | ❌ raw `sfnt` (`.ttf`/`.otf`/`.ttc`) only |

---

## Rule of thumb

If it's **layout + styled text + solid cards with rounded corners, borders, and
clipping**, it'll render — pixel-identically — on both the native and browser
engines. If it's **gradients, images, shadows, transforms, decorations, or precise
web-page fidelity**, it won't (yet). Lean on `inline-block`/`flex` for sizing,
inline content inside flex/grid cells, and inline `writing-mode` for vertical text.
