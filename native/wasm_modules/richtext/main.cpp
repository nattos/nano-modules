/*
 * source.text.rich — HTML/CSS rich-text generator node (Blitz complex-layout mode).
 *
 * Like source.text.plain, but instead of a single attributed string it takes a full
 * HTML/CSS document and drives the host `text.*` service in its Blitz mode:
 * the host lays the document out with Stylo (CSS cascade) + Taffy (flex/grid) +
 * parley/harfrust (shaping), emits pre-shaped glyph runs, and rasterizes them
 * through the SAME MSDF atlas + compositor as source.text.plain. So flexbox, wrapping,
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

// Default document. Defined as macros so the SAME text seeds BOTH the in-memory
// State (the native runtime default) AND the param schema (textField's 2nd arg is
// the default *value*) — the web reads that schema default via
// defaultStateForPlugin, so a fresh source.text.rich starts identical in the browser
// and native. Structure (HTML) and styling (CSS) are separate fields so each gets
// its own multi-line editor; render() combines them as <style>{css}</style>{html}.
//
// The default stylesheet is variable-driven: colours and the master font-size are
// CSS custom properties (Blitz/Stylo fully supports var()), so the whole look
// retunes by editing the :root block alone. Headings/labels size off --font-size
// via em (font-size is inherited, so child em is relative to body's resolved px),
// which keeps proportions when you change the one knob.
#define GEN_RICHTEXT_DEFAULT_HTML \
  "<div class=\"kicker\">\n" \
  "  NANO \xc2\xb7 REPATCH\n" \
  "</div>\n" \
  "<h1>\n" \
  "  Type that <em>moves</em><br>at frame rate.\n" \
  "</h1>\n" \
  "<p>\n" \
  "  HTML &amp; CSS laid out by Blitz, rendered through an MSDF atlas " \
  "\xe2\x80\x94 crisp at any size, byte-identical in the browser and native.\n" \
  "</p>"

#define GEN_RICHTEXT_DEFAULT_CSS \
  ":root {\n" \
  "  --fg: #ffffff;       /* body text */\n" \
  "  --accent: #7c5cff;   /* headings / highlights */\n" \
  "  --muted: #9aa4b2;    /* secondary text */\n" \
  "  --font: sans-serif;  /* family (resolved by the host) */\n" \
  "  --font-size: 24px;   /* master size \xe2\x80\x94 headings em off this */\n" \
  "}\n" \
  "* {\n" \
  "  margin: 0;\n" \
  "  box-sizing: border-box;\n" \
  "}\n" \
  "body {\n" \
  "  font-family: var(--font);\n" \
  "  font-size: var(--font-size);\n" \
  "  color: var(--fg);\n" \
  "  padding: 56px;\n" \
  "}\n" \
  ".kicker {\n" \
  "  font-size: 0.8em;\n" \
  "  font-weight: 700;\n" \
  "  letter-spacing: 6px;\n" \
  "  color: var(--accent);\n" \
  "}\n" \
  "h1 {\n" \
  "  font-size: 3.83em;\n" \
  "  font-weight: 800;\n" \
  "  line-height: 1.04;\n" \
  "  letter-spacing: -2px;\n" \
  "  margin: 14px 0;\n" \
  "}\n" \
  "h1 em {\n" \
  "  color: var(--accent);\n" \
  "  font-style: normal;\n" \
  "}\n" \
  "p {\n" \
  "  font-size: 1em;\n" \
  "  line-height: 1.5;\n" \
  "  color: var(--muted);\n" \
  "  max-width: 760px;\n" \
  "  margin-top: 20px;\n" \
  "}"

struct State {
  char  html[6144] = GEN_RICHTEXT_DEFAULT_HTML;
  char  css[4096]  = GEN_RICHTEXT_DEFAULT_CSS;
  float scale = 1.0f;       // CSS px → device px (hidpi)
  bool  initialized = false;

  // Cached Blitz layout. The HTML/CSS layout (Stylo cascade + Taffy + parley
  // shaping) is by far the most expensive thing this effect does, but it's
  // identical frame-to-frame unless the document or the output viewport
  // changes. The web GraphExecutor already skips re-layout via dirty-tracking;
  // the native FFGL chain calls render() every frame, so we memoize here: lay
  // out only when dirty, then re-composite the cached glyphs (cheap) each frame.
  text::Layout layoutId = 0;   // engine layout handle (>0), or 0 if none
  int   lastW = 0, lastH = 0;  // viewport the cached layout was built for
  bool  layoutDirty = true;    // html/css/scale changed → rebuild needed
};

