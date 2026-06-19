// host_impls_text.cpp — native implementations of the `text.*` host import
// group (declared in wasm_modules/include/host.h). This is the FFGL/Metal
// counterpart of web/src/text-engine.ts: it drives the shared CPU text engine
// (text_engine.h) + the Blitz HTML/CSS layout lib (text_blitz.h), then
// composites the laid-out glyphs/boxes into the target texture through the
// active GPUBackend using the MSL port of the WGSL compositor.
//
// Parity: the engine + Blitz are byte-identical native↔wasm, and the MSL
// compositor mirrors the WGSL/CPU math — so gen.text / gen.richtext render the
// same pixels here as in the browser (within hardware-sampler bilinear
// precision; see native/wasm_modules/text_engine/metal_parity.sh).
//
// Lifetime: the engine is a process singleton; this file owns one persistent
// Blitz session and a small GPU resource cache (shader/PSO/sampler/atlas array
// /bg/scratch buffers), all reused across frames and rebuilt only on backend
// swap or atlas resize. text_render encodes into the backend's current command
// buffer but does NOT submit — the effect calls gpu::Device::submit() itself.

#include "runtime/effect_runtime.h"
#include "runtime/text_host.h"
#include "gpu/gpu_backend.h"
#include "text/text_engine.h"
#include "text/text_blitz.h"
#include "text/shaders/text_composite_quad_msl.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <set>
#include <unordered_map>
#include <string>
#include <string_view>
#include <vector>
#include <nlohmann/json.hpp>

using effect_runtime::currentRuntime;
using text_engine::Engine;

namespace {

// --- Persistent host state ---------------------------------------------------
TbSession* g_blitz = nullptr;       // one shared Blitz layout session
bool       g_fonts_ready = false;   // a primary font has been installed

Engine& engine() { return Engine::instance(); }

void ensureBlitz() {
  if (!g_blitz) g_blitz = tb_create();
}

// Register a face into BOTH the engine and the Blitz session, in lock-step, so
// engine faceId N == Blitz faceId N (GIDs agree across the two libs).
int installFallback(const uint8_t* bytes, int len, const char* lang, int lang_len) {
  ensureBlitz();
  int fid = engine().addFallbackFont(bytes, len, lang, lang_len);
  // Lock-step is only preserved if BOTH libs accept the face. The engine
  // (FreeType openFace) rejects some faces the Blitz stack (parley) would
  // accept — e.g. a .ttc it won't open — returning -1. Mirroring such a face
  // into Blitz alone shifts every later Blitz faceId one ahead of the engine's,
  // so pre-shaped runs (gen.richtext) reference a faceId the engine lacks and
  // every glyph is dropped (face-out-of-range). Only mirror when the engine
  // took it.
  if (fid >= 0) tb_add_font(g_blitz, nullptr, 0, 0, 0, bytes, len);
  return fid;
}

// Lazy bootstrap from TE_FONT / TE_FALLBACK (same convention as blitz_dump),
// used only when the host didn't install fonts explicitly. Returns true if a
// primary font is available afterward.
bool ensureFonts() {
  if (g_fonts_ready) return true;
  ensureBlitz();

  const char* fontPath = std::getenv("TE_FONT");
  if (!fontPath) fontPath = "/System/Library/Fonts/Helvetica.ttc";
  if (FILE* f = std::fopen(fontPath, "rb")) {
    std::fseek(f, 0, SEEK_END); long n = std::ftell(f); std::fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> fb(n > 0 ? n : 0);
    if (n > 0 && std::fread(fb.data(), 1, n, f) == (size_t)n) {
      engine().setFont(fb.data(), (int)fb.size());
      tb_add_font(g_blitz, nullptr, 0, 0, 0, fb.data(), (int)fb.size());
      g_fonts_ready = true;
    }
    std::fclose(f);
  }
  if (!g_fonts_ready) return false;

  // Optional fallback chain (colon-separated paths); lang inferred from name.
  if (const char* fbEnv = std::getenv("TE_FALLBACK")) {
    std::string list(fbEnv), path;
    for (size_t i = 0; i <= list.size(); i++) {
      if (i == list.size() || list[i] == ':') {
        if (!path.empty()) {
          const char* lang = path.find("-sc") != std::string::npos ? "zh-Hans"
                           : path.find("-tc") != std::string::npos ? "zh-Hant"
                           : path.find("-jp") != std::string::npos ? "ja"
                           : path.find("-kr") != std::string::npos ? "ko" : "";
          if (FILE* f = std::fopen(path.c_str(), "rb")) {
            std::fseek(f, 0, SEEK_END); long n = std::ftell(f); std::fseek(f, 0, SEEK_SET);
            std::vector<uint8_t> cb(n > 0 ? n : 0);
            if (n > 0 && std::fread(cb.data(), 1, n, f) == (size_t)n) {
              installFallback(cb.data(), (int)cb.size(), lang, (int)std::strlen(lang));
            }
            std::fclose(f);
          }
          path.clear();
        }
      } else path.push_back(list[i]);
    }
  }
  return true;
}

// --- GPU compositor resource cache ------------------------------------------
// Quad compositor PSOs are color-attachment-format-specific (unlike the old
// compute kernel's format-agnostic storage write), so we cache one set per
// target pixel-format enum: RGBA8 (=1) for intermediate textures, BGRA8 (=0)
// for the output interop. Built once each, kept for the backend's lifetime.
struct QuadPSOs { int bg = -1, box = -1, glyph = -1; };

struct TextGpu {
  gpu::GPUBackend* backend = nullptr;  // cache is valid only for this backend
  int quadShader = -1, sampler = -1, bg = -1;
  std::unordered_map<int, QuadPSOs> psos;  // keyed by TextureFormat enum
  int atlas = -1, atlasLayers = 0, atlasW = 0, atlasH = 0;
  int glyphBuf = -1; uint32_t glyphCap = 0;
  int boxBuf = -1;   uint32_t boxCap = 0;
  int uniBuf = -1;

