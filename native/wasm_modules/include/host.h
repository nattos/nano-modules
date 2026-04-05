#pragma once
/*
 * host.h — C++ wrappers for host.*, state.*, canvas.*, and resolume.* APIs.
 */

#include <cstring>
#include <cstdint>

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
  __attribute__((import_module("state"), import_name("declare_param")))
  void state_declare_param(int index, const char* name, int name_len, int type, float default_value);
  __attribute__((import_module("state"), import_name("get_key")))
  int state_get_key(char* buf, int buf_len);
  __attribute__((import_module("state"), import_name("console_log")))
  void state_console_log(int level, const char* msg, int msg_len);
  __attribute__((import_module("state"), import_name("console_log_structured")))
  void state_console_log_structured(int level, const char* msg, int msg_len,
                                     const char* json, int json_len);
  __attribute__((import_module("state"), import_name("set")))
  void state_set(const char* path, int path_len, const char* json, int json_len);
  __attribute__((import_module("state"), import_name("read")))
  int state_read(const char* layout, int field_count, const char* paths,
                 char* output, int output_size, char* results);

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

// --- Timing ---

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

// --- Parameter types (matching FFGL) ---
enum class ParamType : int {
  Boolean = 0,
  Event = 1,
  Standard = 10,  // float 0-1
  Option = 11,
  Integer = 13,
  Text = 100,
};

// --- Log levels ---
enum class LogLevel : int { Info = 0, Warn = 1, Error = 2 };

// --- Plugin registration ---

struct Version {
  int major, minor, patch;
  int packed() const { return (major << 16) | (minor << 8) | patch; }
};

inline void setMetadata(const char* id, Version version) {
  state_set_metadata(id, std::strlen(id), version.packed());
}

inline void declareParam(int index, const char* name, ParamType type, float defaultValue = 0.0f) {
  state_declare_param(index, name, std::strlen(name), static_cast<int>(type), defaultValue);
}

// Get the assigned plugin key (e.g. "com.nattos.foo@0")
inline int getKey(char* buf, int bufLen) {
  return state_get_key(buf, bufLen);
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

inline void set(const char* json, int jsonLen) {
  state_set("", 0, json, jsonLen);
}

inline void setPath(const char* path, const char* json) {
  state_set(path, std::strlen(path), json, std::strlen(json));
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
