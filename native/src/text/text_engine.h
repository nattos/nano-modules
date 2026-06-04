#pragma once
/*
 * text_engine.h — host-internal text shaping/layout/rasterization engine.
 *
 * This is the single shared engine behind the `text.*` host ABI (see
 * native/wasm_modules/include/host.h). It is compiled BOTH ways from identical
 * source — natively into `effect_runtime` (the FFGL/Metal path) and to a
 * standalone `text_engine.wasm` loaded once by the web host worker — so its
 * outputs are byte-identical across environments. That byte-parity is what lets
 * the browser simulator reproduce the native "for realz" pixels.
 *
 * CRITICAL INVARIANT: this engine performs NO GPU calls. It maps a JSON spec to
 * pure-CPU outputs only — a master atlas image (RGBA8), positioned glyph quads,
 * and layout metrics. The per-platform GPU layer (Metal / WebGPU) does the only
 * environment-specific work: upload the dirty atlas region and encode the
 * render pass. Keep it deterministic and free of wall-clock / RNG / threads.
 *
 * Phase 0 ships a STUB implementation (one solid box glyph per codepoint) to
 * prove the JSON-in / pixels-out pipeline end to end. Phase 1 swaps in real
 * FreeType + msdfgen; Phase 3 adds HarfBuzz + SheenBidi + libunibreak. The
 * public surface below is intended to stay stable across those swaps.
 */

#include <cstdint>

namespace text_engine {

// Atlas pixel encoding, so the GPU-side shader knows how to interpret samples.
enum class AtlasKind : int {
  MSDF          = 0,  // 3-channel signed distance; sample = median(rgb), AA via screenPxRange
  AlphaCoverage = 1,  // straight coverage in all channels (stub / browser-raster fallback)
};

// Layout-level metrics. Mirrors text::TextMetrics in host.h (the ABI POD); the
// host glue copies field-for-field across the boundary.
struct Metrics {
  float width          = 0.0f;  // laid-out content width, px
  float height         = 0.0f;  // total laid-out height, px
  int   line_count     = 0;     // lines after wrapping
  float first_baseline = 0.0f;  // px from layout-box top to first baseline
  int   glyph_count    = 0;     // total positioned glyphs
  int   atlas_kind     = 0;     // AtlasKind
  float atlas_px_range = 0.0f;  // MSDF distance range in atlas px (AA)
};

// One positioned glyph quad. Screen rect is px relative to the layout-box
// origin (top-left); UVs are normalized into the glyph's atlas PAGE; `page` is
// the atlas-array layer to sample. 64 bytes (4 vec4s) for GPU storage-buffer
// alignment. Mirrors text::GlyphQuad in host.h.
struct GlyphQuad {
  float x, y, w, h;       // layout-box-relative rect, px
  float u0, v0, u1, v1;   // atlas-page UV rect, normalized
  float r, g, b, a;       // run color (linear)
  float page;             // atlas-array layer index
  float _r0, _r1, _r2;    // reserved (keeps the struct 16-byte aligned)
};

// One PRE-SHAPED glyph from an external layout/shaping engine (the Blitz path:
// Stylo + Taffy + parley/harfrust). The external engine owns wrapping, shaping
// and positioning; the text engine only rasterizes by GID and emits quads, so
// no cmap / wrap / fallback runs here. Positions are layout-box px: (x, y) is
// the glyph ORIGIN sitting on the baseline (same convention as parley's
// positioned_glyphs). `cp` is a representative codepoint used ONLY to pick the
// atlas resolution class (CJK → dense page). `skew`/`embolden` carry parley's
// synthetic oblique/bold when a face lacks the requested style (0 = none).
struct PreGlyph {
  int      face;          // registered faceId (0 = primary)
  uint32_t gid;           // FreeType glyph index — already shaped (no cmap)
  uint32_t cp;            // representative codepoint (atlas resolution class)
  float    x, y;          // glyph origin x, baseline y (layout-box px)
  float    size;          // font size, px
  float    r, g, b, a;    // color (linear)
  float    skew;          // synthetic oblique shear, radians (0 = none)
  float    embolden;      // synthetic bold strength, em (0 = none)
  float    rot;           // glyph rotation, radians (vertical text: rotated forms
                          //   like the chōonpu / Latin; 0 = upright). Baked into
                          //   the atlas tile (rotated about the glyph's center).
};

// A dirty atlas PAGE that changed and needs GPU upload (full-page granularity).
// `rgba` points into engine-owned memory (tightly packed, stride = w*4); it is
// valid until the next layout() call. The GPU glue uploads `page`'s layer.
struct AtlasRegion {
  int page;
  int x, y, w, h;
  const uint8_t* rgba;
};

// The host owns exactly one Engine. Not thread-safe (single-threaded in WASM).
class Engine {
public:
  static Engine& instance();

