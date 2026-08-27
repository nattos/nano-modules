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
#include <string>
#include <vector>

namespace text_engine {

// Canonical face-registry key for a (family, weight, italic) style — the name
// a host font provider registers a resolved styled face under (addFont) and
// the key a run's family/weight/italic resolves through. MUST stay
// byte-identical to faceKey() in web/src/text-engine.ts. Regular (400,
// upright) is the bare ASCII-lowercased family name.
std::string faceKey(const std::string& family, int weight, bool italic);

// Split a CSS-style font-family value into ordered family names (comma-split,
// trimmed, surrounding quotes stripped). MUST match parseFamilyList() in
// web/src/font-list.ts.
std::vector<std::string> parseFamilyList(const std::string& s);

// Atlas pixel encoding, so the GPU-side shader knows how to interpret samples.
enum class AtlasKind : int {
  MSDF          = 0,  // 3-channel signed distance; sample = median(rgb), AA via screenPxRange
  AlphaCoverage = 1,  // straight coverage in all channels (stub / browser-raster fallback)
};

// How a layout's glyphs are anti-aliased. This is a per-LAYOUT request; the
// engine resolves it PER GLYPH into GlyphQuad::precise_w (see below), because
// the right answer depends on that glyph's on-screen size.
//
//   Smooth  — the MSDF atlas alone. Cheap, but above a few multiples of the
//             atlas reference em it develops interior pinholes and rounds off
//             corners: the field simply doesn't carry that much detail.
//   Precise — evaluate the real outline analytically in the shader. Exact at
//             any scale, costs a short per-pixel loop over nearby segments.
//   Auto    — per glyph, from its size vs. the scale at which its own MSDF tile
//             stops being faithful (GlyphInfo::maxSafePx), cross-faded over one
//             octave so the handover is invisible.
enum class Precision : int {
  Auto    = 0,
  Smooth  = 1,
  Precise = 2,
};

// ---------------------------------------------------------------------------
// Outline records (the Precise path)
//
// A flat float arena, uploaded once as a read-only storage buffer alongside the
// atlas and indexed by GlyphQuad::outline_ofs. Everything is in EM units, y-up,
// matching GlyphInfo's plane bounds — so a record is scale-free and is baked
// exactly once per glyph key, however large the text gets.
//
// Curves are flattened to line segments at kFlattenTol em (deviation stays well
// under a tenth of a pixel even at absurd sizes), then bucketed into horizontal
// BANDS so a fragment only visits the geometry near its own scanline.
//
// Within a band the segments are grouped into CONTOUR RUNS, and that grouping is
// load-bearing rather than tidiness: glyph outlines overlap. CJK strokes are
// drawn as separate overlapping contours, and synthetic bold (FT_Outline_Embolden)
// makes an outline self-intersect. Plain "distance to the nearest segment" then
// latches onto an edge BURIED inside the filled region and paints a seam down
// the middle of solid ink. Combining per-contour distances the way msdfgen's
// OverlappingContourCombiner does — which is what keeps the MSDF tile itself
// clean — is what makes the analytic path agree with it.
//
//   rec+0 : planeL, planeB, planeR, planeT      // em, y-up (PAD-inclusive)
//   rec+1 : bandCount, bandDy, 0, 0             // bands span [planeB,planeT], top-down
//   rec+2 : bandCount x (runOfs, runCount, 0, 0)    // runOfs: vec4s, record-relative
//    ...  : per band, runCount x (segOfs, segCount, winding, 0)
//    ...  : segments, each (x0, y0, x1, y1)
//
// `winding` is the contour's orientation (+1 filled, -1 a counter/hole), which
// the combiner needs to tell "inside a stroke" from "inside a hole".
//
// A segment is registered in every band its y-extent overlaps, GROWN by the
// antialiasing reach, so one band lookup serves both the distance and the
// winding count. That reach is a fixed em budget (kBandMarginEm): ample for any
// size Auto ever selects Precise at, and only theoretically thin if someone
// forces Precise below ~32 px/em — a size at which the atlas is exact anyway.
//
// All offsets are in vec4 units so the buffer binds as array<vec4<f32>> (WGSL)
// / device const float4* (MSL) with no packing games. The shader-side reader is
// mirrored three ways: Engine::rasterize (the CPU golden), the MSL compositor,
// and the WGSL compositor.
// ---------------------------------------------------------------------------

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
  float outline_ofs;      // outline record offset (vec4 units); 0 = no record
  float precise_w;        // 0 = pure MSDF .. 1 = pure analytic outline (blended)
  float _r2;              // reserved (keeps the struct 16-byte aligned)
  // overflow:hidden clip = the nearest clipping ancestor's rounded padding box,
  // applied as a coverage mask. clip_w <= 0 → no clip. 96 bytes (6 vec4).
  // Defaulted so the JSON layout() path (which doesn't clip) emits clip_w=0.
  float clip_x = 0, clip_y = 0, clip_w = 0, clip_h = 0;
  float clip_r_tl = 0, clip_r_tr = 0, clip_r_br = 0, clip_r_bl = 0;
};

