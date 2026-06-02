/*
 * parity_dump.cpp — print a deterministic digest of the natively compiled text
 * engine for a given spec, in the SAME format as parity_dump.mjs (which runs
 * text_engine.wasm). Diffing the two outputs proves byte-parity between the
 * native FFGL path and the web simulator.
 *
 *   c++ -std=c++17 -fno-exceptions -fno-rtti \
 *       native/src/text/text_engine.cpp native/src/text/tools/parity_dump.cpp \
 *       -I native/src/text -o /tmp/parity_dump
 *   /tmp/parity_dump '<spec-json>'
 */

#include "text_engine.h"
#include "png_write.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static const char* kDefaultSpec =
  "{\"text\":\"Hello\\nWorld!\","
  "\"runs\":[{\"start\":0,\"len\":12,\"family\":\"Inter\",\"size_px\":48,\"rgba\":[1,1,1,1]}],"
  "\"constraints\":{\"max_width_px\":300,\"align\":\"start\",\"direction\":\"ltr\",\"line_spacing\":1.2}}";

int main(int argc, char** argv) {
  std::string spec = (argc > 1) ? argv[1] : kDefaultSpec;
  auto& eng = text_engine::Engine::instance();

  int id = eng.layout(spec.c_str(), (int)spec.size());
  if (id <= 0) { std::fprintf(stderr, "layout failed\n"); return 1; }

  text_engine::Metrics m;
  eng.measure(id, m);

  int count = eng.glyphCount(id);
  std::vector<text_engine::GlyphQuad> quads(count);
  int written = eng.glyphs(id, quads.data(), count);

  // FNV-1a over the reported dirty region (matches the JS tool).
  uint32_t hash = 0x811c9dc5u;
  int rx = 0, ry = 0, rw = 0, rh = 0; long rptr = 0;
  text_engine::AtlasRegion r;
  if (eng.nextDirtyRegion(r)) {
    rx = r.x; ry = r.y; rw = r.w; rh = r.h; rptr = (long)(intptr_t)r.rgba;
    int n = r.w * r.h * 4;
    for (int i = 0; i < n; i++) { hash ^= r.rgba[i]; hash *= 0x01000193u; }
  }

  // --- CPU reference composite → real pixels ---
  // Deterministic canvas: layout bounds + 16px margin, opaque-black background.
  const int MARGIN = 16;
  int cw = (int)std::ceil(m.width) + 2 * MARGIN;
  int ch = (int)std::ceil(m.height) + 2 * MARGIN;
  if (cw < 1) cw = 1; if (ch < 1) ch = 1;
  std::vector<uint8_t> img((size_t)cw * ch * 4);
  eng.rasterize(id, cw, ch, (float)MARGIN, (float)MARGIN, nullptr, img.data());
  uint32_t chash = 0x811c9dc5u;
  for (uint8_t v : img) { chash ^= v; chash *= 0x01000193u; }
  if (const char* p = std::getenv("TE_PNG")) png_write::writeFile(p, img.data(), cw, ch);

  // Emit JSON matching parity_dump.mjs (2-space indent, same key order/rounding).
  std::printf("{\n");
  std::printf("  \"metrics\": {\n");
  std::printf("    \"width\": %g,\n", (double)m.width);
  std::printf("    \"height\": %g,\n", (double)m.height);
  std::printf("    \"line_count\": %d,\n", m.line_count);
  std::printf("    \"first_baseline\": %g,\n", (double)m.first_baseline);
  std::printf("    \"glyph_count\": %d,\n", m.glyph_count);
  std::printf("    \"atlas_kind\": %d,\n", m.atlas_kind);
  std::printf("    \"atlas_px_range\": %g\n", (double)m.atlas_px_range);
  std::printf("  },\n");
  std::printf("  \"quad_count\": %d,\n", written);
  std::printf("  \"quads\": [\n");
  for (int i = 0; i < written; i++) {
    const float* f = &quads[i].x;
    std::printf("    [");
    for (int k = 0; k < 12; k++) std::printf("%s%g", k ? ", " : "", (double)f[k]);
    std::printf("]%s\n", i + 1 < written ? "," : "");
  }
  std::printf("  ],\n");
  std::printf("  \"atlas\": {\n");
  std::printf("    \"w\": %d,\n", eng.atlasWidth());
  std::printf("    \"h\": %d,\n", eng.atlasHeight());
  if (rw) std::printf("    \"region\": { \"x\": %d, \"y\": %d, \"w\": %d, \"h\": %d, \"ptr\": %ld },\n",
                      rx, ry, rw, rh, rptr);
  else    std::printf("    \"region\": null,\n");
  std::printf("    \"hash\": \"%x\"\n", hash);
  std::printf("  },\n");
  std::printf("  \"composite\": { \"w\": %d, \"h\": %d, \"hash\": \"%x\" }\n", cw, ch, chash);
  std::printf("}\n");

  eng.release(id);
  return 0;
}
