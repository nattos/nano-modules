#pragma once
/*
 * host.h — C++ wrappers for host.*, state.*, canvas.*, and resolume.* APIs.
 *
 * Includes the Schema builder for unified module declaration.
 */

#include <cstring>
#include <cstdint>
#include <initializer_list>

#include "val.h"

// --- Raw C imports ---
extern "C" {
  // host
  __attribute__((import_module("host"), import_name("get_time")))
  double host_get_time(void);
  __attribute__((import_module("host"), import_name("get_delta_time")))
  double host_get_delta_time(void);
  __attribute__((import_module("host"), import_name("get_bar_phase")))
  double host_get_bar_phase(void);
  __attribute__((import_module("host"), import_name("get_bpm")))
  double host_get_bpm(void);
  __attribute__((import_module("host"), import_name("get_param")))
  double host_get_param(int index);
  __attribute__((import_module("host"), import_name("get_viewport_w")))
  int host_get_viewport_w(void);
  __attribute__((import_module("host"), import_name("get_viewport_h")))
  int host_get_viewport_h(void);
  __attribute__((import_module("host"), import_name("trigger_audio")))
  void host_trigger_audio(int channel);

  // state
  __attribute__((import_module("state"), import_name("set_metadata")))
  void state_set_metadata(const char* id, int id_len, int version_packed);
  __attribute__((import_module("state"), import_name("set_schema")))
  void state_set_schema(const char* id, int id_len, int version_packed,
                        const char* schema_json, int schema_json_len);
  __attribute__((import_module("state"), import_name("get_key")))
  int state_get_key(char* buf, int buf_len);
  __attribute__((import_module("state"), import_name("console_log")))
  void state_console_log(int level, const char* msg, int msg_len);
  __attribute__((import_module("state"), import_name("console_log_structured")))
  void state_console_log_structured(int level, const char* msg, int msg_len,
                                     const char* json, int json_len);
  __attribute__((import_module("state"), import_name("set_val")))
  void state_set_val(const char* path, int path_len, int val_handle);
  __attribute__((import_module("state"), import_name("mark_gpu_dirty")))
  void state_mark_gpu_dirty(const char* path, int path_len);
  __attribute__((import_module("state"), import_name("set_gpu_buffer")))
  void state_set_gpu_buffer(const char* path, int path_len, int buffer_handle);
  __attribute__((import_module("state"), import_name("set_gpu_texture")))
  void state_set_gpu_texture(const char* path, int path_len, int texture_handle);
  __attribute__((import_module("state"), import_name("set_field_hidden")))
  void state_set_field_hidden(const char* path, int path_len, int hidden);
  // Returns non-zero if the schema field at `path` is connected through
  // the current sketch's tap topology to a complementary tap. `direction`
  // selects the side: 0 = "is anyone WRITING this field" (input-side
  // check, useful for read taps), 1 = "is anyone READING this field"
  // (output-side check, useful for write taps). The runtime updates the
  // answer once per render() call from the executor's tap walk; effects
  // can call this any time after on_state_ready.
  __attribute__((import_module("state"), import_name("is_field_connected")))
  int state_is_field_connected(const char* path, int path_len, int direction);
  // Non-zero when this effect's output WILL be drawn this frame. False when
  // the host is skipping render() because the effect's opacity is 0 (the host
  // aliases the input through). tick() still runs in that case, so the effect
  // can read this during tick() to skip render-prep / heavy sim it won't need.
  // Set by the executor before each tick(); defaults to true (1).
  __attribute__((import_module("state"), import_name("will_render")))
  int state_will_render();
  __attribute__((import_module("state"), import_name("set_on_state_ready")))
  void state_set_on_state_ready(void (*fn)(void* self));
  // Register a SPIR-V shader blob under a name. The host translates
  // it to the platform-native shader source (WGSL on the web via
  // naga, MSL on Metal natives) the first time it's referenced via
  // `gpu::Device::createShaderModule(name)`. See state::registerShaderSPV.
  //
  // Optional `format` / `access` args control the storage-texture
  // format/access naga emits for `RWTexture2D<float4>` declarations
  // — naga's default is `rgba32float,read_write`, which we substitute
  // for the format the C++ side actually binds. Pass empty strings
  // to use the default `rgba8unorm,write` (covers every basic effect).
  __attribute__((import_module("state"), import_name("register_shader_spv")))
  void state_register_shader_spv(const char* name, int name_len,
                                  const unsigned char* spv, int spv_len,
                                  const char* format, int format_len,
                                  const char* access, int access_len);
  // Register fusion metadata, with the per-pixel kernel sourced by
  // NAME (registered earlier via state::registerShaderSPV). The runtime
  // fetches SPV → WGSL via the dev server's naga endpoint and runs the
  // strip pass on demand.
  __attribute__((import_module("state"), import_name("register_fusion_by_name")))
  void state_register_fusion_by_name(int kind,
                                      const char* fragment_name, int fragment_name_len,
                                      int uniform_buf_handle,
                                      int uniform_size_bytes,
                                      void (*prepare)(void* self, int vp_w, int vp_h));
  __attribute__((import_module("state"), import_name("read")))
  int state_read(const char* layout, int field_count, const char* paths,
                 char* output, int output_size, char* results);
  __attribute__((import_module("state"), import_name("get_patch")))
  int state_get_patch(int index);

  // resolume
  __attribute__((import_module("resolume"), import_name("get_param")))
  double resolume_get_param(int64_t param_id);
  __attribute__((import_module("resolume"), import_name("set_param")))
  void resolume_set_param(int64_t param_id, double value);
  __attribute__((import_module("resolume"), import_name("subscribe_query")))
  void resolume_subscribe_query(const char* query, int query_len);
  __attribute__((import_module("resolume"), import_name("get_param_path")))
  int resolume_get_param_path(int64_t param_id, char* buf, int buf_len);
  __attribute__((import_module("resolume"), import_name("trigger_clip")))
  void resolume_trigger_clip(int64_t clip_id, int on);
  __attribute__((import_module("resolume"), import_name("get_clip_count")))
  int resolume_get_clip_count(void);
  __attribute__((import_module("resolume"), import_name("get_clip_channel")))
  int resolume_get_clip_channel(int index);
  __attribute__((import_module("resolume"), import_name("get_clip_id")))
  int64_t resolume_get_clip_id(int index);
  __attribute__((import_module("resolume"), import_name("get_clip_connected")))
  int resolume_get_clip_connected(int index);
  __attribute__((import_module("resolume"), import_name("get_clip_name")))
  int resolume_get_clip_name(int index, char* buf, int buf_len);
  __attribute__((import_module("resolume"), import_name("load_thumbnail")))
  int resolume_load_thumbnail(int clip_index);

  // text — host-side text shaping/rendering service (FreeType + HarfBuzz +
  // msdfgen, owned by the host so modules don't link the engine). The
  // attributed string + layout constraints cross as ONE JSON blob per
  // layout call (see the spec schema in text_engine docs); richness lives
  // in the JSON, not the verb count. Opaque integer `layout_id` handles
  // follow the val.h convention (>0 valid, 0 = error). POD readback structs
  // (TextMetrics, GlyphQuad below) are passed as `void*` to keep a plain C
  // ABI; the C++ wrappers in `namespace text` cast to the typed layouts.
  __attribute__((import_module("text"), import_name("layout")))
  int text_layout(const char* spec_json, int spec_len);
  __attribute__((import_module("text"), import_name("measure")))
  int text_measure(int layout_id, void* out_metrics);          // fills TextMetrics; 1 = ok
  __attribute__((import_module("text"), import_name("render")))
  void text_render(int layout_id, int target_tex, int bg_tex,
                   const char* xform_json, int xform_len);      // easy path: composite over bg_tex into target_tex
  __attribute__((import_module("text"), import_name("atlas")))
  int text_atlas(int layout_id);                               // escape hatch: shared atlas tex handle
  __attribute__((import_module("text"), import_name("glyphs")))
  int text_glyphs(int layout_id, void* out_quads, int out_bytes); // escape hatch: GlyphQuad[]; returns glyph count
  __attribute__((import_module("text"), import_name("release")))
  void text_release(int layout_id);
}

