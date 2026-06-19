/*
 * gen.text — text generator node.
 *
 * Renders multiline text into its output texture via the host `text.*` service
 * (FreeType + HarfBuzz + msdfgen live in the host, shared across effects). The
 * effect itself is tiny: it builds a JSON spec from its params, calls
 * text::layout, centers it, and calls text::render into the render target. No
 * shaders or GPU resources here — the host owns the MSDF atlas + compositor.
 *
 * Class-like instance ABI (v2): module_init() publishes the schema once; each
 * chain entry gets its own State via create().
 */

#include <gpu.h>
#include <host.h>
#include <module_api.h>

#include <cstdio>
#include <cstring>

namespace gen_text {

struct State {
  char  text[2048] = "Text";
  char  font[128] = "";       // OS/bundled family name ("" = host primary font)
  char  lang[16] = "";        // BCP-47 (ja/ko/zh-Hant/zh-Hans); "" = system locale
  bool  bold = false;         // selects the family's bold face (weight 700)
  bool  italic = false;       // selects the family's italic face
  float size = 64.0f;
  float r = 1.0f, g = 1.0f, b = 1.0f, a = 1.0f;
  float max_width = 0.0f;     // 0 = no wrap
  float line_spacing = 1.2f;
  bool  initialized = false;
};

// Append `src` to `dst` (at *pos, cap n) with JSON string escaping. ALL C0
// control chars must be escaped: a raw control byte (e.g. \r from CRLF / pasted
// text) is invalid inside a JSON string and the web's strict JSON.parse rejects
// the whole spec → blank render. (Native nlohmann is lenient and hid this.)
static void appendEscaped(char* dst, int& pos, int n, const char* src) {
  static const char kHex[] = "0123456789abcdef";
  for (int i = 0; src[i] && pos < n - 7; i++) {   // n-7 leaves room for \u00XX
    unsigned char c = (unsigned char)src[i];
    switch (c) {
      case '"':  dst[pos++]='\\'; dst[pos++]='"';  break;
      case '\\': dst[pos++]='\\'; dst[pos++]='\\'; break;
      case '\n': dst[pos++]='\\'; dst[pos++]='n';  break;
      case '\r': dst[pos++]='\\'; dst[pos++]='r';  break;
      case '\t': dst[pos++]='\\'; dst[pos++]='t';  break;
      case '\b': dst[pos++]='\\'; dst[pos++]='b';  break;
      case '\f': dst[pos++]='\\'; dst[pos++]='f';  break;
      default:
        if (c < 0x20) {                             // other control → \u00XX
          dst[pos++]='\\'; dst[pos++]='u'; dst[pos++]='0'; dst[pos++]='0';
          dst[pos++]=kHex[(c >> 4) & 0xF]; dst[pos++]=kHex[c & 0xF];
        } else {
          dst[pos++] = (char)c;                     // UTF-8 bytes pass through
        }
        break;
    }
  }
}

void module_init() {
  state::init("gen.text", {1, 0, 0},
    state::Schema()
      .textField  ("text",         "Text", state::PrimaryInput)
      .textField  ("font",         "",     state::PrimaryInput)
      .textField  ("lang",         "",     state::PrimaryInput)
      .boolField  ("bold",         false,  state::PrimaryInput)
      .boolField  ("italic",       false,  state::PrimaryInput)
      .floatField ("size",         64.0f,  8.0f, 512.0f, state::PrimaryInput)
      .rgbaField  ("color",        1.0f, 1.0f, 1.0f, 1.0f, state::PrimaryInput)
      .floatField ("max_width",    0.0f,   0.0f, 4096.0f, state::PrimaryInput)
      .floatField ("line_spacing", 1.2f,   0.5f, 3.0f,    state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)   // overlay text on this; transparent if unconnected
      .textureField("tex_out", state::PrimaryOutput)
  );
}

void* create() { return new State(); }
void  destroy(void* self) { delete static_cast<State*>(self); }
void  init(void* self) { auto* s = static_cast<State*>(self); if (s) s->initialized = true; }
void  tick(void*, double) {}
void  on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i]; int pl = len[i];
    if      (state::pathIs(p, pl, "text"))         state::patchString(i, s->text, sizeof(s->text));
    else if (state::pathIs(p, pl, "font"))         state::patchString(i, s->font, sizeof(s->font));
    else if (state::pathIs(p, pl, "lang"))         state::patchString(i, s->lang, sizeof(s->lang));
    else if (state::pathIs(p, pl, "bold"))         s->bold = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(p, pl, "italic"))       s->italic = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(p, pl, "size"))         s->size = state::patchFloat(i);
    else if (state::pathIs(p, pl, "max_width"))    s->max_width = state::patchFloat(i);
    else if (state::pathIs(p, pl, "line_spacing")) s->line_spacing = state::patchFloat(i);
    else if (state::pathIs(p, pl, "color")) {
      auto v = state::patchVec4(i); s->r=v.x; s->g=v.y; s->b=v.z; s->a=v.w;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  // Build the attributed-string JSON spec.
  char spec[4096];
  int pos = 0;
  pos += std::snprintf(spec + pos, sizeof(spec) - pos, "{\"text\":\"");
  appendEscaped(spec, pos, (int)sizeof(spec), s->text);
  pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\",");
  if (s->lang[0]) {   // override the system-locale default for regional Han forms
    pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\"lang\":\"");
    appendEscaped(spec, pos, (int)sizeof(spec), s->lang);
    pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\",");
  }
  pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\"runs\":[{");
  if (s->font[0]) {   // name a family → host resolves it (bundled / OS font),
    pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\"family\":\"");  // incl. bold/italic face
    appendEscaped(spec, pos, (int)sizeof(spec), s->font);
    pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\",\"weight\":%d,\"italic\":%s,",
                         s->bold ? 700 : 400, s->italic ? "true" : "false");
  }
  pos += std::snprintf(spec + pos, sizeof(spec) - pos,
      "\"size_px\":%.3f,\"rgba\":[%.4f,%.4f,%.4f,%.4f]}],"
      "\"constraints\":{\"max_width_px\":%.3f,\"line_spacing\":%.3f}}",
      s->size, s->r, s->g, s->b, s->a, s->max_width, s->line_spacing);

  // Output target: the executor binds our PrimaryOutput as the "tex_out" field
  // (same as every other effect). renderTarget() only works on a path that set
  // a swapchain surface — the sketch executor binds a texture field instead, so
  // prefer the field and fall back to the surface for standalone/test paths.
  int target = gpu::Device::textureForField("tex_out").id;
  if (target < 0) target = gpu::Device::renderTarget().id;
  // Overlay the text on the incoming texture (the host composites text over it);
  // an unconnected input is -1 → the host leaves transparency between glyphs.
  int bg = gpu::Device::textureForField("tex_in").id;

  int id = text::layout(spec, pos);
  if (id > 0) {
    // Center the laid-out text in the viewport.
    text::TextMetrics m;
    float ox = 0, oy = 0;
    if (text::measure(id, m)) {
      ox = (vp_w - m.width) * 0.5f;
      oy = (vp_h - m.height) * 0.5f;
    }
    char xform[96];
    std::snprintf(xform, sizeof(xform), "{\"x\":%.2f,\"y\":%.2f}", ox, oy);
    text::render(id, target, xform, bg);
    text::release(id);
  }
  gpu::Device::submit();
}

} // namespace gen_text

NANO_DECLARE_INSTANCE_EFFECT(gen_text)

// WASM module entry. Native bundles (NanoBarrel) register the effect via the
// gen_text:: namespace function pointers instead, and several effects share one
// binary — so this global export is WASM-only to avoid duplicate symbols.
#ifdef __wasm__
__attribute__((export_name("nano_module_main")))
void nano_module_main() {
  nano::registerEffect({
    2,
    "gen.text",
    "Text",
    "Renders multiline text via the host text engine (FreeType + msdfgen)",
    "generator",
    "text,type,font,glyph,label,caption",
    NANO_INSTANCE_LIFECYCLE(gen_text),
  });
}
#endif