  // Install the PRIMARY font from in-memory sfnt bytes (the sandbox-safe path
  // the host font provider supplies). This is face 0, used by any run that does
  // not name a registered family. Resets the glyph atlas + caches + registry.
  // Returns false if FreeType rejects the bytes.
  bool setFont(const uint8_t* bytes, int len);
  bool hasFont() const;

  // Register an ADDITIONAL named face the host font provider resolved (by
  // family name → sfnt bytes: Core Text natively, bundled / Local Font Access
  // on web). A run whose JSON `family` matches `name` is shaped with this face;
  // unmatched families fall back to face 0. Idempotent: a name already
  // registered returns its existing id without re-reading the bytes. Additive —
  // does NOT reset the atlas (existing glyphs/layouts stay valid). Returns the
  // faceId (>=0), or -1 on failure (no primary font installed, or bad bytes).
  int addFont(const char* name, int name_len, const uint8_t* bytes, int len);
  // True if `name` is already registered (host can skip re-resolving bytes).
  bool hasFontNamed(const char* name, int name_len) const;

  // Register an (unnamed) fallback face and append it to the fallback chain:
  // when a run's face lacks a codepoint (e.g. CJK in a Latin font), the engine
  // consults the chain and shapes the codepoint with the first face that covers
  // it. `lang` (BCP-47-ish: "ja", "ko", "zh-Hant", "zh-Hans"; may be null) tags
  // the face's region: a run whose language matches is served by this face FIRST,
  // so Han ideographs shared across CJK render in the correct regional glyph
  // forms. The host installs these once (Noto Sans JP/KR/TC/SC). Additive — does
  // NOT reset the atlas. Returns the faceId (>=0), or -1 on failure.
  int addFallbackFont(const uint8_t* bytes, int len, const char* lang = nullptr, int lang_len = 0);

  // Default language for runs/specs that don't carry their own `lang`, used to
  // pick the regional fallback for shared Han. On web the host derives this from
  // navigator.language (the system locale). Empty → chain order (no preference).
  void setDefaultLang(const char* lang, int lang_len);

  // Lay out an attributed-string JSON spec (schema documented in host.h).
  // Returns an opaque layoutId (>0) or 0 on error. Deterministic given the
  // same spec + same available fonts.
  int  layout(const char* spec_json, int len);

  // Lay out PRE-SHAPED glyph runs from an external engine (the Blitz complex-
  // layout mode). Each PreGlyph is self-contained (carries its own face, size,
  // color, position), so this just generates/caches each (face, gid) MSDF tile
  // and emits one GlyphQuad per visible glyph — reusing the SAME atlas, page
  // policy and quad math as layout(). Deterministic given the same glyphs +
  // fonts, so it stays byte-parity across native/wasm. Returns an opaque
  // layoutId (>0) or 0 on error.
  int  layoutGlyphs(const PreGlyph* glyphs, int count);

  bool measure(int layout_id, Metrics& out) const;
  int  glyphCount(int layout_id) const;
  // Copies up to max_count quads into `out`; returns the number written.
  int  glyphs(int layout_id, GlyphQuad* out, int max_count) const;
  void release(int layout_id);

  // --- CPU reference compositor ---
  // Rasterize a layout into a caller-allocated RGBA8 buffer (out, outW*outH*4),
  // placing the layout-box origin at (originX, originY). `bg` (outW*outH*4, may
  // be null → opaque black) is the starting background; glyphs are alpha-over
  // composited on top using the SAME math the GPU shader will use. Returns
  // false on an invalid handle.
  //
  // This is the golden reference: because it's compiled identically native +
  // wasm, both environments produce byte-identical pixels, and the GPU
  // compositor (Phase 1+) is validated against it.
  bool rasterize(int layout_id, int outW, int outH,
                 float originX, float originY,
                 const uint8_t* bg, uint8_t* out) const;

  // --- Multi-page atlas access for the per-platform GPU glue ---
  // The atlas is split into fixed-size pages (all atlasWidth()×atlasHeight()),
  // uploaded as a texture array; a GlyphQuad's `page` field is the layer to
  // sample. Pages may use different internal glyph resolutions — dense scripts
  // (CJK) are packed onto higher-resolution pages, so large text stays crisp.
  int  atlasWidth() const;            // page width (all pages identical)
  int  atlasHeight() const;           // page height
  int  atlasPageCount() const;        // number of allocated pages
  const uint8_t* atlasPagePixels(int page) const;  // RGBA8, row stride = width*4
  // Pops the next pending dirty page (false when none remain); out.page is the
  // layer. The GPU glue drains this after each layout() and re-uploads each.
  bool nextDirtyRegion(AtlasRegion& out);

  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;

private:
  Engine();
  ~Engine();
  struct Impl;
  Impl* impl_;
};

} // namespace text_engine
