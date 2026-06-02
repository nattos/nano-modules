/*
 * ftmsdf_probe.cpp — Phase 1 de-risk probe.
 *
 * Proves the real glyph pipeline end to end: load a font from MEMORY bytes
 * (FT_New_Memory_Face — the sandbox-safe path the host font provider will use),
 * extract a glyph outline with FT_Outline_Decompose, feed it to msdfgen, and
 * generate a multi-channel signed distance field tile. Writes the MSDF as a PNG
 * for inspection and a thresholded coverage PNG to confirm the glyph is real.
 *
 *   ftmsdf_probe <font.ttf> <char> <out_prefix>
 */
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H

#include <msdfgen.h>

#include "../src/text/png_write.h"   // reuse the engine's PNG writer

#include <cstdio>
#include <cstdint>
#include <vector>

using namespace msdfgen;

namespace {
struct Builder {
  Shape* shape = nullptr;
  Contour* contour = nullptr;
  Point2 cur{};
  static Point2 pt(const FT_Vector* v) { return Point2((double)v->x, (double)v->y); }
};
int moveTo(const FT_Vector* to, void* u) {
  auto* b = (Builder*)u;
  b->contour = &b->shape->addContour();
  b->cur = Builder::pt(to);
  return 0;
}
int lineTo(const FT_Vector* to, void* u) {
  auto* b = (Builder*)u; Point2 e = Builder::pt(to);
  b->contour->addEdge(EdgeHolder(b->cur, e)); b->cur = e; return 0;
}
int conicTo(const FT_Vector* c, const FT_Vector* to, void* u) {
  auto* b = (Builder*)u; Point2 e = Builder::pt(to);
  b->contour->addEdge(EdgeHolder(b->cur, Builder::pt(c), e)); b->cur = e; return 0;
}
int cubicTo(const FT_Vector* c1, const FT_Vector* c2, const FT_Vector* to, void* u) {
  auto* b = (Builder*)u; Point2 e = Builder::pt(to);
  b->contour->addEdge(EdgeHolder(b->cur, Builder::pt(c1), Builder::pt(c2), e)); b->cur = e; return 0;
}
} // namespace

int main(int argc, char** argv) {
  const char* path = argc > 1 ? argv[1] : "/System/Library/Fonts/Monaco.ttf";
  unsigned int cp = argc > 2 ? (unsigned int)argv[2][0] : 'A';
  const char* prefix = argc > 3 ? argv[3] : "/tmp/ftmsdf";

  // Load font bytes into memory (mirrors the host font-provider path).
  FILE* f = std::fopen(path, "rb");
  if (!f) { std::printf("cannot open %s\n", path); return 1; }
  std::fseek(f, 0, SEEK_END); long n = std::ftell(f); std::fseek(f, 0, SEEK_SET);
  std::vector<unsigned char> bytes(n);
  if (std::fread(bytes.data(), 1, n, f) != (size_t)n) { std::fclose(f); return 1; }
  std::fclose(f);

  FT_Library lib;
  if (FT_Init_FreeType(&lib)) { std::printf("FT_Init failed\n"); return 1; }
  FT_Face face;
  if (FT_New_Memory_Face(lib, bytes.data(), (FT_Long)bytes.size(), 0, &face)) {
    std::printf("FT_New_Memory_Face failed\n"); return 1;
  }
  std::printf("face: %s units_per_EM=%d glyphs=%ld\n",
              face->family_name ? face->family_name : "?", face->units_per_EM, face->num_glyphs);

  FT_UInt gindex = FT_Get_Char_Index(face, cp);
  if (FT_Load_Glyph(face, gindex, FT_LOAD_NO_SCALE | FT_LOAD_NO_HINTING)) {
    std::printf("FT_Load_Glyph failed\n"); return 1;
  }

  Shape shape;
  Builder b; b.shape = &shape;
  FT_Outline_Funcs funcs = { moveTo, lineTo, conicTo, cubicTo, 0, 0 };
  if (FT_Outline_Decompose(&face->glyph->outline, &funcs, &b)) {
    std::printf("decompose failed\n"); return 1;
  }
  shape.normalize();
  std::printf("contours=%zu\n", shape.contours.size());

  // Fit the glyph into a TILE-px MSDF tile with RANGE-px distance spread.
  const int TILE = 48; const double RANGE = 4.0;
  Shape::Bounds bnds = shape.getBounds();
  double w = bnds.r - bnds.l, h = bnds.t - bnds.b;
  double span = w > h ? w : h; if (span <= 0) span = (double)face->units_per_EM;
  double s = (TILE - 2 * RANGE) / span;
  Vector2 translate(-bnds.l + RANGE / s + (span - w) / 2, -bnds.b + RANGE / s + (span - h) / 2);

  edgeColoringSimple(shape, 3.0);
  Bitmap<float, 3> msdf(TILE, TILE);
  generateMSDF(msdf, shape, Range(RANGE / s), Vector2(s, s), translate);

  // MSDF → RGBA PNG (y-flip: msdfgen is y-up, PNG is y-down).
  std::vector<uint8_t> rgba((size_t)TILE * TILE * 4);
  std::vector<uint8_t> cov((size_t)TILE * TILE * 4);
  auto toByte = [](float v) { v = v < 0 ? 0 : (v > 1 ? 1 : v); return (uint8_t)(v * 255.0f + 0.5f); };
  auto median = [](float a, float bb, float c) { return std::max(std::min(a, bb), std::min(std::max(a, bb), c)); };
  for (int y = 0; y < TILE; y++) {
    for (int x = 0; x < TILE; x++) {
      const float* px = msdf(x, TILE - 1 - y);
      size_t o = ((size_t)y * TILE + x) * 4;
      rgba[o+0] = toByte(px[0]); rgba[o+1] = toByte(px[1]); rgba[o+2] = toByte(px[2]); rgba[o+3] = 255;
      float d = median(px[0], px[1], px[2]);     // reconstructed signed distance
      uint8_t c = d > 0.5f ? 255 : 0;            // hard threshold = glyph silhouette
      cov[o+0] = cov[o+1] = cov[o+2] = c; cov[o+3] = 255;
    }
  }
  char p1[512], p2[512];
  std::snprintf(p1, sizeof(p1), "%s_msdf.png", prefix);
  std::snprintf(p2, sizeof(p2), "%s_coverage.png", prefix);
  png_write::writeFile(p1, rgba.data(), TILE, TILE);
  png_write::writeFile(p2, cov.data(), TILE, TILE);

  // Count "inside" pixels as a sanity signal.
  int inside = 0;
  for (int i = 0; i < TILE * TILE; i++) if (cov[(size_t)i*4] > 0) inside++;
  std::printf("MSDF %dx%d generated, inside-coverage=%d/%d px → %s , %s\n",
              TILE, TILE, inside, TILE*TILE, p1, p2);

  FT_Done_Face(face); FT_Done_FreeType(lib);
  return 0;
}
