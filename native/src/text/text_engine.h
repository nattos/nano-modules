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
// origin (top-left); UVs are normalized into the master atlas. Mirrors
// text::GlyphQuad in host.h.
struct GlyphQuad {
  float x, y, w, h;       // layout-box-relative rect, px
  float u0, v0, u1, v1;   // atlas UV rect, normalized
  float r, g, b, a;       // run color (linear)
};

// A sub-rectangle of the master atlas that changed and needs GPU upload.
// `rgba` points into engine-owned memory (tightly packed, stride = w*4); it is
// valid until the next layout() call. The GPU glue uploads then discards it.
struct AtlasRegion {
  int x, y, w, h;
  const uint8_t* rgba;
};

// The host owns exactly one Engine. Not thread-safe (single-threaded in WASM).
class Engine {
public:
  static Engine& instance();

  // Lay out an attributed-string JSON spec (schema documented in host.h).
  // Returns an opaque layoutId (>0) or 0 on error. Deterministic given the
  // same spec + same available fonts.
  int  layout(const char* spec_json, int len);

  bool measure(int layout_id, Metrics& out) const;
  int  glyphCount(int layout_id) const;
  // Copies up to max_count quads into `out`; returns the number written.
  int  glyphs(int layout_id, GlyphQuad* out, int max_count) const;
  void release(int layout_id);

  // --- Atlas access for the per-platform GPU glue ---
  int  atlasWidth() const;
  int  atlasHeight() const;
  const uint8_t* atlasPixels() const;   // full master image, RGBA8, row stride = width*4
  // Pops the next pending dirty region (false when none remain). The GPU glue
  // drains this after each layout() and uploads each region.
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