  void reset() {
    backend = nullptr;
    quadShader = sampler = bg = atlas = -1;
    psos.clear();
    atlasLayers = atlasW = atlasH = 0;
    glyphBuf = boxBuf = uniBuf = -1; glyphCap = boxCap = 0;
  }
};
TextGpu g_gpu;

// Format codes from wasm_modules/include/gpu.h: 1 == RGBA8Unorm.
constexpr int kFmtRGBA8 = 1;

// Ensure the shared resources + the PSO set for target format `fmt` exist on
// `b`. Returns the PSO set (rendered straight into the caller's target — no
// scratch — since both intermediates and the output interop carry RenderTarget
// usage). blendMode 0 = alpha-over; the bg pass writes alpha=1 so alpha-over ==
// replace, initialising the frame from the background.
const QuadPSOs* ensurePipeline(gpu::GPUBackend* b, int fmt) {
  if (g_gpu.backend != b) { g_gpu.reset(); g_gpu.backend = b; }
  if (g_gpu.quadShader < 0) {
    g_gpu.quadShader = b->createShaderModule(kTextCompositeQuadMSL);
    if (g_gpu.quadShader < 0) return nullptr;
  }
  if (g_gpu.sampler < 0) g_gpu.sampler = b->createSampler(/*linear*/1, /*clamp*/0);
  if (g_gpu.bg < 0) {
    g_gpu.bg = b->createTexture(1, 1, kFmtRGBA8);
    const uint8_t black[4] = {0, 0, 0, 255};
    b->writeTexture(g_gpu.bg, 1, 1, black, 4);
  }
  if (g_gpu.sampler < 0 || g_gpu.bg < 0) return nullptr;
  auto it = g_gpu.psos.find(fmt);
  if (it == g_gpu.psos.end()) {
    QuadPSOs p;
    int sh = g_gpu.quadShader;
    p.bg    = b->createInstancedRenderPSO(sh, "bg_vs",    sh, "bg_fs",    fmt, 0);
    p.box   = b->createInstancedRenderPSO(sh, "box_vs",   sh, "box_fs",   fmt, 0);
    p.glyph = b->createInstancedRenderPSO(sh, "glyph_vs", sh, "glyph_fs", fmt, 0);
    if (p.bg < 0 || p.box < 0 || p.glyph < 0) return nullptr;
    it = g_gpu.psos.emplace(fmt, p).first;
  }
  return &it->second;
}

// (Re)build + upload the MSDF atlas array for `id`; returns the atlas handle.
int ensureAtlas(gpu::GPUBackend* b, int /*id*/) {
  int aw = engine().atlasWidth(), ah = engine().atlasHeight();
  int pages = engine().atlasPageCount();
  if (aw <= 0 || ah <= 0) { aw = 1; ah = 1; }
  int layers = pages > 0 ? pages : 1;

  // Drain the engine's dirty-page queue (bookkeeping) into a set.
  std::set<int> dirty;
  text_engine::AtlasRegion r;
  while (engine().nextDirtyRegion(r)) dirty.insert(r.page);

  bool recreate = g_gpu.atlas < 0 || g_gpu.atlasLayers != layers ||
                  g_gpu.atlasW != aw || g_gpu.atlasH != ah;
  if (recreate) {
    if (g_gpu.atlas >= 0) b->release(g_gpu.atlas);
    g_gpu.atlas = b->createTextureArray(aw, ah, kFmtRGBA8, layers);
    g_gpu.atlasLayers = layers; g_gpu.atlasW = aw; g_gpu.atlasH = ah;
    for (int p = 0; p < pages; p++) {
      if (const uint8_t* px = engine().atlasPagePixels(p))
        b->writeTextureLayer(g_gpu.atlas, p, aw, ah, px, (uint32_t)aw * ah * 4);
    }
  } else {
    for (int p : dirty) {
      if (p < pages)
        if (const uint8_t* px = engine().atlasPagePixels(p))
          b->writeTextureLayer(g_gpu.atlas, p, aw, ah, px, (uint32_t)aw * ah * 4);
    }
  }
  return g_gpu.atlas;
}

// Grow-or-create a storage buffer to hold `need` bytes; writes `data` into it.
int ensureBuffer(gpu::GPUBackend* b, int handle, uint32_t& cap,
                 const void* data, uint32_t need) {
  uint32_t want = need < 16 ? 16 : need;   // never zero-size
  if (handle < 0 || cap < want) {
    if (handle >= 0) b->release(handle);
    handle = b->createBuffer(want, 0);
    cap = want;
  }
  if (data && need > 0)
    b->writeBuffer(handle, 0, static_cast<const uint8_t*>(data), need);
  return handle;
}

// 48-byte uniform block, byte-identical to the WGSL `U` struct and the MSL `U`.
struct UBO {
  uint32_t canvas_w, canvas_h, glyph_count, atlas_w, atlas_h;
  float    origin_x, origin_y;
  uint32_t atlas_kind;
  float    atlas_px_range;
  uint32_t box_count;
  float    _p1, _p2;
};

// ABI metrics POD (mirrors text::TextMetrics in host.h; same prefix as
// text_engine::Metrics + a trailing pad int).
struct AbiMetrics {
  float width, height;
  int   line_count;
  float first_baseline;
  int   glyph_count, atlas_kind;
  float atlas_px_range;
  int   _pad;
};

}  // namespace