namespace host {

inline double time() { return host_get_time(); }
inline double deltaTime() { return host_get_delta_time(); }
inline double barPhase() { return host_get_bar_phase(); }
inline double bpm() { return host_get_bpm(); }
inline double param(int index) { return host_get_param(index); }
inline int viewportWidth() { return host_get_viewport_w(); }
inline int viewportHeight() { return host_get_viewport_h(); }
inline void triggerAudio(int channel) { host_trigger_audio(channel); }

} // namespace host

// ---------------------------------------------------------------------------
// text — host text shaping/rendering service.
//
// Pipeline lives in the host (one shared FreeType + HarfBuzz + msdfgen engine,
// compiled identically native + wasm so output is byte-identical → the web
// simulator reproduces the native "for realz" pixels). Modules just drive it:
//
//   auto id = text::layout(specJson);            // spec = attributed string + constraints
//   text::TextMetrics m; text::measure(id, m);   // for fit/center
//   text::render(id, texOut, "{\"x\":40,\"y\":40}");   // easy path
//   // ...or the escape hatch: sample the shared atlas in your own shader
//   int atlas = text::atlasTexture(id);
//   int n = text::glyphCount(id);
//   text::glyphs(id, quads, n);
//   text::release(id);
//
// The JSON spec schema (built cheaply module-side, marshalled once):
//   { "text": "…utf8…",
//     "lang":"ja",                       // optional doc default for regional Han
//     "runs":[{"start":0,"len":5,"family":"Inter","weight":700,"italic":false,
//              "size_px":48,"rgba":[1,1,1,1],"lang":"zh-Hant","features":["liga"]}],
//     "constraints":{"max_width_px":1024,"align":"start|center|end|justify",
//                    "direction":"auto|ltr|rtl","line_spacing":1.2} }
//   `lang` (run-level, else doc-level, else the host's system-locale default)
//   selects the regional CJK fallback so shared Han ideographs render in the
//   correct glyph forms (ja / ko / zh-Hant / zh-Hans).
// ---------------------------------------------------------------------------
namespace text {

using Layout = int;

// Layout-level metrics. POD with a FIXED layout — the host fills this via the
// `text_measure` void* out param. Keep field order/size stable across the ABI.
struct TextMetrics {
  float width;          // laid-out content width, px
  float height;         // total laid-out height, px
  int   line_count;     // number of lines after wrapping
  float first_baseline; // px from layout-box top to the first baseline
  int   glyph_count;    // total positioned glyphs (== text_glyphs return)
  int   atlas_kind;     // 0 = MSDF, 1 = alpha-coverage (host backend dependent)
  float atlas_px_range; // MSDF distance range in atlas px (for screenPxRange AA)
  int   _pad;
};

// One positioned glyph quad (escape hatch). POD, fixed 64-byte layout. Screen
// rect is in px relative to the layout box origin (top-left); apply your own
// transform in-shader. UVs are normalized into the glyph's atlas PAGE; `page` is
// the atlas-array layer to sample (dense scripts land on higher-res pages).
struct GlyphQuad {
  float x, y, w, h;       // screen-space rect, px (layout-box-relative)
  float u0, v0, u1, v1;   // atlas-page UV rect, normalized
  float r, g, b, a;       // run color (linear, premultiply-free)
  float page;             // atlas-array layer index
  float _r0, _r1, _r2;    // reserved (16-byte alignment for GPU storage buffers)
};

/// Lay out an attributed string. Returns an opaque layout handle (>0), or 0 on
/// error. The host caches by spec hash, so re-laying the same spec is cheap.
inline Layout layout(const char* specJson, int len) { return text_layout(specJson, len); }
inline Layout layout(const char* specJson) { return text_layout(specJson, (int)std::strlen(specJson)); }

/// Fill `out` with layout metrics. Returns false on an invalid handle.
inline bool measure(Layout id, TextMetrics& out) { return text_measure(id, &out) != 0; }

/// Easy path: host uploads the glyph atlas and composites the laid-out text
/// over `bgTex` into `targetTex` (AlphaOver). `xformJson` (may be null)
/// positions/scales the layout box, e.g. {"x":40,"y":40,"scale":1.0}.
/// `bgTex` is the background sampled behind the text — pass an input texture to
/// overlay text on it, or -1 for an opaque-black background. `bgTex` MUST differ
/// from `targetTex` (the compositor reads bg + writes target in one pass; WebGPU
/// forbids same-texture read+write).
inline void render(Layout id, int targetTex, const char* xformJson = nullptr,
                   int bgTex = -1) {
  text_render(id, targetTex, bgTex, xformJson,
              xformJson ? (int)std::strlen(xformJson) : 0);
}

/// Escape hatch: the shared atlas GPU texture handle (sample it yourself).
inline int atlasTexture(Layout id) { return text_atlas(id); }

/// Number of positioned glyphs (size your GlyphQuad buffer to this).
inline int glyphCount(Layout id) { return text_glyphs(id, nullptr, 0); }

/// Escape hatch: copy up to `maxCount` positioned glyph quads into `out`.
/// Returns the number written.
inline int glyphs(Layout id, GlyphQuad* out, int maxCount) {
  return text_glyphs(id, out, maxCount * (int)sizeof(GlyphQuad));
}

/// Release a layout handle (host frees its cached layout/geometry).
inline void release(Layout id) { text_release(id); }

} // namespace text