// One filled background box from the external layout engine (Blitz: an element's
// `background-color` + `border-radius`). Already in layout-box px, drawn BEHIND
// the glyphs (painter order = the order emitted, i.e. document order, so a child
// background sits over its parent's). The same POD is the engine's input AND its
// GPU draw record (no atlas needed): 48 bytes = 3 vec4 for storage-buffer
// alignment. Radii are per-corner (top-left, top-right, bottom-right, bottom-left),
// circular, in px; the SDF fill clamps each to half the box. a=0 → skip.
struct BoxQuad {
  float x, y, w, h;                  // border-box rect, layout-box px
  float r, g, b, a;                  // background color (linear)
  float r_tl, r_tr, r_br, r_bl;      // corner radii, px
  // overflow:hidden clip (nearest clipping ANCESTOR's rounded padding box),
  // clip_w <= 0 → no clip.
  float clip_x, clip_y, clip_w, clip_h;
  float clip_r_tl, clip_r_tr, clip_r_br, clip_r_bl;
  // Uniform solid border: a `border_w`-px ring inside the rounded edge, painted
  // over the background (CSS background-clip:border-box). border_w<=0 → none.
  // 112 bytes (7 vec4).
  float border_w = 0, _bpad0 = 0, _bpad1 = 0, _bpad2 = 0;
  float border_r = 0, border_g = 0, border_b = 0, border_a = 0;
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
  // overflow:hidden clip carried from Blitz (nearest clipping ancestor's rounded
  // padding box); clip_w <= 0 → no clip. Copied into the emitted GlyphQuad. 84 bytes.
  float    clip_x, clip_y, clip_w, clip_h;
  float    clip_r_tl, clip_r_tr, clip_r_br, clip_r_bl;
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
  // same spec + same available fonts. The spec's optional `precision` field
  // (Precision, default Auto) selects the anti-aliasing path.
  int  layout(const char* spec_json, int len);

  // Lay out PRE-SHAPED glyph runs from an external engine (the Blitz complex-
  // layout mode). Each PreGlyph is self-contained (carries its own face, size,
  // color, position), so this just generates/caches each (face, gid) MSDF tile
  // and emits one GlyphQuad per visible glyph — reusing the SAME atlas, page
  // policy and quad math as layout(). Deterministic given the same glyphs +
  // fonts, so it stays byte-parity across native/wasm. Returns an opaque
  // layoutId (>0) or 0 on error. `boxes`/`boxCount` are the element background
  // fills (may be null/0); they are stored verbatim and drawn behind the glyphs.
  int  layoutGlyphs(const PreGlyph* glyphs, int count,
                    const BoxQuad* boxes = nullptr, int boxCount = 0,
                    Precision precision = Precision::Auto);

  // Glyph index for a codepoint in a registered face (0 = the primary font);
  // 0 if the face doesn't cover it. The pre-shaped layoutGlyphs() path takes
  // GIDs, so a caller driving it directly needs this to get one.
  uint32_t glyphIndex(int face, uint32_t codepoint) const;

  bool measure(int layout_id, Metrics& out) const;
  int  glyphCount(int layout_id) const;
  // Copies up to max_count quads into `out`; returns the number written.
  int  glyphs(int layout_id, GlyphQuad* out, int max_count) const;
  // Background boxes (drawn behind the glyphs): count + copy-out, same pattern.
  int  boxCount(int layout_id) const;
  int  boxes(int layout_id, BoxQuad* out, int max_count) const;
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

  // --- Outline arena access for the per-platform GPU glue ---
  // The Precise path's segment/band records (layout documented above). The
  // arena only ever grows and is never rewritten in place, so the glue can
  // upload the whole thing whenever `outlineDirty()` reports growth.
  const float* outlineData() const;     // vec4-aligned floats, may be null when empty
  int  outlineFloatCount() const;
  bool outlineDirty();                  // true once per growth, then clears

  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;

private:
  Engine();
  ~Engine();
  struct Impl;
  Impl* impl_;
};

} // namespace text_engine
