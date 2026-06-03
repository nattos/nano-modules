/*
 * text_engine.cpp — Phase 1 implementation: real glyphs via FreeType + msdfgen.
 *
 * Replaces the Phase-0 box stub. A font is installed from memory bytes
 * (setFont). layout() shapes UTF-8 text LTR (cmap + advances), greedy word-wraps
 * to a max width, and emits positioned glyph quads. Each unseen glyph is
 * rasterized once to an MSDF tile (FreeType outline → msdfgen) at a reference em
 * size and shelf-packed into a shared atlas; the quad is scaled to the requested
 * font size in layout space (so font size never multiplies atlas entries).
 *
 * Still NO GPU calls and fully deterministic — compiled identically native +
 * wasm, so atlas + geometry + metrics stay byte-identical across environments
 * (parity_check.sh). RTL/bidi/complex-shaping/rich-text are Phase 2/3.
 */

#include "text_engine.h"

#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H

#include <msdfgen.h>

#include <linebreak.h>   // libunibreak: UAX#14 line break opportunities

#include <algorithm>
#include <cctype>
#include <climits>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

namespace text_engine {

// Multi-page, multi-resolution atlas parameters. Every page is the SAME pixel
// size (uploaded as one texture-array layer) but a page's glyphs are rasterized
// at its own reference em (refPx) — dense scripts (CJK) get higher-resolution
// pages so feature density / corner sharpness survives at large render sizes,
// while sparse scripts (Latin) stay compact (more glyphs per page).
static constexpr int    PAGE_W    = 2048;
static constexpr int    PAGE_H    = 2048;
static constexpr int    REF_STD   = 64;    // non-CJK glyphs (sparse features)
static constexpr int    REF_HIGH  = 128;   // CJK ideographs / kana / hangul (dense)
static constexpr double RANGE_PX  = 4.0;   // MSDF distance range, atlas px (all pages)
static constexpr int    PAD       = 5;     // tile padding ≥ ceil(RANGE_PX), atlas px
static constexpr int    GAP       = 1;     // transparent gutter between packed tiles:
                                           // bilinear sampling at a tile edge then
                                           // blends with empty (fully-outside) space
                                           // instead of the neighbor tile — kills the
                                           // thin-line / dot atlas-bleed artifacts.

// Reference em for a codepoint: dense CJK scripts (ideographs, kana, hangul,
// compat ideographs, SIP) → high-res pages; everything else → standard.
static int refPxForCodepoint(unsigned cp) {
  if ((cp >= 0x2E80 && cp <= 0x9FFF) ||   // CJK radicals … Unified Ideographs (+kana/hangul-jamo)
      (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK compatibility ideographs
      (cp >= 0x20000 && cp <= 0x2FA1F))   // CJK ext B–F + compat supplement
    return REF_HIGH;
  return REF_STD;
}

// ---- Minimal exception-free JSON field extraction (as in Phase 0) ----------
static int findField(const char* s, int n, const char* key) {
  std::string pat = "\""; pat += key; pat += "\"";
  int klen = (int)pat.size();
  for (int i = 0; i + klen <= n; i++) {
    if (std::memcmp(s + i, pat.data(), klen) == 0) {
      int j = i + klen;
      while (j < n && (s[j] == ' ' || s[j] == '\t')) j++;
      if (j < n && s[j] == ':') { j++; while (j < n && (s[j] == ' ' || s[j] == '\t')) j++; return j; }
    }
  }
  return -1;
}
static bool readString(const char* s, int n, int p, std::string& out) {
  if (p < 0 || p >= n || s[p] != '"') return false;
  out.clear();
  int j = p + 1;
  while (j < n && s[j] != '"') {
    char c = s[j];
    if (c == '\\' && j + 1 < n) {
      char e = s[j + 1];
      switch (e) {
        case 'n': out.push_back('\n'); break; case 't': out.push_back('\t'); break;
        case '"': out.push_back('"'); break;  case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;  default: out.push_back(e); break;
      }
      j += 2;
    } else { out.push_back(c); j++; }
  }
  return true;
}
static float readNumber(const char* s, int n, const char* key, float fallback) {
  int p = findField(s, n, key);
  if (p < 0 || p >= n) return fallback;
  int j = p;
  while (j < n && (s[j]=='-'||s[j]=='+'||s[j]=='.'||s[j]=='e'||s[j]=='E'||(s[j]>='0'&&s[j]<='9'))) j++;
  std::string tok(s + p, s + j);
  char* end = nullptr; double v = std::strtod(tok.c_str(), &end);
  return end == tok.c_str() ? fallback : (float)v;
}
// Decode one UTF-8 codepoint at byte i; returns next index, writes cp.
static int decodeUTF8(const std::string& t, int i, unsigned& cp) {
  unsigned char c = (unsigned char)t[i];
  if (c < 0x80) { cp = c; return i + 1; }
  if ((c >> 5) == 0x6 && i + 1 < (int)t.size()) { cp = ((c & 0x1F) << 6) | ((unsigned char)t[i+1] & 0x3F); return i + 2; }
  if ((c >> 4) == 0xE && i + 2 < (int)t.size()) { cp = ((c & 0x0F) << 12) | (((unsigned char)t[i+1] & 0x3F) << 6) | ((unsigned char)t[i+2] & 0x3F); return i + 3; }
  if ((c >> 3) == 0x1E && i + 3 < (int)t.size()) { cp = ((c & 0x07) << 18) | (((unsigned char)t[i+1] & 0x3F) << 12) | (((unsigned char)t[i+2] & 0x3F) << 6) | ((unsigned char)t[i+3] & 0x3F); return i + 4; }
  cp = c; return i + 1;
}

// Parse "key":[n0,n1,...] into out[count]; entries past the array keep defaults.
static void readFloatArray(const char* s, int n, const char* key, float* out, int count) {
  int p = findField(s, n, key);
  if (p < 0 || p >= n || s[p] != '[') return;
  int j = p + 1, idx = 0;
  while (j < n && s[j] != ']' && idx < count) {
    if (s[j] == '-' || s[j] == '.' || (s[j] >= '0' && s[j] <= '9')) {
      int k = j;
      while (k < n && (s[k]=='-'||s[k]=='+'||s[k]=='.'||s[k]=='e'||s[k]=='E'||(s[k]>='0'&&s[k]<='9'))) k++;
      std::string tok(s + j, s + k); out[idx++] = (float)std::strtod(tok.c_str(), nullptr); j = k;
    } else j++;
  }
}

// Normalize a BCP-47-ish language tag to the CJK script bucket used to pick a
// regional fallback face: "ja", "ko", "zh-hant" (TW/HK/MO/Hant), "zh-hans"
// (CN/SG/Hans/bare zh), or "" (no CJK regional preference). Used identically for
// face tags and run languages so matching is plain string equality.
static std::string langScript(const std::string& lang) {
  std::string s;
  for (char c : lang) s.push_back((char)std::tolower((unsigned char)c));
  if (s.rfind("ja", 0) == 0) return "ja";
  if (s.rfind("ko", 0) == 0) return "ko";
  if (s.rfind("zh-hant", 0) == 0 || s.rfind("zh-tw", 0) == 0 ||
      s.rfind("zh-hk", 0) == 0 || s.rfind("zh-mo", 0) == 0) return "zh-hant";
  if (s.rfind("zh", 0) == 0) return "zh-hans";
  return "";
}

// Read a JSON boolean (true/false or 1/0) for `key`; `fallback` if absent.
static bool readBool(const char* s, int n, const char* key, bool fallback) {
  int p = findField(s, n, key);
  if (p < 0 || p >= n) return fallback;
  char c = s[p];
  if (c == 't' || c == 'T' || c == '1') return true;
  if (c == 'f' || c == 'F' || c == '0') return false;
  return fallback;
}

// Canonical face-registry key for a (family, weight, italic) style. MUST stay
// byte-identical to faceKey() in web/src/font-access.ts so the host registers a
// resolved face under exactly the key the engine looks up. Regular (weight 400,
// upright) keeps the bare family name (back-compat + the common case).
static std::string faceKey(const std::string& family, int weight, bool italic) {
  if (family.empty()) return std::string();
  if (weight == 400 && !italic) return family;
  std::string k = family;
  k.push_back('\x01');
  k += std::to_string(weight);
  if (italic) k.push_back('i');
  return k;
}

// A styled run: a byte range [b0, b1) of the text with its size, color, the
// resolved faceId (0 = primary font; >0 = a host-registered named family), and
// the normalized CJK script (for regional Han fallback selection).
struct Run { int b0, b1; float size; float r, g, b, a; int face; std::string lang; };

// Parse the spec's "runs" array. Each run = {start, len, size_px, rgba, family,
// weight, italic, lang}. `family` resolves to a faceId via `faceByName`; `lang`
// (run-level, else `docLang`) selects the regional fallback for shared Han.
// Falls back to a single default run covering all text when absent.
static std::vector<Run> parseRuns(const char* s, int n, float defSize,
                                  const std::unordered_map<std::string, int>& faceByName,
                                  const std::string& docLang) {
  auto resolveFace = [&](const char* sub, int sl) -> int {
    int fp = findField(sub, sl, "family");
    std::string fam;
    if (!(fp >= 0 && readString(sub, sl, fp, fam)) || fam.empty()) return 0;
    int  weight = (int)readNumber(sub, sl, "weight", 400.0f);
    bool italic = readBool(sub, sl, "italic", false);
    // Prefer the exact styled face, then the family's regular face, then the
    // primary font — so a bold/italic run degrades gracefully when only the
    // regular face is registered.
    auto it = faceByName.find(faceKey(fam, weight, italic));
    if (it != faceByName.end()) return it->second;
    auto rit = faceByName.find(fam);
    if (rit != faceByName.end()) return rit->second;
    return 0;
  };
  auto resolveLang = [&](const char* sub, int sl) -> std::string {
    int lp = findField(sub, sl, "lang");
    std::string lg;
    if (lp >= 0 && readString(sub, sl, lp, lg) && !lg.empty()) return langScript(lg);
    return docLang;  // already normalized
  };
  std::vector<Run> runs;
  int p = findField(s, n, "runs");
  if (p >= 0 && p < n && s[p] == '[') {
    int j = p + 1;
    while (j < n && s[j] != ']') {
      if (s[j] != '{') { j++; continue; }
      int depth = 1, os = j; j++;
      while (j < n && depth > 0) { if (s[j] == '{') depth++; else if (s[j] == '}') depth--; j++; }
      const char* sub = s + os; int sl = j - os;
      int start = (int)readNumber(sub, sl, "start", 0.0f);
      float flen = readNumber(sub, sl, "len", -1.0f);
      float size = readNumber(sub, sl, "size_px", defSize);
      float rgba[4] = {1, 1, 1, 1}; readFloatArray(sub, sl, "rgba", rgba, 4);
      runs.push_back({start, flen < 0 ? INT_MAX : start + (int)flen, size,
                      rgba[0], rgba[1], rgba[2], rgba[3], resolveFace(sub, sl), resolveLang(sub, sl)});
    }
  }
  if (runs.empty()) runs.push_back({0, INT_MAX, defSize, 1, 1, 1, 1, 0, docLang});
  return runs;
}

// ---- msdfgen Shape builder from a FreeType outline -------------------------
namespace {
struct ShapeBuilder {
  msdfgen::Shape* shape = nullptr; msdfgen::Contour* contour = nullptr; msdfgen::Point2 cur{};
  static msdfgen::Point2 pt(const FT_Vector* v) { return msdfgen::Point2((double)v->x, (double)v->y); }
};
int sbMove(const FT_Vector* to, void* u){ auto*b=(ShapeBuilder*)u; b->contour=&b->shape->addContour(); b->cur=ShapeBuilder::pt(to); return 0; }
int sbLine(const FT_Vector* to, void* u){ auto*b=(ShapeBuilder*)u; auto e=ShapeBuilder::pt(to); b->contour->addEdge(msdfgen::EdgeHolder(b->cur,e)); b->cur=e; return 0; }
int sbConic(const FT_Vector* c,const FT_Vector* to,void* u){ auto*b=(ShapeBuilder*)u; auto e=ShapeBuilder::pt(to); b->contour->addEdge(msdfgen::EdgeHolder(b->cur,ShapeBuilder::pt(c),e)); b->cur=e; return 0; }
int sbCubic(const FT_Vector* c1,const FT_Vector* c2,const FT_Vector* to,void* u){ auto*b=(ShapeBuilder*)u; auto e=ShapeBuilder::pt(to); b->contour->addEdge(msdfgen::EdgeHolder(b->cur,ShapeBuilder::pt(c1),ShapeBuilder::pt(c2),e)); b->cur=e; return 0; }
} // namespace

// Per-glyph cache entry. Plane bounds are in EM units (relative to the pen
// origin on the baseline, y-up); the layout scales them by the font size.
struct GlyphInfo {
  float u0=0,v0=0,u1=0,v1=0;          // atlas-page uv rect
  float planeL=0,planeB=0,planeR=0,planeT=0;  // em units, y-up
  float advance=0;                    // em units
  int   page=0;                       // atlas-array layer holding this glyph
  bool  has_msdf=false;               // false for whitespace/empty glyphs
};

struct LayoutData {
  std::vector<GlyphQuad> quads;
  Metrics metrics;
};

// One registered font face. Plane bounds / advances are normalized to em units
// per face (using its own units_per_em), so a glyph quad is face-independent
// once generated and the shared atlas can mix faces freely.
struct Face {
  std::vector<unsigned char> bytes;
  FT_Face ft = nullptr;
  int   units_per_em = 1000;
  float ascender_em = 0.8f, descender_em = -0.2f;
  std::string lang;   // normalized CJK script tag for fallback faces ("" = none)
};

// One atlas page: a PAGE_W×PAGE_H RGBA8 image whose glyphs are all rasterized at
// `refPx`, shelf-packed. Pages of the same refPx form a class; a new page is
// added when the current one fills.
struct Page {
  std::vector<uint8_t> rgba;
  int refPx;
  int shelf_x = 0, shelf_y = 0, shelf_h = 0;
  bool dirty = true;
  explicit Page(int ref) : rgba((size_t)PAGE_W * PAGE_H * 4, 0), refPx(ref) {}
};

struct Engine::Impl {
  FT_Library lib = nullptr;
  std::vector<Face> faces;                         // face 0 = primary (setFont)
  std::unordered_map<std::string, int> faceByName; // family name → faceId (>0)
  std::vector<int> fallbackFaces;                  // ordered chain for missing codepoints
  std::string defaultLang;                         // system locale → regional Han default
  bool  font_loaded = false;

  std::vector<Page> pages;        // atlas pages (texture-array layers)
  // Glyph cache keyed by (faceId, FT glyph index) so faces never collide.
  std::unordered_map<uint64_t, GlyphInfo> glyphs;

  std::unordered_map<int, LayoutData> layouts;
  int next_id = 1;

  Impl() {}

  void resetAtlas() {
    pages.clear();
    glyphs.clear();
  }
  void clearFaces() {
    for (Face& f : faces) if (f.ft) FT_Done_Face(f.ft);
    faces.clear();
    faceByName.clear();
    fallbackFaces.clear();
  }

  // Glyph index for `cp` in `preferFace`, else a fallback face; writes the
  // resolved face + index. Two-pass over the chain: first only faces tagged with
  // the run's `lang` (so shared Han renders in the right regional form — e.g. a
  // ja run takes the JP face), then the rest in chain order. Returns false only
  // if nothing covers it (caller renders preferFace's .notdef).
  bool resolveCodepoint(unsigned cp, int preferFace, const std::string& lang,
                        int& outFace, uint32_t& outGi) {
    outFace = preferFace;
    outGi = FT_Get_Char_Index(faces[preferFace].ft, cp);
    if (outGi != 0) return true;
    for (int pass = 0; pass < 2; pass++) {
      // pass 0: only lang-matching faces (skipped when the run has no lang).
      if (pass == 0 && lang.empty()) continue;
      for (int fb : fallbackFaces) {
        if (fb == preferFace || fb < 0 || fb >= (int)faces.size()) continue;
        bool match = !lang.empty() && faces[fb].lang == lang;
        if (pass == 0 ? !match : match) continue;
        uint32_t g = FT_Get_Char_Index(faces[fb].ft, cp);
        if (g != 0) { outFace = fb; outGi = g; return true; }
      }
    }
    return false;  // no coverage → .notdef of preferFace
  }

  static uint64_t gkey(int faceId, uint32_t gi) { return ((uint64_t)faceId << 32) | gi; }
  const GlyphInfo* ensureGlyph(int faceId, uint32_t gi, unsigned cp);

  // Shelf-pack a tileW×tileH tile onto a page of class `refPx` (creating a new
  // page if the current one is full), leaving a GAP gutter. Returns the page
  // index and top-left (x,y), or -1 if the tile can't fit a page at all.
  int allocTile(int refPx, int tileW, int tileH, int& outX, int& outY) {
    // Find the most recent page of this class; else start a fresh one.
    int pi = -1;
    for (int i = (int)pages.size() - 1; i >= 0; i--)
      if (pages[i].refPx == refPx) { pi = i; break; }
    for (int attempt = 0; attempt < 2; attempt++) {
      if (pi < 0) { pages.emplace_back(refPx); pi = (int)pages.size() - 1; }
      Page& pg = pages[pi];
      if (pg.shelf_x + tileW > PAGE_W) { pg.shelf_y += pg.shelf_h + GAP; pg.shelf_x = 0; pg.shelf_h = 0; }
      if (pg.shelf_y + tileH <= PAGE_H) {
        if (tileH > pg.shelf_h) pg.shelf_h = tileH;
        outX = pg.shelf_x; outY = pg.shelf_y;
        pg.shelf_x += tileW + GAP;
        return pi;
      }
      pi = -1;  // page full → new page on the next attempt
    }
    return -1;  // tile larger than a page
  }
};

const GlyphInfo* Engine::Impl::ensureGlyph(int faceId, uint32_t gi, unsigned cp) {
  uint64_t key = gkey(faceId, gi);
  auto it = glyphs.find(key);
  if (it != glyphs.end()) return &it->second;

  Face& fc = faces[faceId];
  FT_Face face = fc.ft;
  int units_per_em = fc.units_per_em;

  GlyphInfo info;
  if (FT_Load_Glyph(face, gi, FT_LOAD_NO_SCALE | FT_LOAD_NO_HINTING)) {
    glyphs.emplace(key, info); return &glyphs[key];
  }
  info.advance = (float)(face->glyph->metrics.horiAdvance) / (float)units_per_em;

  msdfgen::Shape shape; ShapeBuilder b; b.shape = &shape;
  FT_Outline_Funcs funcs = { sbMove, sbLine, sbConic, sbCubic, 0, 0 };
  FT_Outline_Decompose(&face->glyph->outline, &funcs, &b);
  shape.normalize();

  if (shape.contours.empty()) {           // whitespace / empty glyph: advance only
    glyphs.emplace(key, info); return &glyphs[key];
  }

  // Resolution class for this codepoint (CJK → high-res page).
  int refPx = refPxForCodepoint(cp);
  double pxPerUnit = (double)refPx / (double)units_per_em;
  msdfgen::Shape::Bounds bnds = shape.getBounds();
  int gw = (int)std::ceil((bnds.r - bnds.l) * pxPerUnit);
  int gh = (int)std::ceil((bnds.t - bnds.b) * pxPerUnit);
  int tileW = gw + 2 * PAD, tileH = gh + 2 * PAD;
  if (tileW > PAGE_W) tileW = PAGE_W;
  if (tileH > PAGE_H) tileH = PAGE_H;

  int px, py;
  int page = allocTile(refPx, tileW, tileH, px, py);
  if (page < 0) { glyphs.emplace(key, info); return &glyphs[key]; }  // can't fit → advance-only

  // Generate MSDF into a tile. Projection maps font-unit shape → tile px:
  //   tile_px = (shapeCoord + translate) * scale ; with PAD px margin.
  double s = pxPerUnit;
  msdfgen::Vector2 translate(-bnds.l + PAD / s, -bnds.b + PAD / s);
  msdfgen::edgeColoringSimple(shape, 3.0);
  msdfgen::Bitmap<float, 3> bmp(tileW, tileH);
  // Default error correction (EDGE_PRIORITY) — the recommended mode for crisp
  // text. Each page is sampled BILINEARLY on the GPU (linear-filtered texture
  // array), which is what makes MSDF smooth and corner-sharp at any scale.
  msdfgen::generateMSDF(bmp, shape, msdfgen::Range(RANGE_PX / s),
                        msdfgen::Vector2(s, s), translate);

  // Copy into the page (y-flip: msdfgen y-up → page y-down).
  uint8_t* atlas = pages[page].rgba.data();
  auto toByte = [](float v){ v = v<0?0:(v>1?1:v); return (uint8_t)(v*255.0f+0.5f); };
  for (int y = 0; y < tileH; y++) {
    for (int x = 0; x < tileW; x++) {
      const float* p = bmp(x, tileH - 1 - y);
      uint8_t* d = &atlas[((size_t)(py + y) * PAGE_W + (px + x)) * 4];
      d[0] = toByte(p[0]); d[1] = toByte(p[1]); d[2] = toByte(p[2]); d[3] = 255;
    }
  }

  info.page = page;
  info.u0 = (float)px / PAGE_W; info.v0 = (float)py / PAGE_H;
  info.u1 = (float)(px + tileW) / PAGE_W; info.v1 = (float)(py + tileH) / PAGE_H;
  // Plane bounds (em units, y-up): the tile spans [bnds.l - PAD/s, bnds.r + PAD/s] etc.
  double upem = (double)units_per_em;
  info.planeL = (float)((bnds.l - PAD / s) / upem);
  info.planeR = (float)((bnds.r + PAD / s) / upem);
  info.planeB = (float)((bnds.b - PAD / s) / upem);
  info.planeT = (float)((bnds.t + PAD / s) / upem);
  info.has_msdf = true;

  pages[page].dirty = true;
  glyphs.emplace(key, info);
  return &glyphs[key];
}

Engine::Engine() : impl_(new Impl()) {}
Engine::~Engine() {
  impl_->clearFaces();
  if (impl_->lib) FT_Done_FreeType(impl_->lib);
  delete impl_;
}
Engine& Engine::instance() { static Engine e; return e; }

// Open an sfnt face from owned bytes; fills the per-face metrics. Returns false
// (and leaves fc.ft null) on FreeType rejection.
static bool openFace(FT_Library lib, Face& fc) {
  if (FT_New_Memory_Face(lib, fc.bytes.data(), (FT_Long)fc.bytes.size(), 0, &fc.ft)) {
    fc.ft = nullptr; return false;
  }
  fc.units_per_em = fc.ft->units_per_EM ? fc.ft->units_per_EM : 1000;
  fc.ascender_em  = (float)fc.ft->ascender / fc.units_per_em;
  fc.descender_em = (float)fc.ft->descender / fc.units_per_em;
  return true;
}

bool Engine::setFont(const uint8_t* bytes, int len) {
  if (!bytes || len <= 0) return false;
  if (!impl_->lib && FT_Init_FreeType(&impl_->lib)) return false;
  // Installing a new primary font resets the whole registry + atlas: existing
  // named faces and packed glyphs no longer have a stable place.
  impl_->clearFaces();
  Face fc;
  fc.bytes.assign(bytes, bytes + len);
  if (!openFace(impl_->lib, fc)) { impl_->font_loaded = false; return false; }
  impl_->faces.push_back(std::move(fc));   // faceId 0 = primary
  impl_->font_loaded = true;
  impl_->resetAtlas();
  impl_->layouts.clear();
  return true;
}
bool Engine::hasFont() const { return impl_->font_loaded; }

int Engine::addFont(const char* name, int name_len, const uint8_t* bytes, int len) {
  if (!impl_->font_loaded || !bytes || len <= 0) return -1;  // need a primary first
  std::string key = (name && name_len > 0) ? std::string(name, name_len) : std::string();
  if (!key.empty()) {
    auto it = impl_->faceByName.find(key);
    if (it != impl_->faceByName.end()) return it->second;    // idempotent
  }
  Face fc;
  fc.bytes.assign(bytes, bytes + len);
  if (!openFace(impl_->lib, fc)) return -1;
  int id = (int)impl_->faces.size();
  impl_->faces.push_back(std::move(fc));
  if (!key.empty()) impl_->faceByName[key] = id;
  return id;
}

bool Engine::hasFontNamed(const char* name, int name_len) const {
  if (!name || name_len <= 0) return false;
  return impl_->faceByName.count(std::string(name, name_len)) != 0;
}

int Engine::addFallbackFont(const uint8_t* bytes, int len, const char* lang, int lang_len) {
  if (!impl_->font_loaded || !bytes || len <= 0) return -1;
  Face fc;
  fc.bytes.assign(bytes, bytes + len);
  if (!openFace(impl_->lib, fc)) return -1;
  if (lang && lang_len > 0) fc.lang = langScript(std::string(lang, lang_len));
  int id = (int)impl_->faces.size();
  impl_->faces.push_back(std::move(fc));
  impl_->fallbackFaces.push_back(id);
  return id;
}

void Engine::setDefaultLang(const char* lang, int lang_len) {
  impl_->defaultLang = (lang && lang_len > 0) ? langScript(std::string(lang, lang_len)) : std::string();
}

int Engine::layout(const char* spec_json, int len) {
  if (!spec_json || len <= 0 || !impl_->font_loaded) return 0;

  std::string text;
  int tp = findField(spec_json, len, "text");
  if (tp >= 0) readString(spec_json, len, tp, text);
  float defSize   = readNumber(spec_json, len, "size_px", 48.0f);
  float max_width = readNumber(spec_json, len, "max_width_px", 0.0f);
  float line_sp   = readNumber(spec_json, len, "line_spacing", 1.2f);
  // Document-level language: spec "lang" (in constraints or top-level) overrides
  // the engine default (system locale); runs may override per-run.
  std::string docLang = impl_->defaultLang;
  { int lp = findField(spec_json, len, "lang"); std::string lg;
    if (lp >= 0 && readString(spec_json, len, lp, lg) && !lg.empty()) docLang = langScript(lg); }
  std::vector<Run> runs = parseRuns(spec_json, len, defSize, impl_->faceByName, docLang);

  LayoutData ld;
  float maxLineW = 0, totalH = 0, firstBaseline = -1;
  int lines = 0;

  // A glyph with its own run style. Layout buffers a line (baseline TBD), so
  // mixed sizes align on a shared baseline = lineTop + maxAscent on the line.
  struct SG { float size; float r, g, b, a; const GlyphInfo* info; int face; };
  std::vector<SG> word; float wordW = 0;                 // current word (for wrap)
  struct LG { float x; SG g; };
  std::vector<LG> lineGlyphs;                            // glyphs placed on the current line
  float penX = 0, lineMaxAscent = 0, lineMaxHeight = 0;

  auto runFor = [&](int off) -> const Run& {
    for (const Run& r : runs) if (off >= r.b0 && off < r.b1) return r;
    return runs.back();
  };
  // Line ascent/height take the tallest contributing run, using that run's own
  // face ascender so mixed faces (and sizes) share a correct baseline.
  auto bumpLineMetrics = [&](float size, int faceId) {
    float asc = impl_->faces[faceId].ascender_em * size, lh = size * line_sp;
    if (asc > lineMaxAscent) lineMaxAscent = asc;
    if (lh > lineMaxHeight)  lineMaxHeight = lh;
  };
  auto finalizeLine = [&]() {
    if (penX > maxLineW) maxLineW = penX;
    float baseline = totalH + lineMaxAscent;
    if (firstBaseline < 0) firstBaseline = baseline;
    for (const LG& lg : lineGlyphs) {
      const GlyphInfo* gi = lg.g.info;
      if (!gi->has_msdf) continue;
      float sz = lg.g.size;
      GlyphQuad q;
      q.x = lg.x + gi->planeL * sz;
      q.w = (gi->planeR - gi->planeL) * sz;
      q.y = baseline - gi->planeT * sz;
      q.h = (gi->planeT - gi->planeB) * sz;
      q.u0 = gi->u0; q.v0 = gi->v0; q.u1 = gi->u1; q.v1 = gi->v1;
      q.r = lg.g.r; q.g = lg.g.g; q.b = lg.g.b; q.a = lg.g.a;
      q.page = (float)gi->page; q._r0 = q._r1 = q._r2 = 0.0f;
      ld.quads.push_back(q);
    }
    totalH += lineMaxHeight > 0 ? lineMaxHeight : defSize * line_sp;
    lines++;
    lineGlyphs.clear(); penX = 0; lineMaxAscent = 0; lineMaxHeight = 0;
  };
  auto flushWord = [&]() {
    if (word.empty()) return;
    if (max_width > 0 && penX > 0 && penX + wordW > max_width) finalizeLine();
    for (const SG& g : word) {
      bumpLineMetrics(g.size, g.face);
      lineGlyphs.push_back({penX, g});
      penX += g.info->advance * g.size;
    }
    word.clear(); wordW = 0;
  };

  // UAX#14 break opportunities (libunibreak): brks[b] is the break status after
  // the character whose last byte is b — MUSTBREAK / ALLOWBREAK / NOBREAK. This
  // is what lets CJK (which has no spaces) wrap between ideographs while keeping
  // Latin words intact. Whitespace/newline keep their existing handling; this
  // only adds break points after non-space characters (CJK, hyphens, …).
  std::vector<char> brks(text.size());
  if (!text.empty())
    set_linebreaks_utf8((const utf8_t*)text.data(), text.size(), "", brks.data());

  for (int i = 0; i < (int)text.size();) {
    int byteStart = i;
    unsigned cp; i = decodeUTF8(text, i, cp);
    const Run& r = runFor(byteStart);
    if (cp == '\n') { flushWord(); finalizeLine(); continue; }
    // Resolve via the run's face, falling through the fallback chain (CJK etc.),
    // preferring the run's language for regional Han.
    int faceId; uint32_t gi;
    impl_->resolveCodepoint(cp, r.face, r.lang, faceId, gi);
    const GlyphInfo* info = impl_->ensureGlyph(faceId, gi, cp);
    if (cp == ' ') {
      flushWord();
      float adv = info->advance * r.size;
      if (max_width > 0 && penX > 0 && penX + adv > max_width) { finalizeLine(); }
      else { bumpLineMetrics(r.size, faceId); penX += adv; }
      continue;
    }
    word.push_back({r.size, r.r, r.g, r.b, r.a, info, faceId}); wordW += info->advance * r.size;
    // End the segment at an allowed break (the last byte of this char is i-1),
    // so the next segment can wrap onto a new line independently.
    char br = (i >= 1 && i <= (int)brks.size()) ? brks[i - 1] : (char)LINEBREAK_NOBREAK;
    if (br == LINEBREAK_ALLOWBREAK || br == LINEBREAK_MUSTBREAK) flushWord();
  }
  flushWord();
  // Finalize the trailing line — unless the text ended exactly on a newline
  // (no pending glyphs) so we don't emit a spurious empty line.
  if (!lineGlyphs.empty() || penX > 0 || lines == 0) finalizeLine();

  ld.metrics.width          = maxLineW;
  ld.metrics.height         = totalH;
  ld.metrics.line_count     = lines;
  ld.metrics.first_baseline = firstBaseline < 0 ? 0 : firstBaseline;
  ld.metrics.glyph_count    = (int)ld.quads.size();
  ld.metrics.atlas_kind     = (int)AtlasKind::MSDF;
  ld.metrics.atlas_px_range = (float)RANGE_PX;

  int id = impl_->next_id++;
  impl_->layouts.emplace(id, std::move(ld));
  return id;
}

bool Engine::measure(int id, Metrics& out) const {
  auto it = impl_->layouts.find(id);
  if (it == impl_->layouts.end()) return false;
  out = it->second.metrics; return true;
}
int Engine::glyphCount(int id) const {
  auto it = impl_->layouts.find(id);
  return it == impl_->layouts.end() ? 0 : (int)it->second.quads.size();
}
int Engine::glyphs(int id, GlyphQuad* out, int max_count) const {
  auto it = impl_->layouts.find(id);
  if (it == impl_->layouts.end() || !out || max_count <= 0) return 0;
  int n = (int)it->second.quads.size(); if (n > max_count) n = max_count;
  std::memcpy(out, it->second.quads.data(), (size_t)n * sizeof(GlyphQuad));
  return n;
}
void Engine::release(int id) { impl_->layouts.erase(id); }

// Bilinearly sample one channel of a page (clamp-to-edge), matching GPU linear
// filtering: texel centers at (i+0.5)/dim.
static inline float texel(const uint8_t* page, int x, int y, int ch) {
  if (x < 0) x = 0; if (x >= PAGE_W) x = PAGE_W - 1;
  if (y < 0) y = 0; if (y >= PAGE_H) y = PAGE_H - 1;
  return page[((size_t)y * PAGE_W + x) * 4 + ch] / 255.0f;
}
// MSDF median of the BILINEARLY-interpolated page, with screenPxRange AA.
// Bilinear is what makes MSDF scale-independent (interpolating the distance
// field reconstructs smooth, corner-sharp edges at any magnification); the
// GPU compositor samples the same page as a linear-filtered texture-array layer.
static float msdfCoverage(const uint8_t* page, float au, float av, float screenPxRange) {
  float fx = au * PAGE_W - 0.5f, fy = av * PAGE_H - 0.5f;
  int x0 = (int)std::floor(fx), y0 = (int)std::floor(fy);
  float tx = fx - x0, ty = fy - y0;
  float chan[3];
  for (int c = 0; c < 3; c++) {
    float a = texel(page, x0, y0, c),     b = texel(page, x0 + 1, y0, c);
    float d = texel(page, x0, y0 + 1, c), e = texel(page, x0 + 1, y0 + 1, c);
    chan[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
  }
  float med = std::max(std::min(chan[0], chan[1]), std::min(std::max(chan[0], chan[1]), chan[2]));
  float dist = screenPxRange * (med - 0.5f) + 0.5f;
  return dist < 0 ? 0 : (dist > 1 ? 1 : dist);
}

bool Engine::rasterize(int id, int outW, int outH, float originX, float originY,
                       const uint8_t* bg, uint8_t* out) const {
  auto it = impl_->layouts.find(id);
  if (it == impl_->layouts.end() || !out || outW <= 0 || outH <= 0) return false;
  size_t bytes = (size_t)outW * outH * 4;
  if (bg) std::memcpy(out, bg, bytes);
  else for (size_t i = 0; i < bytes; i += 4) { out[i]=out[i+1]=out[i+2]=0; out[i+3]=255; }

  bool msdf = it->second.metrics.atlas_kind == (int)AtlasKind::MSDF;
  float pxRange = it->second.metrics.atlas_px_range;
  int pageCount = (int)impl_->pages.size();

  for (const GlyphQuad& q : it->second.quads) {
    int pageIdx = (int)q.page;
    if (pageIdx < 0 || pageIdx >= pageCount) continue;
    const uint8_t* atlas = impl_->pages[pageIdx].rgba.data();
    int x0 = (int)(q.x + originX), y0 = (int)(q.y + originY);
    int x1 = (int)(q.x + originX + q.w), y1 = (int)(q.y + originY + q.h);
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 > outW) x1 = outW; if (y1 > outH) y1 = outH;
    float tileH_px = (q.v1 - q.v0) * PAGE_H;
    float screenPxRange = (msdf && tileH_px > 0) ? pxRange * q.h / tileH_px : 1.0f;

    for (int py = y0; py < y1; py++) {
      for (int px = x0; px < x1; px++) {
        float lu = (px + 0.5f - (q.x + originX)) / q.w;
        float lv = (py + 0.5f - (q.y + originY)) / q.h;
        float au = q.u0 + lu * (q.u1 - q.u0);
        float av = q.v0 + lv * (q.v1 - q.v0);
        float cov;
        if (msdf) {
          cov = msdfCoverage(atlas, au, av, screenPxRange);
        } else {
          int tx = (int)(au * PAGE_W), ty = (int)(av * PAGE_H);
          if (tx < 0) tx = 0; if (tx >= PAGE_W) tx = PAGE_W - 1;
          if (ty < 0) ty = 0; if (ty >= PAGE_H) ty = PAGE_H - 1;
          cov = atlas[((size_t)ty * PAGE_W + tx) * 4 + 3] / 255.0f;
        }
        float a = cov * q.a;
        if (a <= 0.0f) continue;
        uint8_t* d = &out[((size_t)py * outW + px) * 4];
        float inv = 1.0f - a;
        d[0]=(uint8_t)(q.r*255.0f*a + d[0]*inv + 0.5f);
        d[1]=(uint8_t)(q.g*255.0f*a + d[1]*inv + 0.5f);
        d[2]=(uint8_t)(q.b*255.0f*a + d[2]*inv + 0.5f);
        d[3]=(uint8_t)(a*255.0f + d[3]*inv + 0.5f);
      }
    }
  }
  return true;
}

int Engine::atlasWidth() const  { return PAGE_W; }
int Engine::atlasHeight() const { return PAGE_H; }
int Engine::atlasPageCount() const { return (int)impl_->pages.size(); }
const uint8_t* Engine::atlasPagePixels(int page) const {
  return (page >= 0 && page < (int)impl_->pages.size()) ? impl_->pages[page].rgba.data() : nullptr;
}

bool Engine::nextDirtyRegion(AtlasRegion& out) {
  for (int i = 0; i < (int)impl_->pages.size(); i++) {
    if (impl_->pages[i].dirty) {
      impl_->pages[i].dirty = false;   // full-page upload (sub-rect packing is a later optimization)
      out = AtlasRegion{i, 0, 0, PAGE_W, PAGE_H, impl_->pages[i].rgba.data()};
      return true;
    }
  }
  return false;
}

} // namespace text_engine