namespace state {

// --- I/O flags (bitfield) ---
enum IOFlags : int {
  None            = 0,
  Input           = 1,
  Output          = 2,
  Primary         = 4,
  Secondary       = 8,
  PrimaryInput    = Input | Primary,      // 5
  PrimaryOutput   = Output | Primary,     // 6
  SecondaryInput  = Input | Secondary,    // 9
  SecondaryOutput = Output | Secondary,   // 10
};

// --- Log levels ---
enum class LogLevel : int { Info = 0, Warn = 1, Error = 2 };

// --- Version ---
struct Version {
  int major, minor, patch;
  int packed() const { return (major << 16) | (minor << 8) | patch; }
};

// Module-level (bundle) version, distinct from each effect's own state::init
// version. One per WASM module; defaults to 1.0.0. A bundle bumps it once in
// nano_module_main (before its effects register) when the whole module's
// serialization changes; individual effects bump their own state::init version.
// Both ride every effect's schema JSON so serialized instances can record the
// pair (see Schema::apply). Function-local static → one instance per module.
inline Version& moduleVersionRef() { static Version v{1, 0, 0}; return v; }
inline void setModuleVersion(Version v) { moduleVersionRef() = v; }

// ========================================================================
// Schema builder — unified module declaration
// ========================================================================

// Effect "capabilities": declarative, queryable tags that classify what an
// effect is FOR, beyond its individual schema fields. They ride the schema JSON
// as a top-level `capabilities` array (sibling to `fields`) and surface to the
// editor unchanged. Additive over — and orthogonal to — the existing implicit
// capability signals (`category` "generator.*", the `is_identity` predicate,
// and `registerFusion*`), which are left as-is.
//
// Some capabilities are standalone (Generator); the modulation ones are
// TWO-TIER: a general UMBRELLA tag plus an arity/channel-SPECIFIC tag. An
// effect declares BOTH (e.g. a single-output LFO is a ModulationSource AND a
// ModulationSourceSingle), so the editor can query the umbrella ("is this any
// kind of modulation source?") or specialise on arity. Channels themselves are
// NOT re-listed here — they are the effect's scalar output fields that carry a
// `magnitude` declaration.
//
// TEMPORAL capabilities classify how an effect behaves when TIME JUMPS (a
// scrub, a loop wrap, a render-export seek) rather than advancing one frame at
// a time. They are independent flags; an effect declares whichever fit. The
// ABSENCE of any temporal tag is the conservative default: "fully stateful, not
// safely seekable" — the host must replay frame-by-frame to reach a target time.
//   - TimeIndependent:    the effect is a pure function of its current inputs;
//                         a jump just yields the correct frame (no warm-up).
//   - SeekablePrefill:    stateful, but can be driven to an arbitrary time via
//                         the optional seek() export (a potentially slow
//                         prefill). See EffectDesc_v2::seek in module_api.h.
//   - SeekableApproximate: stateful; a jump yields a non-deterministic result
//                         that differs only at noise level. Safe to seek UNLESS
//                         the pipeline requires bit-reproducible output.
// (TimeIndependent and SeekableApproximate are mutually exclusive in practice,
//  but nothing enforces it; SeekablePrefill can pair with either to advertise
//  that an exact prefill is also available.)
enum class Capability {
  Generator,               // synthesizes image output; can start a chain (may also composite over an optional input)
  ModulationSource,        // produces modulation signal(s) on scalar outputs
  ModulationSourceSingle,  //   ...exactly one canonical channel (auto-wireable)
  ModulationSourceMulti,   //   ...several channels; the user picks one
  ModulationShaper,        // transforms modulation value(s): N in -> M out
  ModulationShaperUnary,   //   ...1 in -> 1 out (e.g. the envelope remapper)
  ModulationShaperBinary,  //   ...2 in -> 1 out (e.g. the binary combiner)
  TriggerSource,           // emits structured trigger EVENTS ({on, channel, velocity})
                           //   via a published "triggers" ring — launches scenes through
                           //   rails (never the scalar wire fold)
  TimeIndependent,         // stateless w.r.t. time; a time jump yields the correct frame
  SeekablePrefill,         // stateful, but seekable to any time via seek() (may be slow)
  SeekableApproximate,     // stateful; seeking differs only at noise level (non-deterministic)
  SketchInputSource,       // exports sketch-level input parameters (for the dashboard)
  SketchOutputSource,      // exports sketch-level OUTPUT channels — wires write into them (for a future video-editor)
  TransportController,     // identity on video; publishes transport_* output fields
                           //   that DRIVE its clip's content-local time (which source
                           //   frame plays). Lives in the clip's separate transport
                           //   section, executed in a pre-pass BEFORE video decode;
                           //   reads its input clock via streams::parent() (streams.h)
  TransportSection,        // belongs in the transport section WITHOUT driving content
                           //   time (followers/autopilots: read streams, launch/stop
                           //   scenes via streams.seek/stop). A section holding one
                           //   OWNS its clip's end-of-life (the engine's config
                           //   auto-stop defers to it); the clip's own play mode
                           //   keeps driving underneath
};

inline const char* capabilityName(Capability c) {
  switch (c) {
    case Capability::Generator:              return "generator";
    case Capability::ModulationSource:       return "modulation_source";
    case Capability::ModulationSourceSingle: return "modulation_source_single";
    case Capability::ModulationSourceMulti:  return "modulation_source_multi";
    case Capability::ModulationShaper:       return "modulation_shaper";
    case Capability::ModulationShaperUnary:  return "modulation_shaper_unary";
    case Capability::ModulationShaperBinary: return "modulation_shaper_binary";
    case Capability::TriggerSource:          return "trigger_source";
    case Capability::TimeIndependent:        return "time_independent";
    case Capability::SeekablePrefill:        return "seekable_prefill";
    case Capability::SeekableApproximate:    return "seekable_approximate";
    case Capability::SketchInputSource:      return "sketch_input_source";
    case Capability::SketchOutputSource:     return "sketch_output_source";
    case Capability::TransportController:    return "transport_controller";
    case Capability::TransportSection:       return "transport_section";
  }
  return "";
}

class Schema {
public:
  Schema() {
    appendRaw("{\"fields\":{");
  }

