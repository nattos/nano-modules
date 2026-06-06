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
  // Structure (HTML) and styling (CSS) are separate fields so each gets its own
  // multi-line editor; render() combines them as <style>{css}</style>{html}.
  char  html[6144] =
    "<div class=\"kicker\">NANO \xc2\xb7 REPATCH</div>\n"
    "<h1>Type that <em>moves</em><br>at frame rate.</h1>\n"
    "<p>HTML &amp; CSS laid out by Blitz, rendered through an MSDF atlas "
    "\xe2\x80\x94 crisp at any size, byte-identical in the browser and native.</p>";
  char  css[4096] =
    ":root{ --accent:#7c5cff; --muted:#9aa4b2; }\n"
    "*{ margin:0; box-sizing:border-box; }\n"
    "body{ font-family:sans-serif; padding:56px; }\n"
    ".kicker{ font-size:19px; font-weight:700; letter-spacing:6px; color:var(--accent); }\n"
    "h1{ font-size:92px; font-weight:800; line-height:1.04; letter-spacing:-2px; margin:14px 0; }\n"
    "h1 em{ color:var(--accent); font-style:normal; }\n"
    "p{ font-size:24px; line-height:1.5; color:var(--muted); max-width:760px; margin-top:20px; }";
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
      .textField   ("css",   "CSS",  state::PrimaryInput)
      .floatField  ("scale", 1.0f, 0.25f, 4.0f, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)   // overlay the doc on this; black if unconnected
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
    else if (state::pathIs(p, pl, "css"))   state::patchString(i, s->css, sizeof(s->css));
    else if (state::pathIs(p, pl, "scale")) s->scale = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  // Lay the document out at the render target's pixel size. width/height are the
  // OUTPUT pixels (so 100vw / 100% == the node's full width, and font-size:48px
  // is 48 output px); `scale` is a zoom (2 = twice as big). The document is
  // <style>{css}</style>{html} — structure and styling are edited separately.
  char spec[24576];
  int pos = 0;
  pos += std::snprintf(spec + pos, sizeof(spec) - pos, "{\"mode\":\"html\",\"html\":\"<style>");
  appendEscaped(spec, pos, (int)sizeof(spec), s->css);
  pos += std::snprintf(spec + pos, sizeof(spec) - pos, "</style>");
  appendEscaped(spec, pos, (int)sizeof(spec), s->html);
  pos += std::snprintf(spec + pos, sizeof(spec) - pos,
      "\",\"width\":%d,\"height\":%d,\"scale\":%.3f}", vp_w, vp_h, s->scale);

  // Output target: the executor binds our PrimaryOutput as "tex_out" (same as
  // every other effect). renderTarget() only works when a swapchain surface was
  // set; the sketch executor binds a texture field instead.
  int target = gpu::Device::textureForField("tex_out").id;
  if (target < 0) target = gpu::Device::renderTarget().id;
  // Overlay the document on the incoming texture (transparent areas of the doc
  // show it through); an unconnected input is -1 → opaque-black background.
  int bg = gpu::Device::textureForField("tex_in").id;

  int id = text::layout(spec, pos);
  if (id > 0) {
    // The document is already positioned in viewport space → draw at the origin.
    text::render(id, target, "{\"x\":0,\"y\":0}", bg);
    text::release(id);
  }
  gpu::Device::submit();
}

} // namespace gen_richtext

NANO_DECLARE_INSTANCE_EFFECT(gen_richtext)

// WASM module entry. Native bundles (NanoBarrel) register the effect via the
// gen_richtext:: namespace function pointers instead, and several effects share
// one binary — so this global export is WASM-only to avoid duplicate symbols.
#ifdef __wasm__
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
#endif
