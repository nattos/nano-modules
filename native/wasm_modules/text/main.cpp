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
  float size = 64.0f;
  float r = 1.0f, g = 1.0f, b = 1.0f, a = 1.0f;
  float max_width = 0.0f;     // 0 = no wrap
  float line_spacing = 1.2f;
  bool  initialized = false;
};

// Append `src` to `dst` (at *pos, cap n) with JSON string escaping.
static void appendEscaped(char* dst, int& pos, int n, const char* src) {
  for (int i = 0; src[i] && pos < n - 7; i++) {
    char c = src[i];
    switch (c) {
      case '"':  dst[pos++]='\\'; dst[pos++]='"';  break;
      case '\\': dst[pos++]='\\'; dst[pos++]='\\'; break;
      case '\n': dst[pos++]='\\'; dst[pos++]='n';  break;
      case '\t': dst[pos++]='\\'; dst[pos++]='t';  break;
      default:   dst[pos++] = c;                   break;  // UTF-8 bytes pass through
    }
  }
}

void module_init() {
  state::init("gen.text", {1, 0, 0},
    state::Schema()
      .textField  ("text",         "Text", state::PrimaryInput)
      .textField  ("font",         "",     state::PrimaryInput)
      .floatField ("size",         64.0f,  8.0f, 512.0f, state::PrimaryInput)
      .rgbaField  ("color",        1.0f, 1.0f, 1.0f, 1.0f, state::PrimaryInput)
      .floatField ("max_width",    0.0f,   0.0f, 4096.0f, state::PrimaryInput)
      .floatField ("line_spacing", 1.2f,   0.5f, 3.0f,    state::PrimaryInput)
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
  pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\",\"runs\":[{");
  if (s->font[0]) {   // name a family → host resolves it (bundled / OS font)
    pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\"family\":\"");
    appendEscaped(spec, pos, (int)sizeof(spec), s->font);
    pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\",");
  }
  pos += std::snprintf(spec + pos, sizeof(spec) - pos,
      "\"size_px\":%.3f,\"rgba\":[%.4f,%.4f,%.4f,%.4f]}],"
      "\"constraints\":{\"max_width_px\":%.3f,\"line_spacing\":%.3f}}",
      s->size, s->r, s->g, s->b, s->a, s->max_width, s->line_spacing);

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
    text::render(id, gpu::Device::renderTarget().id, xform);
    text::release(id);
  }
  gpu::Device::submit();
}

} // namespace gen_text

NANO_DECLARE_INSTANCE_EFFECT(gen_text)

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
