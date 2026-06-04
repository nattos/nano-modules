# text_blitz — Blitz complex-layout mode

An **optional** layout mode for the text engine: lay out a full **HTML/CSS
document** instead of a single attributed string. It's a thin Rust C-ABI lib
wrapping [Blitz](https://github.com/dioxuslabs/blitz) (`blitz-dom`):

- **Stylo** — CSS cascade (the same engine Firefox/Servo use)
- **Taffy** — flexbox / grid / block layout
- **parley + harfrust** — text shaping (OpenType GSUB/GPOS, complex scripts)

## The seam: layout here, pixels there

Blitz owns **layout + shaping only**. It never paints. It emits **pre-shaped
glyph runs** — `(face, gid, cp, origin x, baseline y, size, rgba, skew,
embolden)` — and the C++ text engine rasterizes those by GID through the **same
MSDF atlas + GPU compositor** as the simple paragraph mode
(`Engine::layoutGlyphs`). Because the painter never changes and Blitz is
deterministic, **native↔wasm pixel parity is preserved**.

GIDs are font-intrinsic, so a GID Blitz produces selects the same FreeType
outline — provided both sides shape the **same sfnt bytes**. The host therefore
registers the same fonts, in the same order, into Blitz and the engine, so
`face` N is the same bytes on both. (`tb_add_font` / `te_set_font` +
`addFallbackFont`.)

## Build

```bash
cargo build --release                      # libtext_blitz.a (native, ~54 MB)
bash build_wasm.sh                         # text_blitz.wasm → web/public/wasm/
```

The web engine (`web/src/text-engine.ts`) loads `text_blitz.wasm` best-effort;
if it's absent, `mode:"html"` specs no-op and the paragraph engine is untouched.

## Verify parity

```bash
cd ../wasm_modules/text_engine && bash blitz_parity.sh [doc.html]
```

Builds the native staticlib + wasm, runs a doc through both, and asserts:
1. **run parity** — native lib and `text_blitz.wasm` emit byte-identical run
   buffers, and
2. **web-path pixel parity** — `text_blitz.wasm` + `text_engine.wasm` (as the
   web worker) composite to the same pixels as the native path (maxΔ=0).

## Consumer

`native/wasm_modules/richtext` (`gen.richtext`): an `html` + `scale` node that
emits a `{mode:"html"}` spec. Use it when a node needs CSS layout, rich runs, or
complex/vertical scripts; use `gen.text` for plain attributed strings.

## Scope / TODO

- Synthetic bold/italic (parley `Synthesis`) bake into the outline
  (`FT_Outline_Embolden` / shear); real-style faces are preferred.
- Lazy OS fonts resolved *after* init are mirrored into Blitz in order; a font
  that only Blitz needs (named purely in CSS, never via a run `family`) isn't
  auto-resolved yet.
- The **native FFGL** host doesn't link `libtext_blitz.a` yet (web path only);
  that lands with the native `text.*` host impls (GPU compositor dispatch).
- WOFF/WOFF2 inputs would need decoding before registration (raw sfnt today).
