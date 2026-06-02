/*
 * text_engine.cpp — Phase 0 STUB implementation of the shared text engine.
 *
 * Renders one solid box glyph per Unicode codepoint into a tiny alpha-coverage
 * atlas and lays the boxes out left-to-right with naive wrapping. This exists
 * only to prove the JSON-in / atlas-and-geometry-out pipeline end to end and to
 * stand up the native↔wasm byte-parity harness BEFORE the heavy FreeType +
 * msdfgen + HarfBuzz machinery lands (Phase 1+).
 *
 * No GPU calls. No wall-clock, RNG, or threads — output is a deterministic
 * function of the spec, so the native build and text_engine.wasm produce
 * byte-identical atlas + geometry + metrics.
 *
 * Compiles under both native clang and wasm32-wasip1 (-fno-exceptions
 * -fno-rtti): uses only std containers, no throw/try, no RTTI.
 */

#include "text_engine.h"

#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

namespace text_engine {

// ---- Stub atlas geometry ----------------------------------------------------
static constexpr int ATLAS_W   = 256;
static constexpr int ATLAS_H   = 256;
static constexpr int CELL      = 32;   // one box glyph occupies a 32x32 cell at (0,0)
static constexpr int BOX_INSET = 3;    // transparent margin inside the cell

// ---- Minimal, exception-free JSON field extraction --------------------------
// NOT a general parser — just enough to read our own emitted spec. Phase 1
// replaces this with a real no-exception JSON parser (spec_json.cpp).

// Find the value position just after `"key":` at object depth (ignores nesting
// niceties; fine for our flat spec). Returns -1 if not found.
static int findField(const char* s, int n, const char* key) {
  std::string pat = "\"";
  pat += key;
  pat += "\"";
  int klen = (int)pat.size();
  for (int i = 0; i + klen <= n; i++) {
    if (std::memcmp(s + i, pat.data(), klen) == 0) {
      int j = i + klen;
      while (j < n && (s[j] == ' ' || s[j] == '\t')) j++;
      if (j < n && s[j] == ':') {
        j++;
        while (j < n && (s[j] == ' ' || s[j] == '\t')) j++;
        return j;
      }
    }
  }
  return -1;
}

// Read a JSON string value at position `p` (must point at the opening quote)
// into `out`, handling \" \\ \n \t escapes. Returns false if not a string.
static bool readString(const char* s, int n, int p, std::string& out) {
  if (p < 0 || p >= n || s[p] != '"') return false;
  out.clear();
  int j = p + 1;
  while (j < n && s[j] != '"') {
    char c = s[j];
    if (c == '\\' && j + 1 < n) {
      char e = s[j + 1];
      switch (e) {
        case 'n': out.push_back('\n'); break;
        case 't': out.push_back('\t'); break;
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        default: out.push_back(e); break;  // (unicode \u escapes deferred to Phase 1)
      }
      j += 2;
    } else {
      out.push_back(c);
      j++;
    }
  }
  return true;
}

static float readNumber(const char* s, int n, const char* key, float fallback) {
  int p = findField(s, n, key);
  if (p < 0 || p >= n) return fallback;
  char* end = nullptr;
  // strtod needs a NUL-terminated region; the spec buffer isn't guaranteed
  // terminated, so copy the numeric token out first.
  int j = p;
  while (j < n && (s[j] == '-' || s[j] == '+' || s[j] == '.' ||
                   s[j] == 'e' || s[j] == 'E' || (s[j] >= '0' && s[j] <= '9'))) j++;
  std::string tok(s + p, s + j);
  double v = std::strtod(tok.c_str(), &end);
  if (end == tok.c_str()) return fallback;
  return (float)v;
}

// Advance past one UTF-8 codepoint starting at byte `i`; returns the next byte
// index. (Validation is lenient — malformed bytes advance by 1.)
static int nextCodepoint(const std::string& t, int i) {
  unsigned char c = (unsigned char)t[i];
  if (c < 0x80) return i + 1;
  if ((c >> 5) == 0x6) return i + 2 <= (int)t.size() ? i + 2 : i + 1;
  if ((c >> 4) == 0xE) return i + 3 <= (int)t.size() ? i + 3 : i + 1;
  if ((c >> 3) == 0x1E) return i + 4 <= (int)t.size() ? i + 4 : i + 1;
  return i + 1;
}

// ---- Engine state -----------------------------------------------------------
struct LayoutData {
  std::vector<GlyphQuad> quads;
  Metrics metrics;
};

struct Engine::Impl {
  std::vector<uint8_t> atlas;                       // ATLAS_W*ATLAS_H*4 RGBA8
  std::vector<AtlasRegion> dirty;                   // pending uploads
  std::unordered_map<int, LayoutData> layouts;
  int next_id = 1;
  bool box_drawn = false;

