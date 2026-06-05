/*
 * text_host_metal.mm — exercise the REAL native `text.*` host impls
 * (host_impls_text.cpp) end-to-end through a live Metal backend, then check the
 * GPU composite against the CPU golden (Engine::rasterize) — the same robust
 * gate as metal_parity.sh, but driving the actual FFGL code path:
 *
 *   spec JSON ──text_layout──► engine/Blitz layout
 *             ──text_render(target, xform)──► [host GPU compositor] ──► RGBA
 *
 * Proves gen.text (attributed-string JSON) AND gen.richtext (mode:html → Blitz)
 * render identically to the reference through the host service + EffectRuntime +
 * GPUBackend, exactly as the plugin will call them.
 *
 *   text_host_metal <mode> [doc.html]
 *     mode = "text"  → a gen.text-style JSON spec (centered)
 *     mode = "html"  → a gen.richtext-style {mode:html} spec (origin 0,0)
 *   env: TE_FONT, TE_FALLBACK, TE_W, TE_H, TE_PNG, TE_RAW
 */

#import <Metal/Metal.h>
#import <Foundation/Foundation.h>

#include "runtime/effect_runtime.h"
#include "runtime/text_host.h"
#include "gpu/gpu_backend.h"
#include "text/text_engine.h"
#include "png_write.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// The host impls under test (extern-C; declared here to avoid pulling host.h's
// WASM import attributes).
extern "C" {
int  text_layout(const char* spec_json, int spec_len);
int  text_measure(int layout_id, void* out_metrics);
void text_render(int layout_id, int target_tex, const char* xform_json, int xform_len);
void text_release(int layout_id);
}

struct AbiMetrics { float width, height; int line_count; float first_baseline;
                    int glyph_count, atlas_kind; float atlas_px_range; int _pad; };

static std::vector<uint8_t> readFile(const char* path) {
  std::vector<uint8_t> out;
  if (FILE* f = std::fopen(path, "rb")) {
    std::fseek(f, 0, SEEK_END); long n = std::ftell(f); std::fseek(f, 0, SEEK_SET);
    out.resize(n > 0 ? n : 0);
    if (n > 0 && std::fread(out.data(), 1, n, f) != (size_t)n) out.clear();
    std::fclose(f);
  }
  return out;
}

static std::string jsonEscape(const std::string& s) {
  std::string o;
  for (char c : s) {
    switch (c) {
      case '"':  o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n";  break;
      case '\r': o += "\\r";  break;
      case '\t': o += "\\t";  break;
      default:   o += c;      break;
    }
  }
  return o;
}

