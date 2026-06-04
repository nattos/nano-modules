/*
 * text_engine_wasm.cpp — flat C ABI over text_engine::Engine.
 *
 * This is the export surface of `text_engine.wasm`, the single shared engine
 * the WEB host worker instantiates once and drives on behalf of every effect's
 * `text.*` calls. The same Engine compiles natively into `effect_runtime` for
 * the FFGL/Metal path; this wrapper just gives the JS host a flat, pointer-based
 * entry surface (the host writes the spec JSON into our linear memory via the
 * exported malloc, calls te_layout, then reads metrics/glyphs/atlas back out).
 *
 * The readback structs are written with the SAME byte layout as text::TextMetrics
 * / text::GlyphQuad in host.h so the JS side and the native effect ABI agree.
 *
 * Exports (see native/wasm_modules/text_engine/build.sh):
 *   te_layout, te_measure, te_glyph_count, te_glyphs, te_release,
 *   te_atlas_width, te_atlas_height, te_atlas_ptr, te_next_dirty_region,
 *   plus malloc/free (WASI libc) for the host to stage the spec JSON.
 */

#include "text_engine.h"

#include <cstdint>
#include <cstring>

using text_engine::Engine;

// 32-byte ABI metrics, field-for-field identical to text::TextMetrics (host.h).
struct AbiMetrics {
  float width;
  float height;
  int32_t line_count;
  float first_baseline;
  int32_t glyph_count;
  int32_t atlas_kind;
  float atlas_px_range;
  int32_t _pad;
};
static_assert(sizeof(AbiMetrics) == 32, "AbiMetrics must match text::TextMetrics");

// 24-byte dirty-page descriptor handed to the GPU glue: target array layer +
// rect + the byte offset (within this module's linear memory) of the RGBA8.
struct AbiDirtyRegion {
  int32_t page;      // atlas-array layer to upload
  int32_t x, y, w, h;
  int32_t rgba_ptr;  // offset into linear memory
};
static_assert(sizeof(AbiDirtyRegion) == 24, "AbiDirtyRegion layout");

extern "C" {

// Install the PRIMARY font (face 0) from bytes the host staged into linear
// memory. Resets the registry + atlas. Returns 1/0.
int te_set_font(const uint8_t* bytes, int len) {
  return Engine::instance().setFont(bytes, len) ? 1 : 0;
}

// Register an additional named face the host font provider resolved. `name` is
// the family string (faceByName key) referenced by a run's "family" field.
// Returns the faceId (>=0), or -1 on failure. Idempotent by name.
int te_add_font(const char* name, int name_len, const uint8_t* bytes, int len) {
  return Engine::instance().addFont(name, name_len, bytes, len);
}

// 1 if a family name is already registered (host can skip re-resolving bytes).
int te_has_font(const char* name, int name_len) {
  return Engine::instance().hasFontNamed(name, name_len) ? 1 : 0;
}

// Register a fallback face (appended to the chain consulted for codepoints the
// run's face lacks, e.g. CJK). `lang` tags its region (ja/ko/zh-Hant/zh-Hans)
// for regional Han selection. Returns the faceId (>=0), or -1 on failure.
int te_add_fallback_font(const uint8_t* bytes, int len, const char* lang, int lang_len) {
  return Engine::instance().addFallbackFont(bytes, len, lang, lang_len);
}

// Set the default language (system locale) for runs without their own `lang`.
void te_set_default_lang(const char* lang, int lang_len) {
  Engine::instance().setDefaultLang(lang, lang_len);
}

int te_layout(const char* spec, int len) {
  return Engine::instance().layout(spec, len);
}

// Lay out PRE-SHAPED glyph runs from the Blitz layout wasm (text_blitz). `ptr`
// points at a packed array of `count` text_engine::PreGlyph records (48 bytes
// each) the host wrote into engine memory; returns a layoutId (>0) or 0.
int te_layout_glyphs(const void* ptr, int count) {
  return Engine::instance().layoutGlyphs((const text_engine::PreGlyph*)ptr, count);
}

int te_measure(int id, void* out_metrics) {
  text_engine::Metrics m;
  if (!Engine::instance().measure(id, m)) return 0;
  AbiMetrics a;
  a.width          = m.width;
  a.height         = m.height;
  a.line_count     = m.line_count;
  a.first_baseline = m.first_baseline;
  a.glyph_count    = m.glyph_count;
  a.atlas_kind     = m.atlas_kind;
  a.atlas_px_range = m.atlas_px_range;
  a._pad           = 0;
  std::memcpy(out_metrics, &a, sizeof(a));
  return 1;
}

int te_glyph_count(int id) {
  return Engine::instance().glyphCount(id);
}

int te_glyphs(int id, void* out, int out_bytes) {
  int max_count = out_bytes / (int)sizeof(text_engine::GlyphQuad);
  if (max_count <= 0) return 0;
  return Engine::instance().glyphs(id, (text_engine::GlyphQuad*)out, max_count);
}

void te_release(int id) {
  Engine::instance().release(id);
}

// CPU reference compositor. bg_ptr/out_ptr are byte offsets into linear memory
// (the host mallocs them); bg_ptr may be 0 for opaque black. Returns 1/0.
int te_rasterize(int id, int outW, int outH, float ox, float oy,
                 int bg_ptr, int out_ptr) {
  const uint8_t* bg = bg_ptr ? (const uint8_t*)(intptr_t)bg_ptr : nullptr;
  uint8_t* out = (uint8_t*)(intptr_t)out_ptr;
  return Engine::instance().rasterize(id, outW, outH, ox, oy, bg, out) ? 1 : 0;
}

int te_atlas_width()  { return Engine::instance().atlasWidth(); }
int te_atlas_height() { return Engine::instance().atlasHeight(); }
int te_atlas_page_count() { return Engine::instance().atlasPageCount(); }

// Byte offset (within linear memory) of page `p`'s RGBA8 pixels, or 0.
int te_atlas_page_ptr(int p) {
  return (int)(intptr_t)Engine::instance().atlasPagePixels(p);
}

int te_next_dirty_region(void* out) {
  text_engine::AtlasRegion r;
  if (!Engine::instance().nextDirtyRegion(r)) return 0;
  AbiDirtyRegion a;
  a.page = r.page;
  a.x = r.x; a.y = r.y; a.w = r.w; a.h = r.h;
  a.rgba_ptr = (int)(intptr_t)r.rgba;
  std::memcpy(out, &a, sizeof(a));
  return 1;
}

} // extern "C"