  Impl() : atlas((size_t)ATLAS_W * ATLAS_H * 4, 0) {}

  void ensureBox() {
    if (box_drawn) return;
    // Solid opaque white box, inset by BOX_INSET, in the (0,0) cell.
    for (int y = BOX_INSET; y < CELL - BOX_INSET; y++) {
      for (int x = BOX_INSET; x < CELL - BOX_INSET; x++) {
        uint8_t* px = &atlas[((size_t)y * ATLAS_W + x) * 4];
        px[0] = px[1] = px[2] = px[3] = 255;
      }
    }
    box_drawn = true;
    // Expose the FULL atlas as the dirty region so it honors the header's
    // tightly-packed (stride = w*4) contract — for a full-width region that's
    // exactly the master image. Phase 1's skyline packer will emit true
    // sub-rects (copied into a tight scratch buffer before queueing).
    AtlasRegion r{0, 0, ATLAS_W, ATLAS_H, atlas.data()};
    dirty.push_back(r);
  }
};

Engine::Engine() : impl_(new Impl()) {}
Engine::~Engine() { delete impl_; }

Engine& Engine::instance() {
  static Engine e;
  return e;
}

int Engine::layout(const char* spec_json, int len) {
  if (!spec_json || len <= 0) return 0;
  impl_->ensureBox();

  std::string text;
  int tp = findField(spec_json, len, "text");
  if (tp >= 0) readString(spec_json, len, tp, text);

  float size_px   = readNumber(spec_json, len, "size_px", 48.0f);
  float max_width = readNumber(spec_json, len, "max_width_px", 0.0f);
  float line_h    = size_px * 1.2f;

  // UV for the single stub box cell.
  const float u0 = 0.0f, v0 = 0.0f;
  const float u1 = (float)CELL / (float)ATLAS_W;
  const float v1 = (float)CELL / (float)ATLAS_H;

  LayoutData ld;
  float pen_x = 0.0f, pen_y = 0.0f, max_line_w = 0.0f;
  int lines = 1;
  const float advance = size_px;  // square cells for the stub

  for (int i = 0; i < (int)text.size();) {
    int j = nextCodepoint(text, i);
    bool is_newline = (text[i] == '\n');
    bool is_space   = (text[i] == ' ');

    if (is_newline) {
      if (pen_x > max_line_w) max_line_w = pen_x;
      pen_x = 0.0f; pen_y += line_h; lines++; i = j; continue;
    }
    if (max_width > 0.0f && pen_x + advance > max_width && pen_x > 0.0f) {
      if (pen_x > max_line_w) max_line_w = pen_x;
      pen_x = 0.0f; pen_y += line_h; lines++;
    }
    if (!is_space) {
      GlyphQuad q;
      q.x = pen_x; q.y = pen_y; q.w = advance; q.h = advance;
      q.u0 = u0; q.v0 = v0; q.u1 = u1; q.v1 = v1;
      q.r = q.g = q.b = q.a = 1.0f;  // white (stub ignores run colors)
      ld.quads.push_back(q);
    }
    pen_x += advance;
    i = j;
  }
  if (pen_x > max_line_w) max_line_w = pen_x;

  ld.metrics.width          = max_line_w;
  ld.metrics.height         = (float)lines * line_h;
  ld.metrics.line_count     = lines;
  ld.metrics.first_baseline = size_px;       // approximate ascent
  ld.metrics.glyph_count    = (int)ld.quads.size();
  ld.metrics.atlas_kind     = (int)AtlasKind::AlphaCoverage;
  ld.metrics.atlas_px_range = 0.0f;

  int id = impl_->next_id++;
  impl_->layouts.emplace(id, std::move(ld));
  return id;
}

bool Engine::measure(int layout_id, Metrics& out) const {
  auto it = impl_->layouts.find(layout_id);
  if (it == impl_->layouts.end()) return false;
  out = it->second.metrics;
  return true;
}

int Engine::glyphCount(int layout_id) const {
  auto it = impl_->layouts.find(layout_id);
  return it == impl_->layouts.end() ? 0 : (int)it->second.quads.size();
}

int Engine::glyphs(int layout_id, GlyphQuad* out, int max_count) const {
  auto it = impl_->layouts.find(layout_id);
  if (it == impl_->layouts.end() || !out || max_count <= 0) return 0;
  int n = (int)it->second.quads.size();
  if (n > max_count) n = max_count;
  std::memcpy(out, it->second.quads.data(), (size_t)n * sizeof(GlyphQuad));
  return n;
}

void Engine::release(int layout_id) {
  impl_->layouts.erase(layout_id);
}

bool Engine::rasterize(int layout_id, int outW, int outH,
                       float originX, float originY,
                       const uint8_t* bg, uint8_t* out) const {
  auto it = impl_->layouts.find(layout_id);
  if (it == impl_->layouts.end() || !out || outW <= 0 || outH <= 0) return false;

  // Initialize from bg (or opaque black).
  size_t bytes = (size_t)outW * outH * 4;
  if (bg) std::memcpy(out, bg, bytes);
  else {
    for (size_t i = 0; i < bytes; i += 4) {
      out[i] = out[i + 1] = out[i + 2] = 0; out[i + 3] = 255;
    }
  }

  const uint8_t* atlas = impl_->atlas.data();
  const int aw = ATLAS_W, ah = ATLAS_H;

  for (const GlyphQuad& q : it->second.quads) {
    // Device-pixel bounds of this glyph quad (clamped to the canvas).
    int x0 = (int)(q.x + originX);
    int y0 = (int)(q.y + originY);
    int x1 = (int)(q.x + originX + q.w);
    int y1 = (int)(q.y + originY + q.h);
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 > outW) x1 = outW; if (y1 > outH) y1 = outH;

    for (int py = y0; py < y1; py++) {
      for (int px = x0; px < x1; px++) {
        // Local uv within the quad → atlas uv → nearest texel (the stub atlas
        // is alpha-coverage; Phase 1 swaps in MSDF median + screenPxRange).
        float lu = (px + 0.5f - (q.x + originX)) / q.w;
        float lv = (py + 0.5f - (q.y + originY)) / q.h;
        float au = q.u0 + lu * (q.u1 - q.u0);
        float av = q.v0 + lv * (q.v1 - q.v0);
        int tx = (int)(au * aw); int ty = (int)(av * ah);
        if (tx < 0) tx = 0; if (tx >= aw) tx = aw - 1;
        if (ty < 0) ty = 0; if (ty >= ah) ty = ah - 1;
        float coverage = atlas[((size_t)ty * aw + tx) * 4 + 3] * (1.0f / 255.0f);
        float a = coverage * q.a;
        if (a <= 0.0f) continue;

        uint8_t* d = &out[((size_t)py * outW + px) * 4];
        float inv = 1.0f - a;
        d[0] = (uint8_t)(q.r * 255.0f * a + d[0] * inv + 0.5f);
        d[1] = (uint8_t)(q.g * 255.0f * a + d[1] * inv + 0.5f);
        d[2] = (uint8_t)(q.b * 255.0f * a + d[2] * inv + 0.5f);
        d[3] = (uint8_t)(a * 255.0f + d[3] * inv + 0.5f);
      }
    }
  }
  return true;
}

int Engine::atlasWidth() const  { return ATLAS_W; }
int Engine::atlasHeight() const { return ATLAS_H; }
const uint8_t* Engine::atlasPixels() const { return impl_->atlas.data(); }

bool Engine::nextDirtyRegion(AtlasRegion& out) {
  if (impl_->dirty.empty()) return false;
  out = impl_->dirty.back();
  impl_->dirty.pop_back();
  return true;
}

} // namespace text_engine
