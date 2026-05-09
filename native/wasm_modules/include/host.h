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
  // canvas
  __attribute__((import_module("canvas"), import_name("fill_rect")))
  void canvas_fill_rect(float x, float y, float w, float h, float r, float g, float b, float a);
  __attribute__((import_module("canvas"), import_name("draw_image")))
  void canvas_draw_image(int tex_id, float x, float y, float w, float h);
  __attribute__((import_module("canvas"), import_name("draw_text")))
  void canvas_draw_text(const char* text, int len, float x, float y, float size, float r, float g, float b, float a);

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
  // Legacy stub — no-op on the host side, but import must exist for old modules
  __attribute__((import_module("state"), import_name("declare_param")))
  void state_declare_param(int index, const char* name, int name_len, int type, float default_value);
  __attribute__((import_module("state"), import_name("get_key")))
  int state_get_key(char* buf, int buf_len);
  __attribute__((import_module("state"), import_name("console_log")))
  void state_console_log(int level, const char* msg, int msg_len);
  __attribute__((import_module("state"), import_name("console_log_structured")))
  void state_console_log_structured(int level, const char* msg, int msg_len,
                                     const char* json, int json_len);
  // Legacy stub — no-op on the host side
  __attribute__((import_module("state"), import_name("set")))
  void state_set(const char* path, int path_len, const char* json, int json_len);
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
  __attribute__((import_module("state"), import_name("set_on_state_ready")))
  void state_set_on_state_ready(void (*fn)(void));
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
  // Register fusion metadata. See state::registerFusion below.
  __attribute__((import_module("state"), import_name("register_fusion")))
  void state_register_fusion(int kind,
                              const char* wgsl, int wgsl_len,
                              const char* msl,  int msl_len,
                              int uniform_buf_handle,
                              int uniform_size_bytes,
                              void (*prepare)(int vp_w, int vp_h));
  // Register fusion metadata, with the per-pixel kernel sourced by
  // NAME (registered earlier via state::registerShaderSPV) instead
  // of inline WGSL/MSL text. The runtime fetches SPV → WGSL via the
  // dev server's naga endpoint and runs the strip pass on demand.
  __attribute__((import_module("state"), import_name("register_fusion_by_name")))
  void state_register_fusion_by_name(int kind,
                                      const char* fragment_name, int fragment_name_len,
                                      int uniform_buf_handle,
                                      int uniform_size_bytes,
                                      void (*prepare)(int vp_w, int vp_h));
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

namespace canvas {

inline void fillRect(float x, float y, float w, float h,
                     float r, float g, float b, float a = 1.0f) {
  canvas_fill_rect(x, y, w, h, r, g, b, a);
}
inline void drawImage(int texId, float x, float y, float w, float h) {
  canvas_draw_image(texId, x, y, w, h);
}
inline void drawText(const char* text, float x, float y, float size,
                     float r, float g, float b, float a = 1.0f) {
  canvas_draw_text(text, std::strlen(text), x, y, size, r, g, b, a);
}

} // namespace canvas

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

// --- Parameter types (matching FFGL, kept for legacy compat) ---
enum class ParamType : int {
  Boolean = 0,
  Event = 1,
  Standard = 10,
  Option = 11,
  Integer = 13,
  Text = 100,
};

// --- Log levels ---
enum class LogLevel : int { Info = 0, Warn = 1, Error = 2 };

// --- Version ---
struct Version {
  int major, minor, patch;
  int packed() const { return (major << 16) | (minor << 8) | patch; }
};

// ========================================================================
// Schema builder — unified module declaration
// ========================================================================

class Schema {
public:
  Schema() {
    appendRaw("{\"fields\":{");
  }