  // `magnitude` (optional) declares how an OUTPUT field's value should be
  // interpreted by a wire's "Auto" magnitude mode: "signed" (bipolar -1..1) or
  // "unsigned" (unipolar 0..1). Absent → the web defaults Auto to unsigned.
  // Trailing optionals: `step` (slider granularity; 0 = UI default), `units`
  // (display suffix), `description` (tooltip). `magnitude` keeps its place for
  // back-compat with existing call sites.
  Schema& floatField(const char* name, float def, float min, float max, int io = None,
                     const char* magnitude = nullptr, float step = 0.f,
                     const char* units = nullptr, const char* description = nullptr) {
    beginField(name);
    appendRaw("\"type\":\"float\",\"default\":");
    appendFloat(def);
    appendRaw(",\"min\":");
    appendFloat(min);
    appendRaw(",\"max\":");
    appendFloat(max);
    appendRaw(",\"io\":");
    appendInt(io);
    if (magnitude) {
      appendRaw(",\"magnitude\":\"");
      appendRaw(magnitude);
      appendRaw("\"");
    }
    if (step > 0.f) { appendRaw(",\"step\":"); appendFloat(step); }
    appendFieldMeta(units, description);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  Schema& intField(const char* name, int def, int min, int max, int io = None,
                   int step = 0, const char* units = nullptr, const char* description = nullptr) {
    beginField(name);
    appendRaw("\"type\":\"int\",\"default\":");
    appendInt(def);
    appendRaw(",\"min\":");
    appendInt(min);
    appendRaw(",\"max\":");
    appendInt(max);
    appendRaw(",\"io\":");
    appendInt(io);
    if (step > 0) { appendRaw(",\"step\":"); appendInt(step); }
    appendFieldMeta(units, description);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  /// Single-choice integer with named options. Schema-wise it's still
  /// `type:int` with `options:[{label,value}, ...]` — the IDE renders
  /// it as a dropdown when `options` is present. Use this for mode
  /// selectors, algorithm pickers, and anything else with a small
  /// fixed set of named values.
  struct SelectOption { const char* label; int value; };
  /// `wrap` lets the IDE's row-of-buttons editor flow onto multiple rows
  /// instead of one squeezed strip — use it when the option count is large
  /// (blend modes, etc.) so each choice stays a comfortable hit target.
  Schema& selectField(const char* name, int def, int io,
                      std::initializer_list<SelectOption> options,
                      bool wrap = false, const char* description = nullptr) {
    int lo = def, hi = def;
    for (const auto& o : options) {
      if (o.value < lo) lo = o.value;
      if (o.value > hi) hi = o.value;
    }
    beginField(name);
    appendRaw("\"type\":\"int\",\"default\":");
    appendInt(def);
    appendRaw(",\"min\":");
    appendInt(lo);
    appendRaw(",\"max\":");
    appendInt(hi);
    appendRaw(",\"io\":");
    appendInt(io);
    if (wrap) appendRaw(",\"wrap\":true");
    appendRaw(",\"options\":[");
    bool first = true;
    for (const auto& o : options) {
      if (!first) appendRaw(",");
      first = false;
      appendRaw("{\"label\":\"");
      appendRaw(o.label);
      appendRaw("\",\"value\":");
      appendInt(o.value);
      appendRaw("}");
    }
    appendRaw("]");
    appendFieldMeta(nullptr, description);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  Schema& boolField(const char* name, bool def = false, int io = None,
                    const char* description = nullptr) {
    beginField(name);
    appendRaw("\"type\":\"bool\",\"default\":");
    appendRaw(def ? "true" : "false");
    appendRaw(",\"io\":");
    appendInt(io);
    appendFieldMeta(nullptr, description);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  Schema& eventField(const char* name, int io = PrimaryInput) {
    beginField(name);
    appendRaw("\"type\":\"event\",\"io\":");
    appendInt(io);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  Schema& textureField(const char* name, int io) {
    beginField(name);
    appendRaw("\"type\":\"texture\",\"io\":");
    appendInt(io);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  /// RESOURCE handle leaf (resources.h): an identity-derived i64 asset
  /// reference, string-backed — the value is the handle's unsigned-decimal
  /// string ("0" = none; handles exceed 2^53, so they never ride a float).
  /// Unlike textures this IS persisted state (a durable asset reference, not
  /// per-frame wiring): store it, reload it, pass it across sessions. The
  /// effect reads it via patchString + strtoull and publishes one with
  /// val::string through setValPath.
  Schema& resourceField(const char* name, int io) {
    beginField(name);
    appendRaw("\"type\":\"resource\",\"io\":");
    appendInt(io);
    appendRaw(",\"default\":\"0\"");
    appendOrder();
    appendRaw("}");
    return *this;
  }

  /// Canonical "auxiliary outputs of a 3D rendering pipeline" struct.
  /// Always declares the same shape so that any two effects using this
  /// helper have schema-compatible struct rails (auto-binding).
  ///
  /// All leaves are optional: a producer that doesn't write a field
  /// simply doesn't call `state::setGpuTexture` for it; the consumer
  /// observes `gpu::Device::textureForField("render_outputs/<name>")`
  /// returning invalid and degrades gracefully (typically a pass-
  /// through). Both leaves are rgba16float by convention — depth.x
  /// is camera-space depth, motion.xy is per-pixel velocity in
  /// viewport-uv space; remaining channels are reserved.
  ///
  /// Pass `state::PrimaryOutput` on the producer side (the rail and
  /// its taps will be inferred when the user clicks the IDE pin) and
  /// `state::PrimaryInput` on the consumer side.
  ///
  /// `name` lets one effect declare BOTH an input and an output of this
  /// shape (the JSON schema disallows duplicate field names). Use the
  /// default "render_outputs" for one direction and a different name
  /// (e.g. "render_outputs_in") for the other. Auto-binding matches by
  /// schema shape, not field name, so both will still rail-couple to
  /// peers that use the canonical name.
  Schema& renderOutputs(int io = None, const char* name = "render_outputs") {
    return beginObject(name, io)
      .textureField("depth",  None)
      .textureField("motion", None)
      .endObject();
  }

  /// Continuous vector/advection FIELD passed between effects — the
  /// generator-to-renderer seam for flows. A single rgba16float leaf,
  /// `velocity`, sampled in screen-uv:
  ///   velocity.xy = screen-uv velocity per second (advect a particle at
  ///                 uv `p` by `p += velocity.xy * dt`),
  ///   velocity.z  = speed |xy| (cheap magnitude for shading),
  ///   velocity.w  = validity (1 inside the field, 0 over a hole).
  /// Producer calls state::setGpuTexture("flow_field/velocity", id) (on
  /// (re)allocation) gated on isOutputConnected("flow_field"); a consumer
  /// reads gpu::Device::textureForField("flow_field_in/velocity") and
  /// degrades to a zero (still) field when nothing is wired. The single-
  /// leaf shape is DISTINCT from render_outputs (depth+motion), so the two
  /// rail kinds never cross-auto-bind. Modifiers that process a flow
  /// declare BOTH directions (default name in, a different name out).
  Schema& flowField(int io = None, const char* name = "flow_field") {
    return beginObject(name, io)
      .textureField("velocity", None)
      .endObject();
  }

  /// Vec2/3/4 leaf with explicit component defaults. Stored as a flat
  /// JSON array of N floats. Optional `hint` selects an editor variant
  /// in the IDE — currently:
  ///   "color" — float3/float4 → RGB(A) color picker (instead of XYZ sliders).
  /// Other hints are ignored and the inspector falls back to N labeled
  /// component sliders.
  ///
  /// `min`/`max` apply uniformly to every component. Default range is
  /// [0, 1] (matches color channels and uv-space points). For
  /// signed-anchor positions like cover-square coordinates pass
  /// `min=-1.f, max=1.f`.
  Schema& vec2Field(const char* name, float x = 0.f, float y = 0.f, int io = None,
                    float min = 0.f, float max = 1.f, const char* hint = nullptr) {
    return vecField(name, "float2", io, 2, x, y, 0.f, 0.f, min, max, hint);
  }
  Schema& vec3Field(const char* name, float x = 0.f, float y = 0.f, float z = 0.f, int io = None,
                    float min = 0.f, float max = 1.f, const char* hint = nullptr) {
    return vecField(name, "float3", io, 3, x, y, z, 0.f, min, max, hint);
  }
  Schema& vec4Field(const char* name, float x = 0.f, float y = 0.f, float z = 0.f, float w = 0.f,
                    int io = None, float min = 0.f, float max = 1.f, const char* hint = nullptr) {
    return vecField(name, "float4", io, 4, x, y, z, w, min, max, hint);
  }

  /// RGB color (alias for vec3Field with "color" hint). Component
  /// defaults are interpreted as (r, g, b) in [0, 1].
  Schema& rgbField(const char* name, float r = 1.f, float g = 1.f, float b = 1.f,
                   int io = None) {
    return vec3Field(name, r, g, b, io, 0.f, 1.f, "color");
  }
  /// RGBA color (alias for vec4Field with "color" hint).
  Schema& rgbaField(const char* name, float r = 1.f, float g = 1.f, float b = 1.f,
                    float a = 1.f, int io = None) {
    return vec4Field(name, r, g, b, a, io, 0.f, 1.f, "color");
  }

  /// GPU-resident array. Backed by a GPUBuffer; the JSON state holds
  /// only the buffer handle. Producers must call state::setGpuBuffer
  /// once per allocation and state::markGpuDirty each frame the contents
  /// change. `elementType` is a leaf type name like "float", "int",
  /// "float2", "float4".
  Schema& gpuArrayField(const char* name, const char* elementType, int io = None) {
    beginField(name);
    appendRaw("\"type\":\"array\",\"gpu\":true,\"elementType\":{\"type\":\"");
    appendRaw(elementType);
    appendRaw("\"},\"io\":");
    appendInt(io);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  /// Open a nested object subtree. Returns a child Schema-builder-like
  /// handle. End the subtree with endObject(). When `io` is non-zero
  /// the whole subtree is exposed as a single structural port of that
  /// direction.
  Schema& beginObject(const char* name, int io = None) {
    beginField(name);
    appendRaw("\"type\":\"object\",\"io\":");
    appendInt(io);
    appendOrder();
    appendRaw(",\"fields\":{");
    objectDepth_++;
    objectFieldCounts_[objectDepth_] = 0;
    return *this;
  }

  /// Close the most recent beginObject().
  Schema& endObject() {
    appendRaw("}}");
    if (objectDepth_ > 0) objectDepth_--;
    return *this;
  }

  Schema& textField(const char* name, const char* def = "", int io = None,
                    const char* description = nullptr) {
    beginField(name);
    appendRaw("\"type\":\"string\",\"default\":\"");
    appendJsonString(def);   // escape — defaults may be multi-line CSS/HTML
    appendRaw("\",\"io\":");
    appendInt(io);
    appendFieldMeta(nullptr, description);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  /// Font-family picker: a string field the IDE renders as a searchable font
  /// list with previews (vs. a plain text box). The stored value is the font
  /// family name; the effect reads it via `patchString` like any string field.
  Schema& fontField(const char* name, const char* def = "", int io = None,
                    const char* description = nullptr) {
    beginField(name);
    appendRaw("\"type\":\"font\",\"default\":\"");
    appendJsonString(def);
    appendRaw("\",\"io\":");
    appendInt(io);
    appendFieldMeta(nullptr, description);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  /// Attach a human display name and an optional short/compact name to the
  /// field JUST declared (chained modifier — call it immediately after a
  /// *Field). Both are non-unique / contextual, purely UI metadata. Reopens the
  /// field's closing brace, injects `"name"`/`"short"`, re-closes.
  Schema& label(const char* display, const char* shortName = nullptr) {
    if (len_ > 0 && buf_[len_ - 1] == '}') len_--;   // reopen the just-closed field
    if (display && *display) { appendRaw(",\"name\":\""); appendJsonString(display); appendRaw("\""); }
    if (shortName && *shortName) { appendRaw(",\"short\":\""); appendJsonString(shortName); appendRaw("\""); }
    appendRaw("}");
    return *this;
  }

  /// Begin a parameter GROUP (a first-class section — a natural home for
  /// section-level metadata). STICKY: every field declared afterward is tagged
  /// with this group `id` until the next group() (or group("")/endGroup() to
  /// clear). Passing `display` declares the group's metadata object once (name +
  /// declaration order); enrich it with groupHelp()/groupShort().
  Schema& group(const char* id, const char* display = nullptr) {
    currentGroupLen_ = 0;
    if (id) {
      while (id[currentGroupLen_] && currentGroupLen_ < (int)sizeof(currentGroup_) - 1) {
        currentGroup_[currentGroupLen_] = id[currentGroupLen_]; currentGroupLen_++;
      }
    }
    currentGroup_[currentGroupLen_] = '\0';
    if (currentGroupLen_ > 0 && display) {
      const int cap = (int)sizeof(groupsBuf_);
      if (groupCount_ > 0) rawInto(groupsBuf_, groupsLen_, cap, ",");
      rawInto(groupsBuf_, groupsLen_, cap, "\"");
      jsonInto(groupsBuf_, groupsLen_, cap, currentGroup_);
      rawInto(groupsBuf_, groupsLen_, cap, "\":{\"name\":\"");
      jsonInto(groupsBuf_, groupsLen_, cap, display);
      rawInto(groupsBuf_, groupsLen_, cap, "\",\"order\":");
      intInto(groupsBuf_, groupsLen_, cap, groupCount_);
      rawInto(groupsBuf_, groupsLen_, cap, "}");
      groupCount_++;
    }
    return *this;
  }
  /// Clear the sticky group (subsequent fields are ungrouped).
  Schema& endGroup() { currentGroupLen_ = 0; currentGroup_[0] = '\0'; return *this; }

  /// Enrich the most-recently declared group() with long-form markdown help
  /// (shown at the section header in "?" help mode) or a short/compact name.
  Schema& groupHelp(const char* markdown) { return groupMeta("help", markdown); }
  Schema& groupShort(const char* shortName) { return groupMeta("short", shortName); }

  /// A HELP slot: renders long-form markdown documentation in the inspector's
  /// "?" help mode, interspersed at this position among the fields. Has NO
  /// instance-state backing (io defaults to None → the executor never replays
  /// it). `markdown` is the authored default; users can override it (global or
  /// per-sketch) in the UI. The field `name` is its addressable "slot path"
  /// (custom inspectors hook the same path).
  Schema& helpField(const char* name, const char* markdown, int io = None) {
    beginField(name);
    appendRaw("\"type\":\"help\",\"default\":\"");
    appendJsonString(markdown);
    appendRaw("\",\"io\":");
    appendInt(io);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  /// Declare an effect capability (a queryable classification tag — see the
  /// Capability enum). Chainable and repeatable; declare BOTH the umbrella tag
  /// and the arity/channel-specific tag. Emitted as a top-level `capabilities`
  /// array sibling to `fields`.
  Schema& capability(Capability c) {
    const char* s = capabilityName(c);
    if (capCount_ > 0 && capLen_ < (int)sizeof(capBuf_) - 1) capBuf_[capLen_++] = ',';
    if (capLen_ < (int)sizeof(capBuf_) - 1) capBuf_[capLen_++] = '"';
    while (*s && capLen_ < (int)sizeof(capBuf_) - 2) capBuf_[capLen_++] = *s++;
    if (capLen_ < (int)sizeof(capBuf_) - 1) capBuf_[capLen_++] = '"';
    capCount_++;
    return *this;
  }

  /// Finalize the schema JSON and call the host function.
  void apply(const char* moduleId, Version version) const {
    // Close the JSON. `static` (not a stack array) for the same reason buf_ is
    // inline static — a 64 KB stack local would overflow the WASM stack. Safe:
    // apply() is called synchronously at the end of one module_init's Schema.
    static char finalized[65536];
    int flen = len_;
    if (flen > (int)sizeof(finalized) - 64) flen = (int)sizeof(finalized) - 64;
    for (int i = 0; i < flen; i++) finalized[i] = buf_[i];
    finalized[flen++] = '}';   // close "fields"
    // Top-level `capabilities` array (sibling to "fields"), when any declared.
    if (capCount_ > 0) {
      const char* pfx = ",\"capabilities\":[";
      for (const char* p = pfx; *p && flen < (int)sizeof(finalized) - 4; ++p) finalized[flen++] = *p;
      for (int i = 0; i < capLen_ && flen < (int)sizeof(finalized) - 4; i++) finalized[flen++] = capBuf_[i];
      if (flen < (int)sizeof(finalized) - 2) finalized[flen++] = ']';
    }
    // Top-level `groups` object (sibling to "fields"), when any declared.
    if (groupCount_ > 0) {
      const char* pfx = ",\"groups\":{";
      for (const char* p = pfx; *p && flen < (int)sizeof(finalized) - 4; ++p) finalized[flen++] = *p;
      for (int i = 0; i < groupsLen_ && flen < (int)sizeof(finalized) - 4; i++) finalized[flen++] = groupsBuf_[i];
      if (flen < (int)sizeof(finalized) - 2) finalized[flen++] = '}';
    }
    // Version contract: this effect's own version + its bundle's module version,
    // both as [major,minor,patch]. Recorded onto serialized instances so a load
    // can detect a serialization-incompatible bump (minor) per effect or per
    // module. Siblings of "fields"/"capabilities" at the schema root.
    {
      auto appendStr = [&](const char* s) {
        for (const char* p = s; *p && flen < (int)sizeof(finalized) - 8; ++p) finalized[flen++] = *p;
      };
      auto appendInt = [&](int v) {
        char tmp[16]; int n = 0; int x = v < 0 ? 0 : v;
        do { tmp[n++] = (char)('0' + x % 10); x /= 10; } while (x && n < 15);
        while (n && flen < (int)sizeof(finalized) - 8) finalized[flen++] = tmp[--n];
      };
      auto appendVer = [&](const char* key, Version vv) {
        appendStr(",\""); appendStr(key); appendStr("\":[");
        appendInt(vv.major); if (flen < (int)sizeof(finalized) - 8) finalized[flen++] = ',';
        appendInt(vv.minor); if (flen < (int)sizeof(finalized) - 8) finalized[flen++] = ',';
        appendInt(vv.patch); if (flen < (int)sizeof(finalized) - 8) finalized[flen++] = ']';
      };
      appendVer("effectVersion", version);
      appendVer("moduleVersion", moduleVersionRef());
    }
    finalized[flen++] = '}';   // close root

    state_set_schema(moduleId, std::strlen(moduleId), version.packed(),
                     finalized, flen);
  }

private:
  // Schema JSON accumulator. Sized generously so parameter-rich effects (the
  // style guide encourages exposing lots of params) AND their long-form help
  // markdown defaults don't silently overflow — a truncated schema yields
  // invalid JSON that the web's strict JSON.parse drops entirely, so the
  // inspector shows NO parameters. Keep `finalized[]` in apply() the same size.
  //
  // These big accumulators are `inline static` (NOT per-instance members) so a
  // Schema temporary stays tiny on the stack — two 64 KB stack arrays (buf_ +
  // apply()'s finalized) overflow the small WASM stack in module_init. Sharing
  // one buffer is safe: module_init runs one effect's Schema at a time (never
  // concurrently or reentrantly), and each fresh Schema rewrites from index 0.
  inline static char buf_[65536];
  int len_ = 0;
  // Capability tags, accumulated as the body of the top-level `capabilities`
  // array (e.g. `"modulation_source","modulation_source_single"`) and emitted
  // in apply(). Kept separate from buf_ because the `fields` object is still
  // open while fields are declared.
  inline static char capBuf_[512];
  int capLen_ = 0;
  int capCount_ = 0;
  // Group metadata, accumulated as the body of the top-level `groups` object
  // (e.g. `"form":{"name":"Form","order":0}`). Separate from buf_ because the
  // `fields` object is still open while fields (and their groups) are declared.
  inline static char groupsBuf_[8192];
  int groupsLen_ = 0;
  int groupCount_ = 0;
  // The sticky current group id (NUL-terminated) stamped onto each field's
  // "group" key; empty when no group() is active.
  char currentGroup_[64] = {0};
  int currentGroupLen_ = 0;
  // Per-depth field count: index 0 = top-level fields, 1+ = nested objects.
  int objectFieldCounts_[8] = {0,0,0,0,0,0,0,0};
  int objectDepth_ = 0;

  void beginField(const char* name) {
    int& cnt = objectFieldCounts_[objectDepth_];
    if (cnt > 0) appendRaw(",");
    appendRaw("\"");
    appendRaw(name);
    appendRaw("\":{");
    cnt++;
  }

  // Append the "order" field based on declaration order at the current depth,
  // plus the sticky group id (top-level fields only) when a group() is active.
  void appendOrder() {
    appendRaw(",\"order\":");
    appendInt(objectFieldCounts_[objectDepth_] - 1);
    if (currentGroupLen_ > 0 && objectDepth_ == 0) {
      appendRaw(",\"group\":\"");
      appendJsonString(currentGroup_);
      appendRaw("\"");
    }
  }

  // Reopen the most-recently declared group's object and inject a string key.
  Schema& groupMeta(const char* key, const char* val) {
    if (groupCount_ == 0 || !val || !*val) return *this;
    const int cap = (int)sizeof(groupsBuf_);
    if (groupsLen_ > 0 && groupsBuf_[groupsLen_ - 1] == '}') groupsLen_--;  // reopen last group
    rawInto(groupsBuf_, groupsLen_, cap, ",\"");
    rawInto(groupsBuf_, groupsLen_, cap, key);
    rawInto(groupsBuf_, groupsLen_, cap, "\":\"");
    jsonInto(groupsBuf_, groupsLen_, cap, val);
    rawInto(groupsBuf_, groupsLen_, cap, "\"}");
    return *this;
  }

  Schema& vecField(const char* name, const char* type, int io,
                    int n, float a, float b, float c, float d,
                    float min = 0.f, float max = 1.f,
                    const char* hint = nullptr) {
    beginField(name);
    appendRaw("\"type\":\"");
    appendRaw(type);
    appendRaw("\",\"default\":[");
    float v[4] = {a, b, c, d};
    for (int i = 0; i < n; i++) {
      if (i > 0) appendRaw(",");
      appendFloat(v[i]);
    }
    appendRaw("],\"min\":");
    appendFloat(min);
    appendRaw(",\"max\":");
    appendFloat(max);
    appendRaw(",\"io\":");
    appendInt(io);
    if (hint) {
      appendRaw(",\"hint\":\"");
      appendRaw(hint);
      appendRaw("\"");
    }
    appendOrder();
    appendRaw("}");
    return *this;
  }

  // --- Buffer-append primitives (static so both buf_ and groupsBuf_ reuse them) ---
  static void rawInto(char* dst, int& len, int cap, const char* s) {
    while (*s && len < cap - 1) dst[len++] = *s++;
  }
  static void intInto(char* dst, int& len, int cap, int v) {
    if (v < 0) { rawInto(dst, len, cap, "-"); v = -v; }
    if (v == 0) { rawInto(dst, len, cap, "0"); return; }
    char tmp[16]; int tl = 0;
    while (v > 0 && tl < 15) { tmp[tl++] = (char)('0' + (v % 10)); v /= 10; }
    for (int i = tl - 1; i >= 0; i--) if (len < cap - 1) dst[len++] = tmp[i];
  }
  // Append `s` as the body of a JSON string literal, escaping any character
  // JSON forbids raw (see appendJsonString's note — help/CSS defaults may carry
  // quotes, newlines, control bytes).
  static void jsonInto(char* dst, int& len, int cap, const char* s) {
    static const char kHex[] = "0123456789abcdef";
    while (*s && len < cap - 7) {   // -7 leaves room for \u00XX
      unsigned char c = (unsigned char)*s++;
      switch (c) {
        case '"':  dst[len++]='\\'; dst[len++]='"';  break;
        case '\\': dst[len++]='\\'; dst[len++]='\\'; break;
        case '\n': dst[len++]='\\'; dst[len++]='n';  break;
        case '\r': dst[len++]='\\'; dst[len++]='r';  break;
        case '\t': dst[len++]='\\'; dst[len++]='t';  break;
        case '\b': dst[len++]='\\'; dst[len++]='b';  break;
        case '\f': dst[len++]='\\'; dst[len++]='f';  break;
        default:
          if (c < 0x20) {                            // other control → \u00XX
            dst[len++]='\\'; dst[len++]='u'; dst[len++]='0'; dst[len++]='0';
            dst[len++]=kHex[(c >> 4) & 0xF]; dst[len++]=kHex[c & 0xF];
          } else {
            dst[len++] = (char)c;                    // UTF-8 bytes pass through
          }
      }
    }
  }

  void appendRaw(const char* s) { rawInto(buf_, len_, (int)sizeof(buf_), s); }

  // Append `s` into the schema JSON as the body of a string literal, escaping
  // any character that JSON forbids raw. A textField default can be a whole
  // multi-line stylesheet (source.text.rich) with embedded quotes and newlines; a
  // raw control byte / unescaped quote corrupts the schema JSON and the web's
  // strict JSON.parse rejects it. (Native nlohmann is lenient and would hide it.)
  void appendJsonString(const char* s) { jsonInto(buf_, len_, (int)sizeof(buf_), s); }

  // Optional, shared UI metadata: a `units` suffix ("ms", "Hz", "%") and a
  // human `description`/tooltip. Emitted only when supplied; both go through
  // appendJsonString so free text can't corrupt the schema JSON.
  void appendFieldMeta(const char* units, const char* description) {
    if (units && *units) { appendRaw(",\"units\":\""); appendJsonString(units); appendRaw("\""); }
    if (description && *description) {
      appendRaw(",\"description\":\""); appendJsonString(description); appendRaw("\"");
    }
  }

  void appendInt(int v) { intInto(buf_, len_, (int)sizeof(buf_), v); }

  void appendFloat(float v) {
    int neg = v < 0;
    if (neg) { v = -v; appendRaw("-"); }
    int whole = (int)v;
    int frac = (int)((v - whole) * 10000 + 0.5f);
    appendInt(whole);
    appendRaw(".");
    // 4 decimal digits, zero-padded
    char fd[5] = {
      (char)('0' + (frac / 1000) % 10),
      (char)('0' + (frac / 100) % 10),
      (char)('0' + (frac / 10) % 10),
      (char)('0' + frac % 10),
      0
    };
    appendRaw(fd);
  }
};

/// One-shot init: declare module with schema.
inline void init(const char* id, Version version, const Schema& schema) {
  schema.apply(id, version);
}

inline int getKey(char* buf, int bufLen) {
  return state_get_key(buf, bufLen);
}

// --- Patch access (during on_state_patched callback) ---

/// Get the Nth patch in the current transaction as a val handle.
/// Returns a val::Handle to an object with {op, path, value}.
inline int getPatch(int index) { return state_get_patch(index); }

// Patch op type constants
enum PatchOp : int {
  PatchAdd     = 0,
  PatchRemove  = 1,
  PatchReplace = 2,
  PatchMove    = 3,
  PatchCopy    = 4,
  // Host-emitted "this GPU/struct field was marked dirty" notice (no value
  // change). Effects that only react to value edits keep doing
  // `if (ops[i] != PatchReplace) continue;` and naturally skip it.
  PatchDirty   = 5,
};

/// Check if a patch path matches a field name.
/// Usage in on_state_patched: if (state::pathIs(pb + off[i], len[i], "brightness")) { ... }
inline bool pathIs(const char* path, int pathLen, const char* field) {
  int flen = std::strlen(field);
  return pathLen == flen && std::memcmp(path, field, flen) == 0;
}

/// Read a float value from the Nth patch in the current transaction.
inline float patchFloat(int index) {
  auto patch = val::Value(state::getPatch(index));
  auto v = val::Value(val::get(patch.h, "value"));
  return static_cast<float>(val::asNumber(v.h));
}

/// Read an int value from the Nth patch — for `intField` / `selectField`.
/// (Select/int values ride the same numeric patch channel; this rounds rather
/// than truncates so a 2.9999 round-trip lands on 3.)
inline int patchInt(int index) {
  float f = patchFloat(index);
  return static_cast<int>(f < 0.0f ? f - 0.5f : f + 0.5f);
}

/// Read a bool value from the Nth patch — for `boolField`. True when the
/// numeric value is at/above 0.5 (handles both 0/1 ints and 0.0/1.0 floats).
inline bool patchBool(int index) {
  return patchFloat(index) >= 0.5f;
}

/// Read an `eventField` trigger from the Nth patch: nonzero ⇒ fired this
/// transaction. (Events ride the numeric channel like a momentary bool.)
inline bool patchEvent(int index) {
  return patchFloat(index) != 0.0f;
}

/// Read a string value from the Nth patch into `buf` (NUL-terminated, capped
/// at bufLen-1). Returns the byte length written. Use for `textField` params
/// (e.g. the `text` content of a text node) — there is no string type on the
/// `state::read` path, so string fields must be picked up via patches.
inline int patchString(int index, char* buf, int bufLen) {
  auto patch = val::Value(state::getPatch(index));
  auto v = val::Value(val::get(patch.h, "value"));
  int n = val::asString(v.h, buf, bufLen);
  if (bufLen > 0) { int t = (n < bufLen) ? n : bufLen - 1; buf[t] = '\0'; }
  return n;
}

/// 2/3/4-component vector results from vec patches.
struct PatchVec2 { float x, y; };
struct PatchVec3 { float x, y, z; };
struct PatchVec4 { float x, y, z, w; };

/// Read a vec2/vec3/vec4 value from the Nth patch. Reads `value[0..N-1]`
/// as floats; missing elements default to 0.
inline PatchVec2 patchVec2(int index) {
  auto patch = val::Value(state::getPatch(index));
  auto v = val::Value(val::get(patch.h, "value"));
  PatchVec2 r{0, 0};
  if (val::length(v.h) >= 1) r.x = static_cast<float>(val::asNumber(val::Value(val::getIndex(v.h, 0)).h));
  if (val::length(v.h) >= 2) r.y = static_cast<float>(val::asNumber(val::Value(val::getIndex(v.h, 1)).h));
  return r;
}
inline PatchVec3 patchVec3(int index) {
  auto patch = val::Value(state::getPatch(index));
  auto v = val::Value(val::get(patch.h, "value"));
  PatchVec3 r{0, 0, 0};
  int n = val::length(v.h);
  if (n >= 1) r.x = static_cast<float>(val::asNumber(val::Value(val::getIndex(v.h, 0)).h));
  if (n >= 2) r.y = static_cast<float>(val::asNumber(val::Value(val::getIndex(v.h, 1)).h));
  if (n >= 3) r.z = static_cast<float>(val::asNumber(val::Value(val::getIndex(v.h, 2)).h));
  return r;
}
inline PatchVec4 patchVec4(int index) {
  auto patch = val::Value(state::getPatch(index));
  auto v = val::Value(val::get(patch.h, "value"));
  PatchVec4 r{0, 0, 0, 0};
  int n = val::length(v.h);
  if (n >= 1) r.x = static_cast<float>(val::asNumber(val::Value(val::getIndex(v.h, 0)).h));
  if (n >= 2) r.y = static_cast<float>(val::asNumber(val::Value(val::getIndex(v.h, 1)).h));
  if (n >= 3) r.z = static_cast<float>(val::asNumber(val::Value(val::getIndex(v.h, 2)).h));
  if (n >= 4) r.w = static_cast<float>(val::asNumber(val::Value(val::getIndex(v.h, 3)).h));
  return r;
}

// --- Logging ---

inline void log(const char* msg) {
  state_console_log(0, msg, std::strlen(msg));
}
inline void log(LogLevel level, const char* msg) {
  state_console_log(static_cast<int>(level), msg, std::strlen(msg));
}
inline void logStructured(LogLevel level, const char* msg, const char* json) {
  state_console_log_structured(static_cast<int>(level),
      msg, std::strlen(msg), json, std::strlen(json));
}

// --- State publishing ---

/// Publish a val handle as the module's state (or at a sub-path).
inline void setVal(int valHandle) {
  state_set_val("", 0, valHandle);
}
inline void setValPath(const char* path, int valHandle) {
  state_set_val(path, std::strlen(path), valHandle);
}

// --- GPU array fields ---

/// Signal that the GPU array at `path` has been updated in-place.
/// Observers receive a "dirty" patch but no value, so they can do
/// lazy reader work without re-resolving the buffer handle.
/// Call this every frame a GPU-resident array is refreshed, even if
/// the underlying buffer is being reused.
inline void markGpuDirty(const char* path) {
  state_mark_gpu_dirty(path, std::strlen(path));
}

/// Assign a GPU buffer handle to the field at `path`. Only call when
/// the producer (re)allocates the buffer — buffer reuse across frames
/// should elide this call and use markGpuDirty alone.
inline void setGpuBuffer(const char* path, int bufferHandle) {
  state_set_gpu_buffer(path, std::strlen(path), bufferHandle);
}

/// Assign a GPU texture handle to the field at `path`. Same shape as
/// setGpuBuffer — only call on (re)allocation; texture reuse across
/// frames should elide this call. Used for the writer side of struct
/// rails containing texture leaves (e.g. RenderOutputs.motion).
inline void setGpuTexture(const char* path, int textureHandle) {
  state_set_gpu_texture(path, std::strlen(path), textureHandle);
}

/// Mark a schema field as hidden / visible in the IDE inspector. Hidden
/// fields keep their values and continue to participate in
/// notifyStatePatched and rail routing — this is purely a UI overlay.
///
/// Usage pattern: register *every* parameter the effect can ever expose
/// in `init()` (with sensible defaults). Then in the on-state-ready
/// callback — which fires once after init + the initial state replay
/// — toggle visibility based on the restored state. In
/// `on_state_patched()`, when a "mode-selector" field changes,
/// re-toggle the dependent fields. The IDE picks up visibility changes
/// on the next broadcast.
inline void setFieldHidden(const char* path, bool hidden) {
  state_set_field_hidden(path, std::strlen(path), hidden ? 1 : 0);
}

/// Register a callback fired once per instance, after `init()` and
/// after the initial serialized-state replay (or immediately after
/// init if there's no saved state). Use this to set field visibility
/// based on the restored state — the IDE inspector renders the
/// post-callback schema, so the user never sees a transient "all
/// fields visible" state.
///
/// Typically called from inside `init()`:
///
///   void init() {
///     state::init(...);
///     state::setOnStateReady(&my_state_ready);
///   }
///   void my_state_ready(void* self) {
///     auto* s = static_cast<State*>(self);
///     state::setFieldHidden("inset_left",  s->mode != Inset);
///     ...
///   }
///
/// CANONICAL PATTERN — react to DESERIALIZATION via `on_state_patched`, NOT
/// `tick`. Any schema-affecting recompute that depends on serialized values
/// (field visibility, and — for a `sketch_input_source` effect — which
/// parameters are exposed/active) must run in `on_state_patched`, which fires
/// for every patch INCLUDING the initial state replay on load. On web that
/// recompute (via setFieldHidden) propagates to the inspector IMMEDIATELY (it
/// dirties the engine state → broadcast), so the schema is correct on load
/// without waiting for a step. `setOnStateReady` is a convenience for the
/// no-saved-state case and to reaffirm after replay; effects that recompute in
/// `on_state_patched` already track restored state without it. (Note: on the
/// native barrel render path this hook is a visibility-only no-op — see
/// host_functions.cpp — so never put render-affecting logic here.)
inline void setOnStateReady(void (*fn)(void* self)) {
  state_set_on_state_ready(fn);
}

// --- Connection introspection ---

/// True if the input field at `path` is connected to a producer through
/// the current sketch's tap topology (i.e. an upstream effect has a
/// write tap on the same rail this effect's read tap targets).
///
/// Effects use this to detect "wired in / dangling input" — e.g.
/// motion_blur skips the blur pass and pass-throughs when its
/// render_outputs input has no upstream writer.
///
/// The path is the schema field name (or slash-delimited subpath for
/// struct leaves). The result reflects the sketch as of the most recent
/// render() entry.
inline bool isInputConnected(const char* path) {
  return state_is_field_connected(path, std::strlen(path), 0) != 0;
}

/// True if the output field at `path` is connected to a consumer through
/// the current sketch's tap topology (i.e. some downstream effect has a
/// read tap on the same rail this effect's write tap targets).
///
/// Effects use this to skip work whose only purpose is publishing a
/// side-output — e.g. a motion-vector generator can skip its motion pass
/// when no downstream effect reads render_outputs.
inline bool isOutputConnected(const char* path) {
  return state_is_field_connected(path, std::strlen(path), 1) != 0;
}

/// True when this effect's output will actually be drawn this frame. False
/// only when the host is skipping render() due to zero opacity (it aliases the
/// input through instead). tick() still runs while "not rendering", so check
/// this in tick() to skip render-prep / expensive simulation you won't need.
inline bool willRender() {
  return state_will_render() != 0;
}

// ========================================================================
// Shader registration (platform-agnostic)
// ========================================================================

/// Register a SPIR-V blob under `name`. The host stores the bytes
/// and converts them to the platform-native shader source (WGSL on
/// the web via the dev-server's naga endpoint; MSL on native Metal)
/// the first time `gpu::Device::createShaderModule(name)` references
/// the same name. Effects no longer carry per-platform shader text —
/// just the universal SPIR-V the build pipeline emitted via DXC.
///
/// Typical usage in `init()`:
///
///   state::registerShaderSPV("compute", COMPUTE_SPV, sizeof(COMPUTE_SPV));
///   auto cs = gpu::Device::createShaderModule("compute");
inline void registerShaderSPV(const char* name, const void* spv, int spv_size,
                              const char* format = nullptr,
                              const char* access = nullptr) {
  state_register_shader_spv(name, std::strlen(name),
                             static_cast<const unsigned char*>(spv), spv_size,
                             format, format ? (int)std::strlen(format) : 0,
                             access, access ? (int)std::strlen(access) : 0);
}

// ========================================================================
// Fusion registration
// ========================================================================

/// Coalescing class an effect declares so the engine can fuse adjacent
/// stages within a column. Default for any effect that never calls
/// registerFusion is Freeform (no fusion).
enum class FusionKind : int {
  Freeform        = 0,  // Anything that uses multi-pass, samplers, mip
                        // chains, render passes, etc. Runs alone.
  PerPixelMapper  = 1,  // Reads only inputTex[gid.xy], writes only
                        // outputTex[gid.xy]. The engine can splice the
                        // per-pixel transform into a fused dispatch.
  StrictOutput    = 2,  // Writes every output pixel exactly once. Reads
                        // anything (no input texture, neighbor reads,
                        // generators, etc.). Can be the top of a fused
                        // run with mapper tails.
};

/// Register fusion metadata for the currently-initializing effect. Call
/// from inside `init()`, after `state::init(...)`. Effects that don't
/// call this stay `Freeform` — the engine never fuses them.
///
/// The fragment SPV must have been registered earlier via
/// `state::registerShaderSPV(fragment_name, ...)` — the fragment defines
/// `fuse_transform` and `FuseUniforms` (built by the
/// compile_shaders_compute_fused helper). The runtime resolves the
/// platform source (SPV → WGSL via naga on web; baked MSL natively) and
/// strips the synthetic wrapper main automatically.
///
/// Parameters:
///   uniform_buf_handle — current handle of the effect's uniform
///                      buffer (typically `s_uniform_buf.handle()`).
///                      The engine binds this directly into the fused
///                      dispatch.
///   uniform_size_bytes — sizeof(Uniforms).
///   prepare          — callback invoked once per frame for each fused
///                      stage, instead of `render`. Should write the
///                      uniform buffer (and only the uniform buffer).
///                      For non-fused execution `render` runs as today;
///                      most effects implement `render` as
///                      `prepare(); dispatch();` so behavior is shared.
inline void registerFusionByName(FusionKind kind,
                                 const char* fragment_name,
                                 int uniform_buf_handle,
                                 int uniform_size_bytes,
                                 void (*prepare)(void* self, int vp_w, int vp_h)) {
  state_register_fusion_by_name(static_cast<int>(kind),
                                 fragment_name, (int)std::strlen(fragment_name),
                                 uniform_buf_handle, uniform_size_bytes, prepare);
}

} // namespace state

namespace resolume {

inline double getParam(int64_t id) { return resolume_get_param(id); }
inline void setParam(int64_t id, double value) { resolume_set_param(id, value); }
inline void subscribe(const char* query) {
  resolume_subscribe_query(query, std::strlen(query));
}
inline int getParamPath(int64_t id, char* buf, int bufLen) {
  return resolume_get_param_path(id, buf, bufLen);
}
inline int clipCount() { return resolume_get_clip_count(); }
inline int64_t clipId(int index) { return resolume_get_clip_id(index); }
inline int clipChannel(int index) { return resolume_get_clip_channel(index); }
inline int clipConnected(int index) { return resolume_get_clip_connected(index); }
inline int clipName(int index, char* buf, int bufLen) {
  return resolume_get_clip_name(index, buf, bufLen);
}
inline void triggerClip(int64_t clipId, bool on) {
  resolume_trigger_clip(clipId, on ? 1 : 0);
}

} // namespace resolume