// =============================================================================
// Public host-side font installers (runtime/text_host.h)
// =============================================================================
namespace effect_runtime {

void textInstallPrimaryFont(const uint8_t* bytes, int len) {
  // Installing a primary RESETS the engine's face registry: engine().setFont()
  // clears its faces + atlas (faceId 0 := this font). The Blitz session must
  // reset in lock-step — tb_add_font only ever appends, so without this a
  // re-install would leave Blitz with stale faces while the engine is back at 0,
  // and Blitz would hand back a faceId past the engine's range (every pre-shaped
  // glyph dropped). Recreate g_blitz so engine faceId N == Blitz faceId N again.
  // (textInstallDefaultFonts is idempotent so this normally runs once, but this
  // keeps the invariant correct for any direct re-install.)
  if (g_blitz) { tb_destroy(g_blitz); g_blitz = nullptr; }
  ensureBlitz();
  engine().setFont(bytes, len);
  tb_add_font(g_blitz, nullptr, 0, 0, 0, bytes, len);
  g_fonts_ready = true;
}
int textInstallFallbackFont(const uint8_t* bytes, int len,
                            const char* lang, int lang_len) {
  return installFallback(bytes, len, lang, lang_len);
}
void textSetDefaultLang(const char* lang, int lang_len) {
  engine().setDefaultLang(lang, lang_len);
}
bool textFontsReady() { return g_fonts_ready; }

}  // namespace effect_runtime