// Append `src` to `dst` (at *pos, cap n) with JSON string escaping. ALL C0
// control chars must be escaped: a raw control byte (e.g. \r from CRLF / pasted
// HTML/CSS) is invalid inside a JSON string and the web's strict JSON.parse
// rejects the whole spec → blank render. (Native nlohmann is lenient and hid
// this.)
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
  state::init("source.text.rich", {1, 0, 0},
    state::Schema()
      .textField   ("html",  GEN_RICHTEXT_DEFAULT_HTML, state::PrimaryInput)
      .textField   ("css",   GEN_RICHTEXT_DEFAULT_CSS,  state::PrimaryInput)
      .floatField  ("scale", 1.0f, 0.25f, 4.0f, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)   // overlay the doc on this; transparent if unconnected
      .textureField("tex_out", state::PrimaryOutput)
      // Generates its image; the tex_in overlay is optional (transparent when
      // unconnected), so it's classed a generator like the codebase category.
      .capability(state::Capability::Generator)
  );
}

void* create() { return new State(); }
void  destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (s && s->layoutId > 0) text::release(s->layoutId);  // free the cached layout
  delete s;
}
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
    if      (state::pathIs(p, pl, "html"))  { state::patchString(i, s->html, sizeof(s->html)); s->layoutDirty = true; }
    else if (state::pathIs(p, pl, "css"))   { state::patchString(i, s->css, sizeof(s->css));   s->layoutDirty = true; }
    else if (state::pathIs(p, pl, "scale")) { s->scale = state::patchFloat(i);                 s->layoutDirty = true; }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  // Lay the document out at the render target's pixel size. width/height are the
  // OUTPUT pixels (so 100vw / 100% == the node's full width, and font-size:48px
  // is 48 output px); `scale` is a zoom (2 = twice as big). The document is
  // Full document: <html><head><style>{css}</style></head><body>{html}</body>.
  // The scaffolding matters — Blitz only establishes the initial containing
  // block (and thus a sized body) for a real document; a bare {style}{html}
  // fragment leaves block children (<h1>/<div>/<p>) with zero size, so they
  // lay out nothing (only inline/bare text flows). Structure (html) and
  // styling (css) are still edited as separate fields.
  // Re-lay-out only when the document or the output viewport changed; otherwise
  // reuse the cached layout (skips the whole Blitz parse/cascade/shape pipeline,
  // ~15% of native frame time for a static doc). The composite below still runs
  // every frame (the output texture is fresh each frame and the bg may animate).
  if (s->layoutDirty || vp_w != s->lastW || vp_h != s->lastH || s->layoutId <= 0) {
    char spec[24576];
    int pos = 0;
    pos += std::snprintf(spec + pos, sizeof(spec) - pos,
        "{\"mode\":\"html\",\"html\":\"<!DOCTYPE html><html><head><style>");
    appendEscaped(spec, pos, (int)sizeof(spec), s->css);
    pos += std::snprintf(spec + pos, sizeof(spec) - pos, "</style></head><body>");
    appendEscaped(spec, pos, (int)sizeof(spec), s->html);
    pos += std::snprintf(spec + pos, sizeof(spec) - pos, "</body></html>");
    pos += std::snprintf(spec + pos, sizeof(spec) - pos,
        "\",\"width\":%d,\"height\":%d,\"scale\":%.3f}", vp_w, vp_h, s->scale);

    int id = text::layout(spec, pos);
    if (id > 0) {
      if (s->layoutId > 0) text::release(s->layoutId);  // drop the previous one
      s->layoutId = id;
      s->lastW = vp_w; s->lastH = vp_h;
      s->layoutDirty = false;
    }
    // If layout failed (id<=0, e.g. fonts not yet installed) keep any prior
    // layout and stay dirty so we retry next frame.
  }

  // Output target: the executor binds our PrimaryOutput as "tex_out" (same as
  // every other effect). renderTarget() only works when a swapchain surface was
  // set; the sketch executor binds a texture field instead.
  int target = gpu::Device::textureForField("tex_out").id;
  if (target < 0) target = gpu::Device::renderTarget().id;
  // Overlay the document on the incoming texture (transparent areas of the doc
  // show it through); an unconnected input is -1 → the host leaves transparency.
  int bg = gpu::Device::textureForField("tex_in").id;

  if (s->layoutId > 0) {
    // The document is already positioned in viewport space → draw at the origin.
    text::render(s->layoutId, target, "{\"x\":0,\"y\":0}", bg);
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
    "source.text.rich",
    "Rich Text",
    "HTML/CSS rich text laid out by Blitz (Stylo+Taffy+parley), via the host text engine",
    "source",
    "text,html,css,rich,layout,flexbox,type",
    NANO_INSTANCE_LIFECYCLE(gen_richtext),
  });
}
#endif
