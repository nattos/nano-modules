/*
 * blitz_dump.cpp — native end-to-end of the Blitz complex-layout mode:
 *
 *   HTML/CSS ──tb_layout──► pre-shaped glyph runs ──Engine::layoutGlyphs──►
 *   GlyphQuads + atlas ──Engine::rasterize──► PNG
 *
 * Links the Rust layout lib (libtext_blitz.a) and the C++ text engine, feeding
 * the SAME font bytes to both so faceIds + GIDs agree. Prints a deterministic
 * digest (glyph count, metrics, atlas hash, composite hash) and, with TE_RUNS
 * set, the raw PreGlyph buffer — so a wasm runner (text_blitz.wasm) can diff
 * the runs for byte parity, the headline guarantee of this mode.
 *
 *   blitz_dump <doc.html>            (env TE_FONT, TE_FALLBACK, TE_W, TE_H,
 *                                     TE_PNG, TE_RAW, TE_RUNS)
 */

#include "text_blitz.h"
#include "text_engine.h"
#include "png_write.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static_assert(sizeof(text_engine::PreGlyph) == 48,
              "PreGlyph must be 48 bytes to match Rust TbGlyph");

static std::vector<uint8_t> readFile(const char* path) {
  std::vector<uint8_t> out;
  if (FILE* f = std::fopen(path, "rb")) {
    std::fseek(f, 0, SEEK_END); long n = std::ftell(f); std::fseek(f, 0, SEEK_SET);
    out.resize(n);
    if (std::fread(out.data(), 1, n, f) != (size_t)n) out.clear();
    std::fclose(f);
  }
  return out;
}

static const char* kSampleHtml =
  "<!DOCTYPE html><html><head><style>"
  "body{margin:0;font-family:sans-serif;color:#fff;}"
  ".wrap{display:flex;gap:16px;padding:24px;}"
  "h1{font-size:40px;font-weight:700;margin:0 0 8px;}"
  "p{font-size:18px;line-height:1.4;width:320px;}"
  ".badge{font-size:14px;font-weight:700;color:#6cf;}"
  "</style></head><body><div class=\"wrap\"><div>"
  "<h1>Blitz layout</h1>"
  "<p>Real CSS flexbox and text wrapping, shaped by parley, emitted as "
  "positioned glyph runs for the MSDF atlas.</p>"
  "<span class=\"badge\">PARITY \xc2\xb7 MSDF \xc2\xb7 GPU</span>"
  "</div></div></body></html>";

int main(int argc, char** argv) {
  auto& eng = text_engine::Engine::instance();
  TbSession* sess = tb_create();

  // Primary font into BOTH engine (face 0 via setFont) and Blitz (faceId 0).
  const char* fontPath = std::getenv("TE_FONT");
  if (!fontPath) fontPath = "/System/Library/Fonts/Helvetica.ttc";
  std::vector<uint8_t> fb = readFile(fontPath);
  if (fb.empty()) { std::fprintf(stderr, "font load failed: %s\n", fontPath); return 1; }
  eng.setFont(fb.data(), (int)fb.size());
  tb_add_font(sess, nullptr, 0, fb.data(), (int)fb.size());

  // Optional fallback CHAIN (colon-separated paths), appended to BOTH in the
  // same order so faceId N is the same bytes on both sides. Filename → lang.
  if (const char* fbEnv = std::getenv("TE_FALLBACK")) {
    std::string list(fbEnv), path;
    for (size_t i = 0; i <= list.size(); i++) {
      if (i == list.size() || list[i] == ':') {
        if (!path.empty()) {
          const char* lang = path.find("-sc") != std::string::npos ? "zh-Hans"
                           : path.find("-tc") != std::string::npos ? "zh-Hant"
                           : path.find("-jp") != std::string::npos ? "ja"
                           : path.find("-kr") != std::string::npos ? "ko" : "";
          std::vector<uint8_t> cb = readFile(path.c_str());
          if (!cb.empty()) {
            eng.addFallbackFont(cb.data(), (int)cb.size(), lang, (int)std::strlen(lang));
            tb_add_font(sess, nullptr, 0, cb.data(), (int)cb.size());
          }
          path.clear();
        }
      } else path.push_back(list[i]);
    }
  }

  std::vector<uint8_t> html;
  if (argc > 1) html = readFile(argv[1]);
  if (html.empty()) html.assign(kSampleHtml, kSampleHtml + std::strlen(kSampleHtml));

  unsigned vw = std::getenv("TE_W") ? (unsigned)std::atoi(std::getenv("TE_W")) : 800;
  unsigned vh = std::getenv("TE_H") ? (unsigned)std::atoi(std::getenv("TE_H")) : 600;

  TbLayout* bl = tb_layout(sess, html.data(), (int)html.size(), vw, vh, 1.0f);
  if (!bl) { std::fprintf(stderr, "tb_layout failed\n"); return 1; }
  int runCount = tb_glyph_count(bl);
  const text_engine::PreGlyph* runs = tb_glyph_ptr(bl);

  // Raw run buffer for cross-target (native lib vs wasm lib) byte parity.
  if (const char* rp = std::getenv("TE_RUNS")) {
    if (FILE* rf = std::fopen(rp, "wb")) {
      std::fwrite(runs, sizeof(text_engine::PreGlyph), runCount, rf); std::fclose(rf);
    }
  }

  int id = eng.layoutGlyphs(runs, runCount);
  if (id <= 0) { std::fprintf(stderr, "layoutGlyphs failed\n"); return 1; }

  text_engine::Metrics m; eng.measure(id, m);
  int count = eng.glyphCount(id);

  // Atlas hash (FNV-1a over dirty pages), matching parity_dump.
  uint32_t hash = 0x811c9dc5u;
  text_engine::AtlasRegion r;
  while (eng.nextDirtyRegion(r)) {
    hash ^= (uint32_t)r.page; hash *= 0x01000193u;
    long n = (long)r.w * r.h * 4;
    for (long i = 0; i < n; i++) { hash ^= r.rgba[i]; hash *= 0x01000193u; }
  }

  // CPU composite over the full viewport (origin 0,0 = doc top-left).
  int cw = (int)vw, ch = (int)vh;
  std::vector<uint8_t> img((size_t)cw * ch * 4);
  eng.rasterize(id, cw, ch, 0.0f, 0.0f, nullptr, img.data());
  uint32_t chash = 0x811c9dc5u;
  for (uint8_t v : img) { chash ^= v; chash *= 0x01000193u; }
  if (const char* p = std::getenv("TE_PNG"))  png_write::writeFile(p, img.data(), cw, ch);
  if (const char* rp = std::getenv("TE_RAW")) {
    if (FILE* rf = std::fopen(rp, "wb")) { std::fwrite(img.data(), 1, img.size(), rf); std::fclose(rf); }
  }

  std::printf("{\"runs\":%d,\"glyphs\":%d,\"pages\":%d,"
              "\"width\":%.3f,\"height\":%.3f,\"atlas\":%u,\"composite\":%u}\n",
              runCount, count, eng.atlasPageCount(), m.width, m.height, hash, chash);

  tb_free_layout(bl);
  tb_destroy(sess);
  return 0;
}