// =============================================================================
// text.* imports
// =============================================================================
extern "C" {

int text_layout(const char* spec_json, int spec_len) {
  if (!ensureFonts()) return 0;
  std::string_view spec(spec_json, spec_len > 0 ? (size_t)spec_len : 0);

  // Blitz complex-layout mode: {"mode":"html","html":...,"width":W,"height":H,
  // "scale":S}. Cheap substring gate, then full parse (mirrors text-engine.ts).
  if (spec.find("\"mode\"") != std::string_view::npos) {
    auto j = nlohmann::json::parse(spec, nullptr, false);
    if (!j.is_discarded() && j.value("mode", std::string()) == "html") {
      ensureBlitz();
      std::string html = j.value("html", std::string());
      unsigned w = (unsigned)j.value("width", 1920);
      unsigned h = (unsigned)j.value("height", 1080);
      float scale = j.value("scale", 1.0f);
      if (html.empty()) return engine().layoutGlyphs(nullptr, 0, nullptr, 0);
      TbLayout* bl = tb_layout(g_blitz, (const unsigned char*)html.data(),
                               (int)html.size(), w, h, scale);
      if (!bl) return engine().layoutGlyphs(nullptr, 0, nullptr, 0);
      int n = tb_glyph_count(bl);
      const text_engine::PreGlyph* runs = tb_glyph_ptr(bl);
      int bn = tb_box_count(bl);
      const text_engine::BoxQuad* boxes = tb_box_ptr(bl);
      int id = engine().layoutGlyphs(runs, n, boxes, bn);
      tb_free_layout(bl);
      return id;
    }
    // Unknown mode → fall through to the attributed-string engine.
  }
  return engine().layout(spec_json, spec_len);
}

int text_measure(int layout_id, void* out_metrics) {
  if (!out_metrics) return 0;
  text_engine::Metrics m;
  if (!engine().measure(layout_id, m)) return 0;
  auto* out = static_cast<AbiMetrics*>(out_metrics);
  out->width = m.width;
  out->height = m.height;
  out->line_count = m.line_count;
  out->first_baseline = m.first_baseline;
  out->glyph_count = m.glyph_count;
  out->atlas_kind = m.atlas_kind;
  out->atlas_px_range = m.atlas_px_range;
  out->_pad = 0;
  return 1;
}

void text_render(int layout_id, int target_tex, int bg_tex,
                 const char* xform_json, int xform_len) {
  auto* rt = currentRuntime();
  gpu::GPUBackend* b = rt ? rt->gpu() : nullptr;
  if (!b) return;

  // Transform: {"x":..,"y":..} layout-box origin offset (scale TODO).
  float originX = 0.0f, originY = 0.0f;
  if (xform_json && xform_len > 0) {
    auto j = nlohmann::json::parse(std::string_view(xform_json, xform_len),
                                   nullptr, false);
    if (!j.is_discarded()) {
      originX = j.value("x", 0.0f);
      originY = j.value("y", 0.0f);
    }
  }

  // Geometry (engine arrays ARE the GPU draw records, byte-for-byte).
  int gcount = engine().glyphCount(layout_id);
  std::vector<text_engine::GlyphQuad> glyphs(gcount > 0 ? gcount : 0);
  int written = gcount > 0 ? engine().glyphs(layout_id, glyphs.data(), gcount) : 0;
  int bcount = engine().boxCount(layout_id);
  std::vector<text_engine::BoxQuad> boxes(bcount > 0 ? bcount : 0);
  int boxesWritten = bcount > 0 ? engine().boxes(layout_id, boxes.data(), bcount) : 0;

  text_engine::Metrics m;
  engine().measure(layout_id, m);

  int atlas = ensureAtlas(b, layout_id);

  // Canvas dims = the TARGET texture (mirrors the web path, which sizes off
  // GPUTexture.width/height). gen.text/richtext are generators that render into
  // an executor-bound output texture, not a swapchain surface — so the surface
  // dims are 0 here and can't be used. Fall back to the surface only for a
  // standalone/test path that explicitly called setSurface().
  int cw = b->getTextureWidth(target_tex), ch = b->getTextureHeight(target_tex);
  if (cw <= 0 || ch <= 0) { cw = b->getSurfaceWidth(); ch = b->getSurfaceHeight(); }
  if (cw <= 0 || ch <= 0) return;

  // PSOs must match the target's color-attachment format (BGRA8 output interop
  // vs RGBA8 intermediates). We render straight into the target.
  int fmt = b->getTextureFormat(target_tex);
  if (fmt < 0) fmt = kFmtRGBA8;
  const QuadPSOs* pso = ensurePipeline(b, fmt);
  if (!pso) return;

  g_gpu.glyphBuf = ensureBuffer(b, g_gpu.glyphBuf, g_gpu.glyphCap,
                                glyphs.data(),
                                (uint32_t)written * sizeof(text_engine::GlyphQuad));
  g_gpu.boxBuf = ensureBuffer(b, g_gpu.boxBuf, g_gpu.boxCap,
                              boxes.data(),
                              (uint32_t)boxesWritten * sizeof(text_engine::BoxQuad));

  UBO u{};
  u.canvas_w = (uint32_t)cw; u.canvas_h = (uint32_t)ch;
  u.glyph_count = (uint32_t)written;
  u.atlas_w = (uint32_t)g_gpu.atlasW; u.atlas_h = (uint32_t)g_gpu.atlasH;
  u.origin_x = originX; u.origin_y = originY;
  u.atlas_kind = (uint32_t)m.atlas_kind;
  u.atlas_px_range = m.atlas_px_range;
  u.box_count = (uint32_t)boxesWritten;
  uint32_t uniCap = sizeof(UBO);
  g_gpu.uniBuf = ensureBuffer(b, g_gpu.uniBuf, uniCap, &u, sizeof(UBO));

  // Background sampled behind the text: a caller-supplied input texture to
  // overlay text onto. When unconnected, gen.text/richtext are pure generators —
  // they must leave TRANSPARENCY where there's no text, not paint opaque black.
  // bg MUST differ from the target (the bg pass samples it while rendering into
  // target).
  const bool hasInput = (bg_tex >= 0 && bg_tex != target_tex);

  // ONE render pass onto the target: [bg fullscreen (replace), only if an input
  // is connected] → boxes → glyphs, all instanced quads with alpha-over blend,
  // in document order. Cleared to TRANSPARENT so an unconnected input leaves
  // transparency between glyphs instead of the old opaque-black fallback. NOT
  // submitted here; the effect calls gpu::Device::submit().
  int pass = b->beginRenderPass(target_tex, 0.0f, 0.0f, 0.0f, 0.0f);
  // bg fill (fullscreen triangle, alpha=1 → replaces the clear with the input).
  // Skipped with no input so the transparent clear shows through.
  if (hasInput) {
    b->renderSetPSO(pass, pso->bg);
    b->renderSetBuffer(pass, g_gpu.uniBuf, 2);
    b->renderSetTexture(pass, bg_tex, 1, /*read*/0);
    b->renderSetSampler(pass, g_gpu.sampler, 0);
    b->renderDraw(pass, 3, 1);
  }
  // background boxes (fill + border ring), document order.
  if (boxesWritten > 0) {
    b->renderSetPSO(pass, pso->box);
    b->renderSetBuffer(pass, g_gpu.boxBuf, 1);
    b->renderSetBuffer(pass, g_gpu.uniBuf, 2);
    b->renderDraw(pass, 6, (uint32_t)boxesWritten);
  }
  // glyphs (MSDF quads).
  if (written > 0) {
    b->renderSetPSO(pass, pso->glyph);
    b->renderSetBuffer(pass, g_gpu.glyphBuf, 0);
    b->renderSetBuffer(pass, g_gpu.uniBuf, 2);
    b->renderSetTexture(pass, atlas, 0, /*read*/0);
    b->renderSetSampler(pass, g_gpu.sampler, 0);
    b->renderDraw(pass, 6, (uint32_t)written);
  }
  b->endRenderPass(pass);
}

int text_atlas(int layout_id) {
  auto* rt = currentRuntime();
  gpu::GPUBackend* b = rt ? rt->gpu() : nullptr;
  if (!b || !ensurePipeline(b, kFmtRGBA8)) return -1;
  return ensureAtlas(b, layout_id);   // shared atlas-array texture handle
}

int text_glyphs(int layout_id, void* out_quads, int out_bytes) {
  int count = engine().glyphCount(layout_id);
  if (!out_quads || out_bytes <= 0) return count;   // count query
  // The ABI GlyphQuad (host.h) is 64B == the engine GlyphQuad's first 64 bytes
  // (clip fields, used only by the internal compositor, are dropped).
  const int kAbi = 64;
  int maxCount = out_bytes / kAbi;
  if (maxCount <= 0) return 0;
  std::vector<text_engine::GlyphQuad> tmp(count > 0 ? count : 0);
  int n = count > 0 ? engine().glyphs(layout_id, tmp.data(), count) : 0;
  if (n > maxCount) n = maxCount;
  auto* dst = static_cast<uint8_t*>(out_quads);
  for (int i = 0; i < n; i++) std::memcpy(dst + (size_t)i * kAbi, &tmp[i], kAbi);
  return n;
}

void text_release(int layout_id) {
  engine().release(layout_id);
}

}  // extern "C"
