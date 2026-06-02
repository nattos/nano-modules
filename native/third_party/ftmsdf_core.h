#pragma once
/*
 * ftmsdf_core.h — shared FreeType-outline → msdfgen-MSDF pipeline used by both
 * the native probe (ftmsdf_probe.cpp) and the wasm probe (ftmsdf_wasm.cpp), so
 * native and wasm exercise byte-identical logic. Phase-1 de-risk only; the real
 * engine integrates this into text_engine.cpp.
 */
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H

#include <msdfgen.h>

#include <algorithm>
#include <cstdint>

namespace ftmsdf {

struct Builder {
  msdfgen::Shape* shape = nullptr;
  msdfgen::Contour* contour = nullptr;
  msdfgen::Point2 cur{};
  static msdfgen::Point2 pt(const FT_Vector* v) { return msdfgen::Point2((double)v->x, (double)v->y); }
};
inline int moveTo(const FT_Vector* to, void* u) {
  auto* b = (Builder*)u; b->contour = &b->shape->addContour(); b->cur = Builder::pt(to); return 0;
}
inline int lineTo(const FT_Vector* to, void* u) {
  auto* b = (Builder*)u; auto e = Builder::pt(to);
  b->contour->addEdge(msdfgen::EdgeHolder(b->cur, e)); b->cur = e; return 0;
}
inline int conicTo(const FT_Vector* c, const FT_Vector* to, void* u) {
  auto* b = (Builder*)u; auto e = Builder::pt(to);
  b->contour->addEdge(msdfgen::EdgeHolder(b->cur, Builder::pt(c), e)); b->cur = e; return 0;
}
inline int cubicTo(const FT_Vector* c1, const FT_Vector* c2, const FT_Vector* to, void* u) {
  auto* b = (Builder*)u; auto e = Builder::pt(to);
  b->contour->addEdge(msdfgen::EdgeHolder(b->cur, Builder::pt(c1), Builder::pt(c2), e)); b->cur = e; return 0;
}

// Generate a `tile`×`tile` RGBA8 MSDF for codepoint `cp` of the in-memory font.
// `outRGBA` must hold tile*tile*4 bytes (RGB = MSDF channels, A = 255, y-down).
// Returns inside-coverage pixel count (>0 means a real glyph), or <0 on error.
inline int generateGlyphMSDF(const uint8_t* font, int len, unsigned cp,
                             int tile, double range, uint8_t* outRGBA) {
  FT_Library lib;
  if (FT_Init_FreeType(&lib)) return -1;
  FT_Face face;
  if (FT_New_Memory_Face(lib, font, (FT_Long)len, 0, &face)) { FT_Done_FreeType(lib); return -2; }
  FT_UInt gi = FT_Get_Char_Index(face, cp);
  if (FT_Load_Glyph(face, gi, FT_LOAD_NO_SCALE | FT_LOAD_NO_HINTING)) {
    FT_Done_Face(face); FT_Done_FreeType(lib); return -3;
  }

  msdfgen::Shape shape;
  Builder b; b.shape = &shape;
  FT_Outline_Funcs funcs = { moveTo, lineTo, conicTo, cubicTo, 0, 0 };
  if (FT_Outline_Decompose(&face->glyph->outline, &funcs, &b)) {
    FT_Done_Face(face); FT_Done_FreeType(lib); return -4;
  }
  shape.normalize();

  msdfgen::Shape::Bounds bnds = shape.getBounds();
  double w = bnds.r - bnds.l, h = bnds.t - bnds.b;
  double span = w > h ? w : h; if (span <= 0) span = (double)face->units_per_EM;
  double s = (tile - 2 * range) / span;
  msdfgen::Vector2 translate(-bnds.l + range / s + (span - w) / 2,
                             -bnds.b + range / s + (span - h) / 2);

  msdfgen::edgeColoringSimple(shape, 3.0);
  msdfgen::Bitmap<float, 3> msdf(tile, tile);
  msdfgen::generateMSDF(msdf, shape, msdfgen::Range(range / s),
                        msdfgen::Vector2(s, s), translate);

  auto toByte = [](float v) { v = v < 0 ? 0 : (v > 1 ? 1 : v); return (uint8_t)(v * 255.0f + 0.5f); };
  auto median = [](float a, float bb, float c) { return std::max(std::min(a, bb), std::min(std::max(a, bb), c)); };
  int inside = 0;
  for (int y = 0; y < tile; y++) {
    for (int x = 0; x < tile; x++) {
      const float* px = msdf(x, tile - 1 - y);
      size_t o = ((size_t)y * tile + x) * 4;
      outRGBA[o+0] = toByte(px[0]); outRGBA[o+1] = toByte(px[1]); outRGBA[o+2] = toByte(px[2]); outRGBA[o+3] = 255;
      if (median(px[0], px[1], px[2]) > 0.5f) inside++;
    }
  }
  FT_Done_Face(face); FT_Done_FreeType(lib);
  return inside;
}

} // namespace ftmsdf