  Schema& floatField(const char* name, float def, float min, float max, int io = None) {
    beginField(name);
    appendRaw("\"type\":\"float\",\"default\":");
    appendFloat(def);
    appendRaw(",\"min\":");
    appendFloat(min);
    appendRaw(",\"max\":");
    appendFloat(max);
    appendRaw(",\"io\":");
    appendInt(io);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  Schema& intField(const char* name, int def, int min, int max, int io = None) {
    beginField(name);
    appendRaw("\"type\":\"int\",\"default\":");
    appendInt(def);
    appendRaw(",\"min\":");
    appendInt(min);
    appendRaw(",\"max\":");
    appendInt(max);
    appendRaw(",\"io\":");
    appendInt(io);
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
  Schema& selectField(const char* name, int def, int io,
                      std::initializer_list<SelectOption> options) {
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
    appendOrder();
    appendRaw("}");
    return *this;
  }

  Schema& boolField(const char* name, bool def = false, int io = None) {
    beginField(name);
    appendRaw("\"type\":\"bool\",\"default\":");
    appendRaw(def ? "true" : "false");
    appendRaw(",\"io\":");
    appendInt(io);
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

  Schema& textField(const char* name, const char* def = "", int io = None) {
    beginField(name);
    appendRaw("\"type\":\"string\",\"default\":\"");
    appendRaw(def);
    appendRaw("\",\"io\":");
    appendInt(io);
    appendOrder();
    appendRaw("}");
    return *this;
  }

  /// Finalize the schema JSON and call the host function.
  void apply(const char* moduleId, Version version) const {
    // Close the JSON
    char finalized[4096];
    int flen = len_;
    if (flen > (int)sizeof(finalized) - 4) flen = (int)sizeof(finalized) - 4;
    for (int i = 0; i < flen; i++) finalized[i] = buf_[i];
    finalized[flen++] = '}';
    finalized[flen++] = '}';

    state_set_schema(moduleId, std::strlen(moduleId), version.packed(),
                     finalized, flen);
  }

private:
  char buf_[4096];
  int len_ = 0;
  // Per-depth field count: index 0 = top-level fields, 1+ = nested objects.
  int objectFieldCounts_[8] = {0,0,0,0,0,0,0,0};
  int objectDepth_ = 0;
  // Convenience alias preserved for reference; no longer load-bearing.
  int fieldCount_ = 0;

  void beginField(const char* name) {
    int& cnt = objectFieldCounts_[objectDepth_];
    if (cnt > 0) appendRaw(",");
    appendRaw("\"");
    appendRaw(name);
    appendRaw("\":{");
    cnt++;
    fieldCount_ = objectFieldCounts_[0];
  }

  // Append the "order" field based on declaration order at the current depth.
  void appendOrder() {
    appendRaw(",\"order\":");
    appendInt(objectFieldCounts_[objectDepth_] - 1);
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

  void appendRaw(const char* s) {
    while (*s && len_ < (int)sizeof(buf_) - 1) buf_[len_++] = *s++;
  }

  void appendInt(int v) {
    char tmp[16];
    int neg = v < 0;
    if (neg) { v = -v; appendRaw("-"); }
    if (v == 0) { appendRaw("0"); return; }
    int tl = 0;
    while (v > 0 && tl < 15) { tmp[tl++] = '0' + (v % 10); v /= 10; }
    for (int i = tl - 1; i >= 0; i--) {
      if (len_ < (int)sizeof(buf_) - 1) buf_[len_++] = tmp[i];
    }
  }

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
///   void my_state_ready() {
///     state::setFieldHidden("inset_left",  s_mode != Inset);
///     ...
///   }
inline void setOnStateReady(void (*fn)(void)) {
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
/// Parameters:
///   kind             — fusion class, see FusionKind.
///   fragment_wgsl    — WGSL fragment defining `fuse_transform` and
///                      `FuseUniforms` (built by the
///                      compile_shaders_compute_fused build helper into
///                      `<effect>_shaders.h` as PIXEL_WGSL[]).
///   fragment_msl     — MSL counterpart (PIXEL_MSL[]).
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
///
/// Note: WGSL and MSL strings are passed explicitly because every effect
/// already picks its backend at createShaderModule time. Folding that
/// into the host is a separate refactor.
inline void registerFusion(FusionKind kind,
                           const char* fragment_wgsl,
                           const char* fragment_msl,
                           int uniform_buf_handle,
                           int uniform_size_bytes,
                           void (*prepare)(int vp_w, int vp_h)) {
  state_register_fusion(static_cast<int>(kind),
                        fragment_wgsl, fragment_wgsl ? (int)std::strlen(fragment_wgsl) : 0,
                        fragment_msl,  fragment_msl  ? (int)std::strlen(fragment_msl)  : 0,
                        uniform_buf_handle, uniform_size_bytes, prepare);
}

/// Newer, name-based variant. The fragment SPV must have been
/// registered earlier via `state::registerShaderSPV(fragment_name, ...)`.
/// The runtime translates SPV → WGSL via naga and strips the
/// synthetic wrapper main automatically.
inline void registerFusionByName(FusionKind kind,
                                 const char* fragment_name,
                                 int uniform_buf_handle,
                                 int uniform_size_bytes,
                                 void (*prepare)(int vp_w, int vp_h)) {
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
