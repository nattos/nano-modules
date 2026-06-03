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

  // Install a font (env TE_FONT, default Monaco). The wasm tool reads the SAME
  // file, so font bytes — and thus glyphs — are identical on both sides.
  const char* fontPath = std::getenv("TE_FONT");
  if (!fontPath) fontPath = "/System/Library/Fonts/Monaco.ttf";
  if (FILE* ff = std::fopen(fontPath, "rb")) {
    std::fseek(ff, 0, SEEK_END); long fn = std::ftell(ff); std::fseek(ff, 0, SEEK_SET);
    std::vector<uint8_t> fb(fn);
    if (std::fread(fb.data(), 1, fn, ff) == (size_t)fn) eng.setFont(fb.data(), (int)fn);
    std::fclose(ff);
  }

  // Optional second face for multi-family parity: register TE_FONT2 under the
  // family name TE_FAMILY2 (the wasm tool registers the SAME file the SAME way).
  const char* font2 = std::getenv("TE_FONT2");
  const char* family2 = std::getenv("TE_FAMILY2");
  if (font2 && family2) {
    if (FILE* ff = std::fopen(font2, "rb")) {
      std::fseek(ff, 0, SEEK_END); long fn = std::ftell(ff); std::fseek(ff, 0, SEEK_SET);
      std::vector<uint8_t> fb(fn);
      if (std::fread(fb.data(), 1, fn, ff) == (size_t)fn)
        eng.addFont(family2, (int)std::strlen(family2), fb.data(), (int)fn);
      std::fclose(ff);
    }
  }

  // Optional fallback CHAIN for CJK/missing-codepoint parity: TE_FALLBACK is a
  // colon-separated list of font paths registered in order via addFallbackFont
  // (the wasm tool registers the SAME files the SAME way).
  if (const char* fbEnv = std::getenv("TE_FALLBACK")) {
    std::string list(fbEnv), path;
    for (size_t i = 0; i <= list.size(); i++) {
      if (i == list.size() || list[i] == ':') {
        if (!path.empty()) {
          // Tag the face's region from its filename so regional Han resolves.
          const char* lang = path.find("-sc") != std::string::npos ? "zh-Hans"
                           : path.find("-tc") != std::string::npos ? "zh-Hant"
                           : path.find("-jp") != std::string::npos ? "ja"
                           : path.find("-kr") != std::string::npos ? "ko" : "";
          if (FILE* ff = std::fopen(path.c_str(), "rb")) {
            std::fseek(ff, 0, SEEK_END); long fn = std::ftell(ff); std::fseek(ff, 0, SEEK_SET);
            std::vector<uint8_t> fb(fn);
            if (std::fread(fb.data(), 1, fn, ff) == (size_t)fn)
              eng.addFallbackFont(fb.data(), (int)fn, lang, (int)std::strlen(lang));
            std::fclose(ff);
          }
          path.clear();
        }
      } else path.push_back(list[i]);
    }
  }

  int id = eng.layout(spec.c_str(), (int)spec.size());
  if (id <= 0) { std::fprintf(stderr, "layout failed\n"); return 1; }

  text_engine::Metrics m;
  eng.measure(id, m);

  int count = eng.glyphCount(id);
  std::vector<text_engine::GlyphQuad> quads(count);
  int written = eng.glyphs(id, quads.data(), count);

  // FNV-1a over every dirty page (page index folded in), matching the JS tool.
  uint32_t hash = 0x811c9dc5u;
  text_engine::AtlasRegion r;
  while (eng.nextDirtyRegion(r)) {
    hash ^= (uint32_t)r.page; hash *= 0x01000193u;
    long n = (long)r.w * r.h * 4;
    for (long i = 0; i < n; i++) { hash ^= r.rgba[i]; hash *= 0x01000193u; }
  }
  int pageCount = eng.atlasPageCount();

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
  // Raw composite for tolerant native↔wasm comparison (bilinear float math may
  // differ by a few LSB across toolchains — perceptual, not byte, parity).
  if (const char* rp = std::getenv("TE_RAW")) {
    if (FILE* rf = std::fopen(rp, "wb")) { std::fwrite(img.data(), 1, img.size(), rf); std::fclose(rf); }
  }

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
    for (int k = 0; k < 16; k++) std::printf("%s%g", k ? ", " : "", (double)f[k]);
    std::printf("]%s\n", i + 1 < written ? "," : "");
  }
  std::printf("  ],\n");
  std::printf("  \"atlas\": {\n");
  std::printf("    \"w\": %d,\n", eng.atlasWidth());
  std::printf("    \"h\": %d,\n", eng.atlasHeight());
  std::printf("    \"pages\": %d,\n", pageCount);
  std::printf("    \"hash\": \"%x\"\n", hash);
  std::printf("  },\n");
  std::printf("  \"composite\": { \"w\": %d, \"h\": %d, \"hash\": \"%x\" }\n", cw, ch, chash);
  std::printf("}\n");

  eng.release(id);
  return 0;
}