int main(int argc, char** argv) {
  @autoreleasepool {
    std::string mode = argc > 1 ? argv[1] : "text";
    unsigned vw = std::getenv("TE_W") ? (unsigned)std::atoi(std::getenv("TE_W")) : 800;
    unsigned vh = std::getenv("TE_H") ? (unsigned)std::atoi(std::getenv("TE_H")) : 600;
    int W = (int)vw, H = (int)vh;

    // --- Live Metal backend + runtime (sets currentRuntime) ---
    auto backend = gpu::createMetalBackend();
    if (!backend) { std::fprintf(stderr, "no Metal backend\n"); return 1; }
    effect_runtime::EffectRuntime rt(backend.get());
    int surface = backend->createTexture((uint32_t)W, (uint32_t)H, /*RGBA8*/1);
    backend->setSurface(surface, (uint32_t)W, (uint32_t)H);
    // Clear to opaque black so an empty layout still has a defined background.
    backend->clearTexture(surface, 0, 0, 0, 1);
    backend->submit();

    // Fonts: the host service lazily bootstraps from TE_FONT/TE_FALLBACK on the
    // first text_layout (same as the tools) — no explicit install needed here.

    // --- Build the spec the way gen.text / gen.richtext do ---
    std::string spec, xform;
    if (mode == "html") {
      std::string html;
      if (argc > 2) { auto b = readFile(argv[2]); html.assign(b.begin(), b.end()); }
      if (html.empty()) {
        html = "<!DOCTYPE html><html><head><style>"
               "body{margin:0;font-family:sans-serif;color:#fff;}"
               ".wrap{display:flex;gap:16px;padding:24px;}"
               "h1{font-size:40px;font-weight:700;margin:0 0 8px;}"
               "p{font-size:18px;line-height:1.4;width:320px;}"
               ".badge{font-size:14px;font-weight:700;color:#6cf;}"
               ".card{background:#234;border-radius:14px;border:3px solid #6cf;padding:16px;overflow:hidden;}"
               "</style></head><body><div class=\"wrap\"><div class=\"card\">"
               "<h1>Blitz layout</h1>"
               "<p>Native host path: gen.richtext through the Metal compositor.</p>"
               "<span class=\"badge\">PARITY \xc2\xb7 MSDF \xc2\xb7 GPU</span>"
               "</div></div></body></html>";
      }
      spec = "{\"mode\":\"html\",\"html\":\"" + jsonEscape(html) +
             "\",\"width\":" + std::to_string(W) +
             ",\"height\":" + std::to_string(H) + ",\"scale\":1.0}";
      xform = "{\"x\":0,\"y\":0}";
    } else {
      // gen.text-style attributed string.
      spec = "{\"text\":\"Native text.* host\\nHello \xe4\xb8\x96\xe7\x95\x8c\","
             "\"runs\":[{\"size_px\":56.000,\"rgba\":[1,1,1,1]}],"
             "\"constraints\":{\"max_width_px\":0,\"line_spacing\":1.2}}";
    }

    int id = text_layout(spec.c_str(), (int)spec.size());
    if (id <= 0) { std::fprintf(stderr, "text_layout failed (fonts? TE_FONT)\n"); return 1; }

    // gen.text centers using measure; gen.richtext draws at origin.
    float ox = 0, oy = 0;
    if (mode != "html") {
      AbiMetrics m{};
      if (text_measure(id, &m)) { ox = (W - m.width) * 0.5f; oy = (H - m.height) * 0.5f; }
      char buf[96]; std::snprintf(buf, sizeof(buf), "{\"x\":%.2f,\"y\":%.2f}", ox, oy);
      xform = buf;
    }

    // --- GPU path (the host impl) ---
    text_render(id, surface, xform.c_str(), (int)xform.size());
    backend->submit();                         // the effect would call submit()
    std::vector<uint8_t> gpuImg = backend->readbackTexture(surface, (uint32_t)W, (uint32_t)H);

    // --- CPU golden (same layout, same origin) ---
    std::vector<uint8_t> ref((size_t)W * H * 4);
    text_engine::Engine::instance().rasterize(id, W, H, ox, oy, nullptr, ref.data());

    int glyphCount = text_engine::Engine::instance().glyphCount(id);
    text_release(id);

    if (const char* p = std::getenv("TE_PNG"))
      png_write::writeFile(p, gpuImg.data(), W, H);
    if (const char* rp = std::getenv("TE_RAW")) {
      if (FILE* f = std::fopen(rp, "wb")) { std::fwrite(gpuImg.data(), 1, gpuImg.size(), f); std::fclose(f); }
    }

    // --- Robust parity gate (mirrors metal_parity.sh) ---
    if (gpuImg.size() != ref.size() || gpuImg.empty()) {
      std::fprintf(stderr, "size mismatch / empty readback\n"); return 1;
    }
    long maxd = 0, nz = 0; double sum = 0;
    for (size_t k = 0; k < ref.size(); k++) {
      int d = std::abs((int)ref[k] - (int)gpuImg[k]);
      if (d) { nz++; sum += d; if (d > maxd) maxd = d; }
    }
    double pct = 100.0 * nz / ref.size();
    double mean = nz ? sum / nz : 0;
    const double MAXPCT = 1.0, MAXMEAN = 16.0; const long HARDMAX = 64;
    std::printf("{\"mode\":\"%s\",\"glyphs\":%d,\"maxD\":%ld,\"diffPct\":%.3f,\"meanD\":%.2f}\n",
                mode.c_str(), glyphCount, maxd, pct, mean);
    bool ok = pct <= MAXPCT && mean <= MAXMEAN && maxd <= HARDMAX;
    if (!ok) {
      std::fprintf(stderr, "❌ host-path parity FAILED (pct=%.3f mean=%.2f max=%ld)\n",
                   pct, mean, maxd);
      return 1;
    }
    std::fprintf(stderr, "✅ HOST-PATH PARITY: text.* impls ≈ CPU golden "
                 "(maxΔ=%ld diff=%.3f%% meanΔ=%.2f)\n", maxd, pct, mean);
  }
  return 0;
}
