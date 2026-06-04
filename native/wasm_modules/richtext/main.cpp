/*
 * gen.richtext — HTML/CSS rich-text generator node (Blitz complex-layout mode).
 *
 * Like gen.text, but instead of a single attributed string it takes a full
 * HTML/CSS document and drives the host `text.*` service in its Blitz mode:
 * the host lays the document out with Stylo (CSS cascade) + Taffy (flex/grid) +
 * parley/harfrust (shaping), emits pre-shaped glyph runs, and rasterizes them
 * through the SAME MSDF atlas + compositor as gen.text. So flexbox, wrapping,
 * colored spans, multiple sizes/weights, and complex scripts all "just work",
 * and the web simulator reproduces the native pixels (see blitz_parity.sh).
 *
 * The document is laid out into the render target's pixel viewport, so CSS
 * positions map directly to output pixels (no centering — the doc owns layout).
 */

#include <gpu.h>
#include <host.h>
#include <module_api.h>

#include <cstdio>
#include <cstring>

namespace gen_richtext {

struct State {
  char  html[8192] =
    "<style>body{margin:0;font-family:sans-serif;color:#fff}"
    "h1{font-size:64px}p{font-size:28px;width:640px}"
    ".k{color:#6cf;font-weight:700}</style>"
    "<div style=\"padding:48px\"><h1>Rich <span class=\"k\">text</span></h1>"
    "<p>HTML &amp; CSS laid out by Blitz, rendered through the MSDF atlas.</p></div>";
  float scale = 1.0f;       // CSS px → device px (hidpi)
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
  state::init("gen.richtext", {1, 0, 0},
    state::Schema()
      .textField   ("html",  "HTML", state::PrimaryInput)
      .floatField  ("scale", 1.0f, 0.25f, 4.0f, state::PrimaryInput)
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
    if      (state::pathIs(p, pl, "html"))  state::patchString(i, s->html, sizeof(s->html));
    else if (state::pathIs(p, pl, "scale")) s->scale = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  // Lay the document out into the render target's CSS viewport. width/height are
  // device px / scale so a hidpi scale enlarges glyphs without reflowing.
  char spec[16384];
  int pos = 0;
  pos += std::snprintf(spec + pos, sizeof(spec) - pos, "{\"mode\":\"html\",\"html\":\"");
  appendEscaped(spec, pos, (int)sizeof(spec), s->html);
  pos += std::snprintf(spec + pos, sizeof(spec) - pos,
      "\",\"width\":%d,\"height\":%d,\"scale\":%.3f}",
      (int)(vp_w / s->scale), (int)(vp_h / s->scale), s->scale);

  int id = text::layout(spec, pos);
  if (id > 0) {
    // The document is already positioned in viewport space → draw at the origin.
    text::render(id, gpu::Device::renderTarget().id, "{\"x\":0,\"y\":0}");
    text::release(id);
  }
  gpu::Device::submit();
}

} // namespace gen_richtext

NANO_DECLARE_INSTANCE_EFFECT(gen_richtext)

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
  nano::registerEffect({
    2,
    "gen.richtext",
    "Rich Text",
    "HTML/CSS rich text laid out by Blitz (Stylo+Taffy+parley), via the host text engine",
    "generator",
    "text,html,css,rich,layout,flexbox,type",
    NANO_INSTANCE_LIFECYCLE(gen_richtext),
  });
}
