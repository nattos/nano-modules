/*
 * source.text.plain — text generator node.
 *
 * Renders multiline text into its output texture via the host `text.*` service
 * (FreeType + HarfBuzz + msdfgen live in the host, shared across effects). The
 * effect itself is tiny: it builds a JSON spec from its params, calls
 * text::layout, places it (horizontally centered; vertically per the anchor
 * params), and calls text::render into the render target. No shaders or GPU
 * resources here — the host owns the MSDF atlas + compositor.
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

// What part of the laid-out text sits at the anchor line (v_pos × viewport
// height). Center is the layout BOX's center — it depends on the font's
// ascender/descender metrics, so text shifts when the face/size changes.
// Baseline pins the FIRST line's baseline, which is what stays visually stable
// across fonts and sizes (the typographic anchor).
enum VAlign { AlignCenter = 0, AlignBaseline = 1, AlignTop = 2, AlignBottom = 3 };

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
  int   v_align = AlignCenter;
  float v_pos = 0.5f;         // anchor line, fraction of viewport height
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
  state::init("source.text.plain", {1, 0, 1},
    state::Schema()
      // Top-level manual: high-level "what is this / how to use / what to try".
      .helpField("intro",
        "## Text\n"
        "Renders crisp multiline text into a texture via the host type engine "
        "(FreeType + HarfBuzz + msdfgen). Because it's MSDF, it stays sharp at "
        "**any scale** — zoom in without pixelation.\n\n"
        "**Try:** leave *Font* blank for the primary UI font, or name any OS / "
        "bundled family; set *Max Width* above 0 to wrap into a paragraph; wire the "
        "output into a filter chain (glow, displacement) for animated titles.")
      .group("content", "Content")
        .groupHelp(
          "The text to draw. Newlines break lines; set a *Language* tag only when "
          "you need region-specific Han forms (Japanese vs. Simplified/Traditional "
          "Chinese) that the system locale would otherwise pick for you.")
      .textField  ("text",         "Text", state::PrimaryInput).label("Text", "Text")
      .textField  ("lang",         "",     state::PrimaryInput).label("Language", "Lang")
      .group("typography", "Typography")
        .groupHelp(
          "Pick the typeface and weight. Leave *Font* empty to use the host's "
          "primary font; otherwise name any installed OS or bundled family — the "
          "host resolves the matching **Bold** / **Italic** face for you, and "
          "synthesizes the style (faux bold / oblique) when the family has no "
          "true face for it. *Size* is the cap height in output pixels (MSDF "
          "keeps it crisp when scaled).")
      .textField  ("font",         "",     state::PrimaryInput).label("Font", "Font")
      .boolField  ("bold",         false,  state::PrimaryInput).label("Bold", "Bold")
      .boolField  ("italic",       false,  state::PrimaryInput).label("Italic", "Ital")
      .floatField ("size",         64.0f,  8.0f, 512.0f, state::PrimaryInput).label("Size", "Size")
      .group("color", "Colour")
      .rgbaField  ("color",        1.0f, 1.0f, 1.0f, 1.0f, state::PrimaryInput).label("Colour", "Col")
      .group("layout", "Layout")
        .groupHelp(
          "*Max Width* controls wrapping — 0 keeps everything on one line; any "
          "positive value (in pixels) wraps the text into a column. *Line Spacing* "
          "is a multiplier on the font's natural leading (1.0 = tight, 1.5 = airy).\n\n"
          "*V Anchor* picks what sits on the anchor line at *V Position* (a "
          "fraction of the output height): **Center** centers the layout box "
          "(leading splits evenly around each line, so this is stable as *Line "
          "Spacing* changes — but the box still tracks the font's own metrics, "
          "so text can shift a little when the face changes); **Baseline** pins "
          "the first line's baseline, keeping text rock-steady across fonts and "
          "sizes; **Top** / **Bottom** hang the box below or stack it above the "
          "line. Modulate *V Position* to slide text vertically.")
      .floatField ("max_width",    0.0f,   0.0f, 4096.0f, state::PrimaryInput).label("Max Width", "Width")
      .floatField ("line_spacing", 1.2f,   0.5f, 3.0f,    state::PrimaryInput).label("Line Spacing", "Lead")
      .selectField("v_align", AlignCenter, state::PrimaryInput,
                   {{"Center", AlignCenter},
                    {"Baseline", AlignBaseline},
                    {"Top", AlignTop},
                    {"Bottom", AlignBottom}}).label("V Anchor", "VAnc")
      .floatField ("v_pos",        0.5f,   0.0f, 1.0f,    state::PrimaryInput).label("V Position", "VPos")
      .textureField("tex_in",  state::PrimaryInput)   // overlay text on this; transparent if unconnected
      .textureField("tex_out", state::PrimaryOutput)
      // Generates its image; the tex_in overlay is optional (transparent when
      // unconnected), so it's classed a generator like the codebase category.
      .capability(state::Capability::Generator)
      .capability(state::Capability::TimeIndependent)
  );
}

void* create() { return new State(); }
void  destroy(void* self) { delete static_cast<State*>(self); }
void  init(void* self) { auto* s = static_cast<State*>(self); if (s) s->initialized = true; }
void  tick(void*, double) {}

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
    else if (state::pathIs(p, pl, "v_align"))      s->v_align = state::patchInt(i);
    else if (state::pathIs(p, pl, "v_pos"))        s->v_pos = state::patchFloat(i);
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
  if (s->font[0]) {   // name a family → host resolves it (bundled / OS font)
    pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\"family\":\"");
    appendEscaped(spec, pos, (int)sizeof(spec), s->font);
    pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\",");
  }
  // Style is emitted UNCONDITIONALLY — with no family (the primary font) or an
  // unresolved one, the engine synthesizes faux bold/oblique, so Bold/Italic
  // always take effect; a registered true styled face still wins.
  pos += std::snprintf(spec + pos, sizeof(spec) - pos, "\"weight\":%d,\"italic\":%s,",
                       s->bold ? 700 : 400, s->italic ? "true" : "false");
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
    // Horizontally centered; vertically the chosen part of the layout sits on
    // the anchor line (v_pos × height). text::render's origin is the layout
    // box's TOP-left, and metrics give the box height + the first line's
    // baseline offset within it.
    text::TextMetrics m;
    float ox = 0, oy = 0;
    if (text::measure(id, m)) {
      ox = (vp_w - m.width) * 0.5f;
      float anchor_y = s->v_pos * (float)vp_h;
      switch (s->v_align) {
        case AlignBaseline: oy = anchor_y - m.first_baseline;  break;
        case AlignTop:      oy = anchor_y;                     break;
        case AlignBottom:   oy = anchor_y - m.height;          break;
        default:            oy = anchor_y - m.height * 0.5f;   break;   // Center
      }
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
NANO_EXPORT_ABI_VERSION()

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
  nano::registerEffect({
    2,
    "source.text.plain",
    "Text",
    "Renders multiline text via the host text engine (FreeType + msdfgen)",
    "source",
    "text,type,font,glyph,label,caption",
    "la-font",
    NANO_INSTANCE_LIFECYCLE(gen_text),
  });
}
#endif
