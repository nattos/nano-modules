#include "wasm/host_functions.h"
#include "wasm/wasm_host.h"
#include "wasm/wasm_context.h"
#include "wasm/audio_bus.h"
#include "wasm/effect_host_sink.h"
#include "bridge/param_cache.h"
#include "bridge/state_document.h"
#include "gpu/gpu_backend.h"
#include "json/json_doc.h"
#include "sketch/comp/streams_table.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

namespace wasm {

// --- Context access helpers ---

static WasmContext* get_ctx(wasm_exec_env_t env) {
  return static_cast<WasmContext*>(wasm_runtime_get_user_data(env));
}

static WasmHost* get_host(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->host : nullptr;
}

static FrameState* get_frame(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->frame_state : nullptr;
}

// ========================================================================
// Module "env" — legacy/backward-compatible functions
// ========================================================================

static double env_resolume_get_param(wasm_exec_env_t env, int64_t param_id) {
  auto* host = get_host(env);
  if (!host) return 0.0;
  return host->param_cache().get(param_id);
}

static void env_resolume_set_param(wasm_exec_env_t env, int64_t param_id, double value) {
  auto* host = get_host(env);
  if (!host) return;
  host->param_cache().set(param_id, value);
  host->param_cache().queue_write(param_id, value);
}

static void env_log(wasm_exec_env_t env, int32_t msg_ptr, int32_t msg_len) {
  auto* host = get_host(env);
  if (!host) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, msg_ptr, msg_len)) return;
  char* native_ptr = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, msg_ptr));
  if (!native_ptr) return;
  host->log(std::string(native_ptr, msg_len));
}

// Math builtins — WASM clang may emit these as imports
static double env_fmod(wasm_exec_env_t env, double a, double b) {
  return fmod(a, b);
}

static float env_fmodf(wasm_exec_env_t env, float a, float b) {
  return fmodf(a, b);
}

static float env_sinf(wasm_exec_env_t env, float a) {
  return sinf(a);
}

static double env_floor(wasm_exec_env_t env, double a) {
  return floor(a);
}

static double env_fabs(wasm_exec_env_t env, double a) {
  return fabs(a);
}

static int32_t env_strlen(wasm_exec_env_t env, int32_t ptr) {
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  // Find the null terminator
  int32_t len = 0;
  while (true) {
    if (!wasm_runtime_validate_app_addr(inst, ptr + len, 1)) break;
    char* p = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, ptr + len));
    if (!p || *p == '\0') break;
    len++;
  }
  return len;
}

static NativeSymbol env_symbols[] = {
    {"resolume_get_param", reinterpret_cast<void*>(env_resolume_get_param), "(I)F", nullptr},
    {"resolume_set_param", reinterpret_cast<void*>(env_resolume_set_param), "(IF)", nullptr},
    {"log", reinterpret_cast<void*>(env_log), "(ii)", nullptr},
    {"fmod", reinterpret_cast<void*>(env_fmod), "(FF)F", nullptr},
    {"fmodf", reinterpret_cast<void*>(env_fmodf), "(ff)f", nullptr},
    {"sinf", reinterpret_cast<void*>(env_sinf), "(f)f", nullptr},
    {"floor", reinterpret_cast<void*>(env_floor), "(F)F", nullptr},
    {"fabs", reinterpret_cast<void*>(env_fabs), "(F)F", nullptr},
    {"strlen", reinterpret_cast<void*>(env_strlen), "(i)i", nullptr},
};

// ========================================================================
// Module "host" — timing, parameters, audio
// ========================================================================

static double host_get_time(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->elapsed_time : 0.0;
}

static double host_get_delta_time(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->delta_time : 0.0;
}

static double host_get_bar_phase(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->bar_phase : 0.0;
}

static double host_get_bpm(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->bpm : 120.0;
}

static double host_get_param(wasm_exec_env_t env, int32_t index) {
  auto* f = get_frame(env);
  if (!f || index < 0 || index >= FrameState::MAX_PARAMS) return 0.0;
  return f->ffgl_params[index];
}

static int32_t host_get_viewport_w(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->viewport_w : 0;
}

static int32_t host_get_viewport_h(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->viewport_h : 0;
}

static void host_log_fn(wasm_exec_env_t env, int32_t msg_ptr, int32_t msg_len) {
  env_log(env, msg_ptr, msg_len); // reuse env.log implementation
}

static void host_trigger_audio(wasm_exec_env_t env, int32_t channel) {
  auto* ctx = get_ctx(env);
  // Fan out to native listeners (audio_bus) tagged with the firing instance's
  // namespaced key, so a NanoLooper FFGL shell driving its Synth hears only its
  // own triggers even with several loopers in one process. The executor sets
  // ctx->effect_instance for the duration of each effect call.
  std::string key;
  if (ctx && ctx->effect_instance) key = ctx->effect_instance->instanceKey();
  audio_bus::fire(key.c_str(), channel);
  // Legacy per-module callback (old bridge_load_wasm/WasmHost path). Unused by
  // the shared-executor barrel path; kept for back-compat.
  if (ctx && ctx->audio_callback) {
    ctx->audio_callback(channel, ctx->audio_userdata);
  }
}

static NativeSymbol host_symbols[] = {
    {"get_time", reinterpret_cast<void*>(host_get_time), "()F", nullptr},
    {"get_delta_time", reinterpret_cast<void*>(host_get_delta_time), "()F", nullptr},
    {"get_bar_phase", reinterpret_cast<void*>(host_get_bar_phase), "()F", nullptr},
    {"get_bpm", reinterpret_cast<void*>(host_get_bpm), "()F", nullptr},
    {"get_param", reinterpret_cast<void*>(host_get_param), "(i)F", nullptr},
    {"get_viewport_w", reinterpret_cast<void*>(host_get_viewport_w), "()i", nullptr},
    {"get_viewport_h", reinterpret_cast<void*>(host_get_viewport_h), "()i", nullptr},
    {"log", reinterpret_cast<void*>(host_log_fn), "(ii)", nullptr},
    {"trigger_audio", reinterpret_cast<void*>(host_trigger_audio), "(i)", nullptr},
};

// ========================================================================
// Module "resolume" — composition queries
// ========================================================================

static double resolume_get_param(wasm_exec_env_t env, int64_t param_id) {
  auto* host = get_host(env);
  if (!host) return 0.0;
  return host->param_cache().get(param_id);
}

static void resolume_set_param(wasm_exec_env_t env, int64_t param_id, double value) {
  auto* host = get_host(env);
  if (!host) return;
  host->param_cache().set(param_id, value);
  host->param_cache().queue_write(param_id, value);
}

static void resolume_trigger_clip(wasm_exec_env_t env, int64_t clip_id, int32_t on) {
  // TODO: forward to bridge server's Resolume WS client
  (void)clip_id;
  (void)on;
}

static void resolume_subscribe_param(wasm_exec_env_t env, int64_t param_id) {
  // TODO: forward to bridge server's Resolume WS client
  (void)param_id;
}

static int32_t resolume_get_clip_count(wasm_exec_env_t env) {
  // TODO: read from CompositionCache
  return 0;
}

static int64_t resolume_get_clip_id(wasm_exec_env_t env, int32_t index) {
  // TODO: read from CompositionCache
  (void)index;
  return 0;
}

static int32_t resolume_get_clip_channel(wasm_exec_env_t env, int32_t index) {
  // TODO: read from CompositionCache
  (void)index;
  return -1;
}

static int32_t resolume_get_clip_name(wasm_exec_env_t env, int32_t index,
                                       int32_t buf_ptr, int32_t buf_len) {
  // TODO: read from CompositionCache
  (void)index; (void)buf_ptr; (void)buf_len;
  return 0;
}

static int32_t resolume_get_clip_connected(wasm_exec_env_t env, int32_t index) {
  // TODO: read from CompositionCache
  (void)index;
  return 0;
}

static double resolume_get_bpm(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->bpm : 120.0;
}

static int32_t resolume_load_thumbnail(wasm_exec_env_t env, int32_t clip_index) {
  // TODO: forward to bridge server image loader
  (void)clip_index;
  return -1;
}

static void resolume_subscribe_query(wasm_exec_env_t env,
    int32_t query_ptr, int32_t query_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, query_ptr, query_len)) return;
  char* q = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, query_ptr));
  if (!q) return;

  std::string query(q, query_len);
  // Store subscription queries on the context for the host to match against
  // "/*" or "*" subscribes to everything
  ctx->subscribe_queries.push_back(query);
}

static int32_t resolume_get_param_path(wasm_exec_env_t env,
    int64_t param_id, int32_t buf_ptr, int32_t buf_len) {
  // TODO: look up path from composition cache or param_paths_ map
  // For now, return a placeholder path based on the ID
  auto* ctx = get_ctx(env);
  if (!ctx) return 0;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) return 0;
  char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
  if (!buf) return 0;

  std::string path = "param/" + std::to_string(param_id);
  int32_t copy_len = std::min((int32_t)path.size(), buf_len);
  memcpy(buf, path.data(), copy_len);
  return copy_len;
}

static NativeSymbol resolume_symbols[] = {
    {"get_param", reinterpret_cast<void*>(resolume_get_param), "(I)F", nullptr},
    {"set_param", reinterpret_cast<void*>(resolume_set_param), "(IF)", nullptr},
    {"trigger_clip", reinterpret_cast<void*>(resolume_trigger_clip), "(Ii)", nullptr},
    {"subscribe_param", reinterpret_cast<void*>(resolume_subscribe_param), "(I)", nullptr},
    {"get_clip_count", reinterpret_cast<void*>(resolume_get_clip_count), "()i", nullptr},
    {"get_clip_id", reinterpret_cast<void*>(resolume_get_clip_id), "(i)I", nullptr},
    {"get_clip_channel", reinterpret_cast<void*>(resolume_get_clip_channel), "(i)i", nullptr},
    {"get_clip_name", reinterpret_cast<void*>(resolume_get_clip_name), "(iii)i", nullptr},
    {"get_clip_connected", reinterpret_cast<void*>(resolume_get_clip_connected), "(i)i", nullptr},
    {"get_bpm", reinterpret_cast<void*>(resolume_get_bpm), "()F", nullptr},
    {"load_thumbnail", reinterpret_cast<void*>(resolume_load_thumbnail), "(i)i", nullptr},
    {"subscribe_query", reinterpret_cast<void*>(resolume_subscribe_query), "(ii)", nullptr},
    {"get_param_path", reinterpret_cast<void*>(resolume_get_param_path), "(Iii)i", nullptr},
};

// ========================================================================
// Module "streams" — the seekable-streams surface (streams_table.h registry;
// effect-side header wasm_modules/include/streams.h). Null registry (plugin
// shell, tests, standalone sketch) ⇒ the session-clock-only world backed by
// frame_state. All per-frame answers are flat scalars or fixed-layout copies
// — no JSON anywhere on this path.
// ========================================================================

static comp::StreamsTable* get_streams(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->streams_table : nullptr;
}

static const comp::StreamInfo* resolve_stream(wasm_exec_env_t env, int64_t h) {
  const auto* t = get_streams(env);
  return t ? t->find(h) : nullptr;
}

static double session_sec(wasm_exec_env_t env) {
  auto* f = get_frame(env);
  return f ? f->elapsed_time : 0.0;
}

static int64_t streams_parent_fn(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  const auto* t = get_streams(env);
  if (t && ctx && ctx->effect_instance) {
    const std::string& key = ctx->effect_instance->instanceKey();
    if (const std::string* clipId = comp::clipIdForInstanceKey(*t, key)) {
      auto it = t->parentByClipId.find(*clipId);
      if (it != t->parentByClipId.end()) return it->second;
    }
    // Track-hosted effects (track FX, track transport sections): the parent
    // transport is the track's own stream.
    if (const std::string* trackId = comp::trackIdForInstanceKey(*t, key)) {
      auto it = t->trackByTrackId.find(*trackId);
      if (it != t->trackByTrackId.end()) return it->second;
    }
  }
  return comp::kStreamSessionClock;
}

static int64_t streams_content_fn(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  const auto* t = get_streams(env);
  if (t && ctx && ctx->effect_instance) {
    const std::string& key = ctx->effect_instance->instanceKey();
    if (const std::string* clipId = comp::clipIdForInstanceKey(*t, key)) {
      auto it = t->contentByClipId.find(*clipId);
      if (it != t->contentByClipId.end()) return it->second;
    }
  }
  return comp::kStreamInvalid;
}

static int64_t streams_timeline_fn(wasm_exec_env_t env) {
  return get_streams(env) ? comp::kStreamTimeline : comp::kStreamInvalid;
}

static int32_t streams_count_fn(wasm_exec_env_t env) {
  const auto* t = get_streams(env);
  return t ? t->enumCount : 1;
}

static int64_t streams_at_fn(wasm_exec_env_t env, int32_t index) {
  const auto* t = get_streams(env);
  if (!t) return index == 0 ? comp::kStreamSessionClock : comp::kStreamInvalid;
  if (index < 0 || index >= t->enumCount) return comp::kStreamInvalid;
  return t->streams[static_cast<size_t>(index)].handle;
}

static int32_t streams_name_fn(wasm_exec_env_t env, int64_t h, int32_t buf_ptr,
                               int32_t buf_len) {
  const auto* s = resolve_stream(env, h);
  if (!s) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (buf_len > 0 && wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) {
    char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
    if (buf) {
      const int32_t copy = std::min(static_cast<int32_t>(s->name.size()), buf_len);
      memcpy(buf, s->name.data(), static_cast<size_t>(copy));
    }
  }
  return static_cast<int32_t>(s->name.size());  // full length (grow-and-retry)
}

static int32_t streams_describe_fn(wasm_exec_env_t env, int64_t h, int32_t desc_ptr) {
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, desc_ptr, 4)) return 0;
  int32_t* head = static_cast<int32_t*>(wasm_runtime_addr_app_to_native(inst, desc_ptr));
  if (!head) return 0;
  constexpr int32_t kKnown = 48;  // sizeof(StreamDesc) fields the host fills
  const int32_t sent = *head;
  const int32_t fill = std::min(sent, kKnown);
  if (fill < 4 || !wasm_runtime_validate_app_addr(inst, desc_ptr, fill)) return 0;
  int32_t* out = head;

  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(h) : nullptr;
  int32_t fields[12] = {sent, comp::kStreamKindInvalid, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0};
  if (s) {
    fields[1] = s->kind;
    fields[2] = s->flags | (s->declared ? comp::kStreamDriven : 0);
    fields[3] = s->axis;
    fields[4] = s->frameCount;
    fields[5] = comp::isContentStream(*s)
                    ? comp::contentEventCount(*s, comp::streamElapsed(*s, *t, session_sec(env)))
                    : static_cast<int32_t>(s->events.size());
    fields[6] = s->eventRev;
    fields[7] = s->index;
    fields[8] = s->clipCount;
  } else if (!t && h == comp::kStreamSessionClock) {
    fields[1] = comp::kStreamKindSessionClock;
    fields[2] = comp::kStreamLiveOnly;
    fields[3] = comp::kStreamAxisSeconds;
    fields[7] = 0;
  }
  const int32_t nWords = fill / 4;
  for (int32_t k = 1; k < nWords; ++k) out[k] = fields[k];
  return fields[1] != comp::kStreamKindInvalid ? 1 : 0;
}

static int32_t streams_rev_fn(wasm_exec_env_t env, int64_t h) {
  const auto* t = get_streams(env);
  if (!t) return 0;
  const comp::StreamInfo* s = t->find(h);
  return s ? s->eventRev : t->docRev;
}

// Shared per-kind evaluators live in streams_table.h (lock-step with the web
// registry) — these thunks only marshal.
static double streams_pos_fn(wasm_exec_env_t env, int64_t h) {
  auto* ctx = get_ctx(env);
  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(h) : nullptr;
  if (!s || !ctx->streams_clock) {
    if (h == comp::kStreamSessionClock) return session_sec(env);
    return std::nan("");
  }
  return comp::streamPos(*s, *t, *ctx->streams_clock, session_sec(env));
}

static double streams_pos_sec_fn(wasm_exec_env_t env, int64_t h) {
  auto* ctx = get_ctx(env);
  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(h) : nullptr;
  if (!s || !ctx->streams_clock) {
    if (h == comp::kStreamSessionClock) return session_sec(env);
    return std::nan("");
  }
  return comp::streamPosSec(*s, *t, *ctx->streams_clock, session_sec(env));
}

static int32_t streams_playing_fn(wasm_exec_env_t env, int64_t h) {
  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(h) : nullptr;
  if (!s) return h == comp::kStreamSessionClock ? 1 : 0;
  return comp::streamPlaying(*s, *t);
}

static int32_t streams_loop_fn(wasm_exec_env_t env, int64_t h, int32_t out_ptr) {
  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(h) : nullptr;
  if (!s) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, out_ptr, 16)) return 0;
  double* out = static_cast<double*>(wasm_runtime_addr_app_to_native(inst, out_ptr));
  if (!out) return 0;
  return comp::streamLoop(*s, *t, out);
}

static double streams_duration_fn(wasm_exec_env_t env, int64_t h) {
  const auto* s = resolve_stream(env, h);
  return s ? s->durationPrimary : -1.0;
}

static double streams_duration_sec_fn(wasm_exec_env_t env, int64_t h) {
  const auto* s = resolve_stream(env, h);
  return s ? s->durationSec : -1.0;
}

static double streams_bpm_fn(wasm_exec_env_t env, int64_t h) {
  const auto* s = resolve_stream(env, h);
  if (s) return s->bpm;
  auto* f = get_frame(env);
  return f ? f->bpm : 120.0;
}

static double streams_fps_fn(wasm_exec_env_t env, int64_t h) {
  const auto* s = resolve_stream(env, h);
  return s ? s->fps : 0.0;
}

static double streams_anchor_fn(wasm_exec_env_t env, int64_t h) {
  const auto* s = resolve_stream(env, h);
  if (!s || (s->kind != comp::kStreamKindVideoContent &&
             s->kind != comp::kStreamKindSequenceContent))
    return std::nan("");
  return s->anchorBeat;
}

static double streams_anchor_sec_fn(wasm_exec_env_t env, int64_t h) {
  auto* ctx = get_ctx(env);
  const auto* s = resolve_stream(env, h);
  if (!s || !ctx->streams_clock ||
      (s->kind != comp::kStreamKindVideoContent &&
       s->kind != comp::kStreamKindSequenceContent))
    return std::nan("");
  return ctx->streams_clock->secondsAt(s->anchorBeat);
}

static const comp::StreamClipRef* resolve_clip_ref(wasm_exec_env_t env, int64_t h,
                                                   int32_t ordinal) {
  const comp::StreamInfo* s = resolve_stream(env, h);
  if (!s || ordinal < 0 || ordinal >= static_cast<int32_t>(s->byOrdinalClipId.size()))
    return nullptr;
  auto it = s->clipsById.find(s->byOrdinalClipId[static_cast<size_t>(ordinal)]);
  return it == s->clipsById.end() ? nullptr : &it->second;
}

static double streams_clip_duration_fn(wasm_exec_env_t env, int64_t h, int32_t ordinal) {
  const auto* ref = resolve_clip_ref(env, h, ordinal);
  return ref ? ref->stdDurationSec : std::nan("");
}

static double streams_clip_group_fn(wasm_exec_env_t env, int64_t h, int32_t ordinal) {
  const auto* ref = resolve_clip_ref(env, h, ordinal);
  return ref ? ref->groupId : std::nan("");
}

static int32_t streams_next_launch_fn(wasm_exec_env_t env, int64_t h, int32_t rec_ptr) {
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, rec_ptr, 4)) return 0;
  int32_t* head = static_cast<int32_t*>(wasm_runtime_addr_app_to_native(inst, rec_ptr));
  if (!head) return 0;
  constexpr int32_t kKnown = 32;  // sizeof(NextLaunchRec) fields the host fills
  const int32_t sent = *head;
  const int32_t fill = std::min(sent, kKnown);
  if (fill < 4 || !wasm_runtime_validate_app_addr(inst, rec_ptr, fill)) return 0;

  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(h) : nullptr;
  struct Image {
    int32_t struct_size, state, ordinal, cls;
    double eta_sec;
    int32_t r0, r1;
  } img = {sent, 0, -1, 1, 0, 0, 0};
  static_assert(sizeof(Image) == 32, "twin of streams.h NextLaunchRec");
  if (s && s->kind == comp::kStreamKindSceneTrack && s->nlState != 0) {
    img.state = s->nlState;
    img.ordinal = s->nlOrdinal;
    img.cls = s->nlCls;
    img.eta_sec = s->nlEtaSec;
  }
  memcpy(reinterpret_cast<char*>(head) + 4, reinterpret_cast<char*>(&img) + 4,
         static_cast<size_t>(fill - 4));
  return img.state != 0 ? 1 : 0;
}

static int32_t streams_seek_fn(wasm_exec_env_t env, int64_t h, double t, int32_t cls) {
  auto* table = get_streams(env);
  const comp::StreamInfo* s = table ? table->find(h) : nullptr;
  if (!s || !(s->flags & comp::kStreamTriggerOnSeek)) return 0;
  table->pendingOps.push_back({0, h, t, cls != 0 ? 1 : 0});
  return 1;
}

static int32_t streams_stop_fn(wasm_exec_env_t env, int64_t h) {
  auto* table = get_streams(env);
  const comp::StreamInfo* s = table ? table->find(h) : nullptr;
  // Scene tracks (stop the playing clip) and content streams — video AND
  // sequence-clip interiors — (release a FORK; validated at drain: only a live
  // fork's stream acts).
  if (!s || (s->kind != comp::kStreamKindSceneTrack && !comp::isContentStream(*s))) {
    return 0;
  }
  table->pendingOps.push_back({1, h, 0.0});
  return 1;
}

static int32_t streams_announce_fn(wasm_exec_env_t env, int64_t h, double t, double eta,
                                   int32_t cls) {
  auto* table = get_streams(env);
  const comp::StreamInfo* s = table ? table->find(h) : nullptr;
  if (!s || !(s->flags & comp::kStreamTriggerOnSeek)) return 0;
  table->pendingOps.push_back({2, h, t, cls != 0 ? 1 : 0, eta});
  return 1;
}

static double streams_elapsed_fn(wasm_exec_env_t env, int64_t h) {
  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(h) : nullptr;
  if (!s) return h == comp::kStreamSessionClock ? session_sec(env) : std::nan("");
  return comp::streamElapsed(*s, *t, session_sec(env));
}

static int32_t streams_event_count_fn(wasm_exec_env_t env, int64_t h) {
  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(h) : nullptr;
  if (!s) {
    return !t && h == comp::kStreamSessionClock ? 0 : -1;
  }
  if (comp::isContentStream(*s)) {
    return comp::contentEventCount(*s, comp::streamElapsed(*s, *t, session_sec(env)));
  }
  return static_cast<int32_t>(s->events.size());
}

static int32_t streams_read_events_fn(wasm_exec_env_t env, int64_t h, int32_t first,
                                      int32_t out_ptr, int32_t cap_events) {
  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(h) : nullptr;
  if (!s) return !t && h == comp::kStreamSessionClock ? 0 : -1;
  if (first < 0 || cap_events <= 0) return 0;
  const bool content = comp::isContentStream(*s);
  const int32_t total =
      content ? comp::contentEventCount(*s, comp::streamElapsed(*s, *t, session_sec(env)))
              : static_cast<int32_t>(s->events.size());
  const int32_t n = std::max(0, std::min(total - first, cap_events));
  if (n == 0) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, out_ptr, n * 40)) return 0;
  double* out = static_cast<double*>(wasm_runtime_addr_app_to_native(inst, out_ptr));
  if (!out) return 0;
  for (int32_t k = 0; k < n; ++k) {
    const comp::StreamEvent e = content ? comp::contentEventAt(*s, first + k)
                                        : s->events[static_cast<size_t>(first + k)];
    out[k * 5 + 0] = e.time;
    out[k * 5 + 1] = static_cast<double>(e.kind);
    out[k * 5 + 2] = static_cast<double>(e.clipOrdinal);
    out[k * 5 + 3] = e.idHash48;
    out[k * 5 + 4] = e.channel;
  }
  return n;
}

static int32_t streams_event_lb_fn(wasm_exec_env_t env, int64_t h, double time) {
  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(h) : nullptr;
  if (!s) return 0;
  if (comp::isContentStream(*s)) {
    return comp::contentEventLowerBound(*s, comp::streamElapsed(*s, *t, session_sec(env)), time);
  }
  // First event with time >= t, by TIME only (kind ties don't matter here).
  int32_t lo = 0, hi = static_cast<int32_t>(s->events.size());
  while (lo < hi) {
    const int32_t mid = lo + (hi - lo) / 2;
    if (s->events[static_cast<size_t>(mid)].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

static NativeSymbol streams_symbols[] = {
    {"parent", reinterpret_cast<void*>(streams_parent_fn), "()I", nullptr},
    {"content", reinterpret_cast<void*>(streams_content_fn), "()I", nullptr},
    {"timeline", reinterpret_cast<void*>(streams_timeline_fn), "()I", nullptr},
    {"count", reinterpret_cast<void*>(streams_count_fn), "()i", nullptr},
    {"at", reinterpret_cast<void*>(streams_at_fn), "(i)I", nullptr},
    {"name", reinterpret_cast<void*>(streams_name_fn), "(Iii)i", nullptr},
    {"describe", reinterpret_cast<void*>(streams_describe_fn), "(Ii)i", nullptr},
    {"rev", reinterpret_cast<void*>(streams_rev_fn), "(I)i", nullptr},
    {"pos", reinterpret_cast<void*>(streams_pos_fn), "(I)F", nullptr},
    {"pos_sec", reinterpret_cast<void*>(streams_pos_sec_fn), "(I)F", nullptr},
    {"playing", reinterpret_cast<void*>(streams_playing_fn), "(I)i", nullptr},
    {"loop", reinterpret_cast<void*>(streams_loop_fn), "(Ii)i", nullptr},
    {"duration", reinterpret_cast<void*>(streams_duration_fn), "(I)F", nullptr},
    {"duration_sec", reinterpret_cast<void*>(streams_duration_sec_fn), "(I)F", nullptr},
    {"bpm", reinterpret_cast<void*>(streams_bpm_fn), "(I)F", nullptr},
    {"fps", reinterpret_cast<void*>(streams_fps_fn), "(I)F", nullptr},
    {"anchor", reinterpret_cast<void*>(streams_anchor_fn), "(I)F", nullptr},
    {"anchor_sec", reinterpret_cast<void*>(streams_anchor_sec_fn), "(I)F", nullptr},
    {"elapsed", reinterpret_cast<void*>(streams_elapsed_fn), "(I)F", nullptr},
    {"clip_duration", reinterpret_cast<void*>(streams_clip_duration_fn), "(Ii)F", nullptr},
    {"clip_group", reinterpret_cast<void*>(streams_clip_group_fn), "(Ii)F", nullptr},
    {"next_launch", reinterpret_cast<void*>(streams_next_launch_fn), "(Ii)i", nullptr},
    {"seek", reinterpret_cast<void*>(streams_seek_fn), "(IFi)i", nullptr},
    {"stop", reinterpret_cast<void*>(streams_stop_fn), "(I)i", nullptr},
    {"announce", reinterpret_cast<void*>(streams_announce_fn), "(IFFi)i", nullptr},
    {"event_count", reinterpret_cast<void*>(streams_event_count_fn), "(I)i", nullptr},
    {"read_events", reinterpret_cast<void*>(streams_read_events_fn), "(Iiii)i", nullptr},
    {"event_lower_bound", reinterpret_cast<void*>(streams_event_lb_fn), "(IF)i", nullptr},
};

// ========================================================================
// Module "resources" — the ASSET namespace behind streams (streams_table.h
// resource section; effect-side header wasm_modules/include/resources.h).
// A resource is the material (clip media today; files/images/audio later);
// resources.stream fetches its seekable-stream transport view.
// ========================================================================

static const comp::ResourceInfo* resolve_resource(wasm_exec_env_t env, int64_t h) {
  const auto* t = get_streams(env);
  return t ? t->findResource(h) : nullptr;
}

static int64_t resources_content_fn(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  const auto* t = get_streams(env);
  if (t && ctx && ctx->effect_instance) {
    const std::string& key = ctx->effect_instance->instanceKey();
    if (const std::string* clipId = comp::clipIdForInstanceKey(*t, key)) {
      auto it = t->resourceByClipId.find(*clipId);
      if (it != t->resourceByClipId.end()) return it->second;
    }
  }
  return 0;
}

static int64_t resources_live_fn(wasm_exec_env_t env, int64_t track_stream) {
  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(track_stream) : nullptr;
  return s ? comp::resourceForTrackLive(*t, *s) : 0;
}

static int64_t resources_clip_at_fn(wasm_exec_env_t env, int64_t track_stream,
                                    int32_t ordinal) {
  const auto* t = get_streams(env);
  const comp::StreamInfo* s = t ? t->find(track_stream) : nullptr;
  return s ? comp::resourceForTrackClipAt(*t, *s, ordinal) : 0;
}

static int32_t resources_describe_fn(wasm_exec_env_t env, int64_t h, int32_t desc_ptr) {
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, desc_ptr, 4)) return 0;
  int32_t* head = static_cast<int32_t*>(wasm_runtime_addr_app_to_native(inst, desc_ptr));
  if (!head) return 0;
  constexpr int32_t kKnown = 64;  // sizeof(ResourceDesc) fields the host fills
  const int32_t sent = *head;
  const int32_t fill = std::min(sent, kKnown);
  if (fill < 4 || !wasm_runtime_validate_app_addr(inst, desc_ptr, fill)) return 0;

  const auto* t = get_streams(env);
  const comp::ResourceInfo* r = t ? t->findResource(h) : nullptr;
  // Field image, matching ResourceDesc exactly (8-byte fields 8-aligned).
  struct Image {
    int32_t struct_size, kind, flags, rev;
    int64_t stream, size_bytes;
    double duration_sec;
    int32_t width, height, r0, r1, r2, r3;
  } img = {sent, comp::kResKindInvalid, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 0};
  static_assert(sizeof(Image) == 64, "twin of resources.h ResourceDesc");
  if (r) {
    img.kind = r->kind;
    img.flags = r->flags;
    img.rev = comp::resourceRev(*t, *r);
    img.stream = r->stream;
    img.size_bytes = r->sizeBytes;
    img.duration_sec = r->durationSec;
    img.width = r->width;
    img.height = r->height;
  }
  // Byte-copy past the caller's struct_size word only, up to `fill`.
  memcpy(reinterpret_cast<char*>(head) + 4, reinterpret_cast<char*>(&img) + 4,
         static_cast<size_t>(fill - 4));
  return img.kind != comp::kResKindInvalid ? 1 : 0;
}

static int32_t resources_rev_fn(wasm_exec_env_t env, int64_t h) {
  const auto* t = get_streams(env);
  const comp::ResourceInfo* r = t ? t->findResource(h) : nullptr;
  return r ? comp::resourceRev(*t, *r) : (t ? t->docRev : 0);
}

static int64_t resources_stream_fn(wasm_exec_env_t env, int64_t h) {
  const auto* r = resolve_resource(env, h);
  return r ? r->stream : 0;
}

static int64_t resources_fork_fn(wasm_exec_env_t env, int64_t h) {
  // Queues the fork arm / re-assert (StreamOp kind 3 on the RESOURCE handle,
  // drained by CompExecutor::drainStreamOps — level-triggered, so callers
  // re-assert per tick). Returns the resource handle when accepted (adopted
  // identity: the fork keeps the same resource; a stream-backed one exposes
  // its transport view via resources.stream).
  auto* table = get_streams(env);
  const comp::ResourceInfo* r = table ? table->findResource(h) : nullptr;
  if (!r || !(r->flags & comp::kResForkable)) return 0;
  table->pendingOps.push_back({3, h, 0.0, 1, 0});
  return h;
}

static int32_t resources_release_fn(wasm_exec_env_t env, int64_t h) {
  // Ends a fork of this resource (the fade-done call) — kind 1 on the
  // resource handle; validated at drain (only a live fork's owner acts).
  auto* table = get_streams(env);
  const comp::ResourceInfo* r = table ? table->findResource(h) : nullptr;
  if (!r) return 0;
  table->pendingOps.push_back({1, h, 0.0});
  return 1;
}

static NativeSymbol resources_symbols[] = {
    {"content", reinterpret_cast<void*>(resources_content_fn), "()I", nullptr},
    {"live", reinterpret_cast<void*>(resources_live_fn), "(I)I", nullptr},
    {"clip_at", reinterpret_cast<void*>(resources_clip_at_fn), "(Ii)I", nullptr},
    {"describe", reinterpret_cast<void*>(resources_describe_fn), "(Ii)i", nullptr},
    {"rev", reinterpret_cast<void*>(resources_rev_fn), "(I)i", nullptr},
    {"stream", reinterpret_cast<void*>(resources_stream_fn), "(I)I", nullptr},
    {"fork", reinterpret_cast<void*>(resources_fork_fn), "(I)I", nullptr},
    {"release", reinterpret_cast<void*>(resources_release_fn), "(I)i", nullptr},
};

// ========================================================================
// Module "state" — plugin metadata, logging, state access
// ========================================================================

// version_packed is (major<<16)|(minor<<8)|patch; render as "M.m.p".
static std::string unpack_version(int32_t v) {
  return std::to_string((v >> 16) & 0xFF) + "." +
         std::to_string((v >> 8) & 0xFF) + "." +
         std::to_string(v & 0xFF);
}

static void state_set_metadata(wasm_exec_env_t env,
    int32_t id_ptr, int32_t id_len, int32_t version_packed) {
  auto* ctx = get_ctx(env);
  if (!ctx) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, id_ptr, id_len)) return;
  char* id_str = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, id_ptr));
  if (!id_str) return;

  std::string id(id_str, id_len);

  // Barrel path: route to the effect instance the runtime is driving.
  if (ctx->effect_instance)
    ctx->effect_instance->hostSetMetadata(id, unpack_version(version_packed));

  // bridge_server path: register with the state doc.
  if (ctx->state_doc) {
    bridge::PluginMetadata meta;
    meta.id = id;
    meta.major = (version_packed >> 16) & 0xFF;
    meta.minor = (version_packed >> 8) & 0xFF;
    meta.patch = version_packed & 0xFF;
    ctx->plugin_key = ctx->state_doc->register_plugin(meta);
  }
}

static void state_set_schema(wasm_exec_env_t env,
    int32_t id_ptr, int32_t id_len, int32_t version_packed,
    int32_t schema_ptr, int32_t schema_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, id_ptr, id_len)) return;
  if (!wasm_runtime_validate_app_addr(inst, schema_ptr, schema_len)) return;
  char* id_str = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, id_ptr));
  char* schema_str = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, schema_ptr));
  if (!id_str || !schema_str) return;

  std::string id(id_str, id_len);
  std::string schema_json(schema_str, schema_len);

  // Barrel path: publish onto the effect instance (id+version+schema all
  // arrive here; set_metadata may not be called separately).
  if (ctx->effect_instance) {
    ctx->effect_instance->hostSetMetadata(id, unpack_version(version_packed));
    ctx->effect_instance->hostSetSchema(schema_json);
  }

  // bridge_server path: register with the state doc.
  if (ctx->state_doc) {
    bridge::PluginMetadata meta;
    meta.id = id;
    meta.major = (version_packed >> 16) & 0xFF;
    meta.minor = (version_packed >> 8) & 0xFF;
    meta.patch = version_packed & 0xFF;
    ctx->plugin_key = ctx->state_doc->register_plugin_with_schema(meta, schema_json);
  }
}

static int32_t state_get_key(wasm_exec_env_t env, int32_t buf_ptr, int32_t buf_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return 0;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) return 0;
  char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
  if (!buf) return 0;

  const auto& key = ctx->plugin_key;
  int32_t copy_len = std::min((int32_t)key.size(), buf_len);
  memcpy(buf, key.data(), copy_len);
  return copy_len;
}

static void state_console_log(wasm_exec_env_t env,
    int32_t level, int32_t msg_ptr, int32_t msg_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, msg_ptr, msg_len)) return;
  char* msg = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, msg_ptr));
  if (!msg) return;

  const char* levels[] = {"log", "warn", "error"};
  std::string lvl = (level >= 0 && level < 3) ? levels[level] : "log";

  // The runtime's console log FIRST, and unconditionally: the state doc is
  // optional (a host that doesn't link bridge_core has none), and gating the
  // whole function on it — as this used to — silently discarded every effect
  // log on such a host.
  if (ctx->effect_instance)
    ctx->effect_instance->hostLog(lvl, std::string_view(msg, msg_len));

  if (!ctx->state_doc || ctx->plugin_key.empty()) return;
  auto* frame = ctx->frame_state;
  double ts = frame ? frame->elapsed_time : 0.0;

  ctx->state_doc->log(ctx->plugin_key,
      {ts, lvl, std::string(msg, msg_len)});
}

static int32_t state_read(wasm_exec_env_t env,
    int32_t layout_ptr, int32_t field_count,
    int32_t paths_ptr, int32_t output_ptr,
    int32_t output_size, int32_t results_ptr) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return -1;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  int32_t layout_bytes = field_count * sizeof(json_doc::Field);
  int32_t results_bytes = field_count * sizeof(json_doc::FieldResult);

  if (!wasm_runtime_validate_app_addr(inst, layout_ptr, layout_bytes)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, output_ptr, output_size)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, results_ptr, results_bytes)) return -1;

  auto* layout = static_cast<json_doc::Field*>(
      wasm_runtime_addr_app_to_native(inst, layout_ptr));
  auto* output = static_cast<uint8_t*>(
      wasm_runtime_addr_app_to_native(inst, output_ptr));
  auto* results = static_cast<json_doc::FieldResult*>(
      wasm_runtime_addr_app_to_native(inst, results_ptr));

  // paths_ptr validation: we need to find the max extent
  // For now, validate a generous range
  if (!wasm_runtime_validate_app_addr(inst, paths_ptr, 1)) return -1;
  auto* paths = static_cast<const char*>(
      wasm_runtime_addr_app_to_native(inst, paths_ptr));

  if (!layout || !output || !results || !paths) return -1;

  auto state = ctx->state_doc->get_plugin_state(ctx->plugin_key);
  return json_doc::read(state, layout, field_count, paths,
                        output, output_size, results);
}

static void state_console_log_structured(wasm_exec_env_t env,
    int32_t level, int32_t msg_ptr, int32_t msg_len,
    int32_t json_ptr, int32_t json_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return;

  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, msg_ptr, msg_len)) return;
  if (!wasm_runtime_validate_app_addr(inst, json_ptr, json_len)) return;

  char* msg = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, msg_ptr));
  char* json_str = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, json_ptr));
  if (!msg || !json_str) return;

  const char* levels[] = {"log", "warn", "error"};
  std::string lvl = (level >= 0 && level < 3) ? levels[level] : "log";

  // The message half reaches the runtime log even without a state doc; the
  // structured payload is state-doc-only (see state_console_log above).
  if (ctx->effect_instance)
    ctx->effect_instance->hostLog(lvl, std::string_view(msg, msg_len));

  if (!ctx->state_doc || ctx->plugin_key.empty()) return;
  auto* frame = ctx->frame_state;
  double ts = frame ? frame->elapsed_time : 0.0;

  nlohmann::json data;
  try {
    data = nlohmann::json::parse(std::string(json_str, json_len));
  } catch (...) {
    data = std::string(json_str, json_len);
  }

  // Create entry with both message and structured data
  bridge::ConsoleEntry entry;
  entry.timestamp = ts;
  entry.level = lvl;
  entry.data = nlohmann::json{{"message", std::string(msg, msg_len)}, {"data", data}};
  ctx->state_doc->log(ctx->plugin_key, entry);
}

// state.register_shader_spv — forward onto the effect instance, which owns the
// SPV bytes + SPV→MSL translation (EffectHostSink::createShaderModuleByName).
static void state_register_shader_spv(wasm_exec_env_t env,
    int32_t name_ptr, int32_t name_len, int32_t spv_ptr, int32_t spv_len,
    int32_t fmt_ptr, int32_t fmt_len, int32_t acc_ptr, int32_t acc_len) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->effect_instance) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, name_ptr, name_len)) return;
  if (spv_len <= 0 || !wasm_runtime_validate_app_addr(inst, spv_ptr, spv_len)) return;
  const char* name = static_cast<const char*>(
      wasm_runtime_addr_app_to_native(inst, name_ptr));
  const auto* spv = static_cast<const unsigned char*>(
      wasm_runtime_addr_app_to_native(inst, spv_ptr));
  if (!name || !spv) return;
  std::string fmt, acc;
  if (fmt_len > 0 && wasm_runtime_validate_app_addr(inst, fmt_ptr, fmt_len)) {
    if (char* p = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, fmt_ptr)))
      fmt.assign(p, fmt_len);
  }
  if (acc_len > 0 && wasm_runtime_validate_app_addr(inst, acc_ptr, acc_len)) {
    if (char* p = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, acc_ptr)))
      acc.assign(p, acc_len);
  }
  ctx->effect_instance->hostRegisterShaderSpv(
      std::string_view(name, name_len), spv, spv_len,
      std::string_view(fmt), std::string_view(acc));
}

// register_fusion_by_name(kind, fragment_name, fragment_name_len,
//   uniform_buf_handle, uniform_size_bytes, prepare_fn) — forward onto the
// instance so the executor fuses this effect like a native one. prepare_fn is a
// WASM function-table index (doPrepare call_indirects it).
static void state_register_fusion_by_name(wasm_exec_env_t env,
    int32_t kind, int32_t name_ptr, int32_t name_len,
    int32_t uniform_buf, int32_t uniform_size, int32_t prepare_fn) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->effect_instance) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  std::string frag;
  if (name_len > 0 && wasm_runtime_validate_app_addr(inst, name_ptr, name_len)) {
    if (char* p = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, name_ptr)))
      frag.assign(p, name_len);
  }
  ctx->effect_instance->hostRegisterWasmFusion(
      kind, std::move(frag), uniform_buf, uniform_size,
      static_cast<uint32_t>(prepare_fn));
}

static int32_t state_is_field_connected(wasm_exec_env_t env,
    int32_t path_ptr, int32_t path_len, int32_t direction) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->effect_instance) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, path_ptr, path_len)) return 0;
  char* p = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, path_ptr));
  if (!p) return 0;
  std::string path(p, path_len);
  // direction is an ENUM, not the io bitfield: 0 = input ("is anyone writing
  // this?"), 1 = output ("is anyone reading this?"). host.h's isInputConnected
  // passes 0 and isOutputConnected passes 1; web's wasm-host.ts and the native
  // non-wasm host_impls.cpp both read it that way. Testing `direction & 1` read
  // 1 as INPUT, so every wasm effect's isOutputConnected() answered the input
  // question — which silently killed double_chamber's motion pass in the barrel
  // (render_outputs is output-only, so it always came back false → no motion
  // rail → motion.blur passed through).
  bool connected = (direction == 0)
      ? ctx->effect_instance->isInputConnected(path)
      : ctx->effect_instance->isOutputConnected(path);
  return connected ? 1 : 0;
}

static int32_t state_will_render(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return (ctx && ctx->effect_instance && ctx->effect_instance->willRender()) ? 1 : 0;
}

// Effect publishes an output texture/buffer; route to the instance so the
// executor can read it back as the stage's output.
static void state_set_gpu_texture(wasm_exec_env_t env,
    int32_t path_ptr, int32_t path_len, int32_t handle) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->effect_instance) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, path_ptr, path_len)) return;
  char* p = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, path_ptr));
  if (p) ctx->effect_instance->setTextureField(std::string(p, path_len), handle);
}
static void state_set_gpu_buffer(wasm_exec_env_t env,
    int32_t path_ptr, int32_t path_len, int32_t handle) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->effect_instance) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, path_ptr, path_len)) return;
  char* p = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, path_ptr));
  if (p) ctx->effect_instance->setBufferField(std::string(p, path_len), handle);
}

// Intentional no-ops on the barrel render path (accepted so effects calling
// them don't trap):
//  - set_field_hidden: inspector field visibility — editor/web concern only.
//  - mark_gpu_dirty: buffer-dirty hint; the barrel re-applies state each dirty
//    frame regardless.
//  - set_on_state_ready: a post-init/post-restore hook effects register in
//    module_init (type level). It only drives inspector field VISIBILITY (no
//    render effect), and the native static path doesn't fire it on per-key
//    render instances either (instanceFor copies the descriptor, not the
//    prototype's on_state_ready_), so a no-op here MATCHES native — confirmed
//    by pixel parity on the effects that use it (e.g. warp.crop, AE=0).
static void state_set_field_hidden(wasm_exec_env_t, int32_t, int32_t, int32_t) {}
static void state_mark_gpu_dirty(wasm_exec_env_t, int32_t, int32_t) {}
static void state_set_on_state_ready(wasm_exec_env_t, int32_t) {}

static NativeSymbol state_symbols[] = {
    {"set_metadata", reinterpret_cast<void*>(state_set_metadata), "(iii)", nullptr},
    {"register_shader_spv", reinterpret_cast<void*>(state_register_shader_spv), "(iiiiiiii)", nullptr},
    {"register_fusion_by_name", reinterpret_cast<void*>(state_register_fusion_by_name), "(iiiiii)", nullptr},
    {"is_field_connected", reinterpret_cast<void*>(state_is_field_connected), "(iii)i", nullptr},
    {"will_render", reinterpret_cast<void*>(state_will_render), "()i", nullptr},
    {"set_gpu_texture", reinterpret_cast<void*>(state_set_gpu_texture), "(iii)", nullptr},
    {"set_gpu_buffer", reinterpret_cast<void*>(state_set_gpu_buffer), "(iii)", nullptr},
    {"set_field_hidden", reinterpret_cast<void*>(state_set_field_hidden), "(iii)", nullptr},
    {"mark_gpu_dirty", reinterpret_cast<void*>(state_mark_gpu_dirty), "(ii)", nullptr},
    {"set_on_state_ready", reinterpret_cast<void*>(state_set_on_state_ready), "(i)", nullptr},
    {"set_schema", reinterpret_cast<void*>(state_set_schema), "(iiiii)", nullptr},
    {"get_key", reinterpret_cast<void*>(state_get_key), "(ii)i", nullptr},
    {"console_log", reinterpret_cast<void*>(state_console_log), "(iii)", nullptr},
    {"console_log_structured", reinterpret_cast<void*>(state_console_log_structured), "(iiiii)", nullptr},
    {"set_val", reinterpret_cast<void*>(+[](wasm_exec_env_t env, int32_t path_ptr, int32_t path_len, int32_t val_h) {
      auto* ctx = get_ctx(env);
      if (!ctx) return;
      auto* v = ctx->get_val(val_h);
      if (!v) return;
      wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
      if (!wasm_runtime_validate_app_addr(inst, path_ptr, path_len)) return;
      char* path = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, path_ptr));
      // Barrel/executor path: accumulate on the live EffectInstance so the
      // host can surface output broadcasts (autopilot_x etc.) to the editor.
      if (ctx->effect_instance)
        ctx->effect_instance->hostSetVal(
            std::string_view(path ? path : "", path ? (size_t)path_len : 0), *v);
      // bridge_server (standalone plugin) path: write into the state doc.
      if (!ctx->state_doc || ctx->plugin_key.empty()) return;
      if (path_len == 0) {
        ctx->state_doc->set_plugin_state(ctx->plugin_key, *v);
      } else {
        // Use the JSON string path for sub-path sets
        std::string p(path, path_len);
        auto state = ctx->state_doc->get_plugin_state(ctx->plugin_key);
        auto tokens = p;
        // Simple path setter
        auto* target = &state;
        auto keys_str = p;
        if (!keys_str.empty() && keys_str[0] == '/') keys_str = keys_str.substr(1);
        (*target)[keys_str] = *v;
        ctx->state_doc->set_plugin_state(ctx->plugin_key, state);
      }
    }), "(iii)", nullptr},
    {"read", reinterpret_cast<void*>(state_read), "(iiiiii)i", nullptr},
    {"get_patch", reinterpret_cast<void*>(+[](wasm_exec_env_t env, int32_t index) -> int32_t {
      auto* ctx = get_ctx(env);
      if (!ctx || index < 0 || index >= static_cast<int32_t>(ctx->pending_patches.size())) return 0;
      return ctx->alloc_val(ctx->pending_patches[index]);
    }), "(i)i", nullptr},
};

// ========================================================================
// Module "io" — I/O port declarations
// ========================================================================

static void io_declare_texture_input(wasm_exec_env_t env, int index,
    const char* name, int name_len, int role) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return;
  bridge::IODecl decl;
  decl.index = index;
  decl.name = std::string(name, name_len);
  decl.kind = bridge::IO_TEXTURE_INPUT;
  decl.role = static_cast<bridge::IORole>(role);
  ctx->state_doc->declare_io(ctx->plugin_key, decl);
}

static void io_declare_texture_output(wasm_exec_env_t env, int index,
    const char* name, int name_len, int role) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return;
  bridge::IODecl decl;
  decl.index = index;
  decl.name = std::string(name, name_len);
  decl.kind = bridge::IO_TEXTURE_OUTPUT;
  decl.role = static_cast<bridge::IORole>(role);
  ctx->state_doc->declare_io(ctx->plugin_key, decl);
}

static void io_declare_data_output(wasm_exec_env_t env, int index,
    const char* name, int name_len, int role) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->state_doc || ctx->plugin_key.empty()) return;
  bridge::IODecl decl;
  decl.index = index;
  decl.name = std::string(name, name_len);
  decl.kind = bridge::IO_DATA_OUTPUT;
  decl.role = static_cast<bridge::IORole>(role);
  ctx->state_doc->declare_io(ctx->plugin_key, decl);
}

static NativeSymbol io_symbols[] = {
    {"declare_texture_input", reinterpret_cast<void*>(io_declare_texture_input), "(iiii)", nullptr},
    {"declare_texture_output", reinterpret_cast<void*>(io_declare_texture_output), "(iiii)", nullptr},
    {"declare_data_output", reinterpret_cast<void*>(io_declare_data_output), "(iiii)", nullptr},
};

// ========================================================================
// Module "val" — Handle-based JSON value container
// ========================================================================

static int32_t val_null(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->alloc_val(nlohmann::json(nullptr)) : 0;
}
static int32_t val_bool(wasm_exec_env_t env, int32_t v) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->alloc_val(v != 0) : 0;
}
static int32_t val_number(wasm_exec_env_t env, double v) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->alloc_val(v) : 0;
}
static int32_t val_string(wasm_exec_env_t env, int32_t str_ptr, int32_t str_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, str_ptr, str_len)) return 0;
  char* s = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, str_ptr));
  return s ? ctx->alloc_val(std::string(s, str_len)) : 0;
}
static int32_t val_array(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->alloc_val(nlohmann::json::array()) : 0;
}
static int32_t val_object(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->alloc_val(nlohmann::json::object()) : 0;
}

static int32_t val_type_of(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  if (!v) return 0;
  if (v->is_null()) return 0;
  if (v->is_boolean()) return 1;
  if (v->is_number()) return 2;
  if (v->is_string()) return 3;
  if (v->is_array()) return 4;
  if (v->is_object()) return 5;
  return 0;
}
static double val_as_number(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  if (!v) return 0.0;
  if (v->is_number()) return v->get<double>();
  // Coerce booleans so effects calling state::patchFloat on a bool patch see
  // 1.0/0.0 rather than 0.0 always — matches bridge_core_val_as_number and the
  // web host's JS val store, which both coerce for exactly this reason.
  if (v->is_boolean()) return v->get<bool>() ? 1.0 : 0.0;
  return 0.0;
}
static int32_t val_as_bool(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  if (!v) return 0;
  if (v->is_boolean()) return v->get<bool>() ? 1 : 0;
  if (v->is_number()) return v->get<double>() != 0.0 ? 1 : 0;  // match host_impls
  return 0;
}
static int32_t val_as_string(wasm_exec_env_t env, int32_t h, int32_t buf_ptr, int32_t buf_len) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  if (!v || !v->is_string()) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) return 0;
  char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
  auto& s = v->get_ref<const std::string&>();
  int len = std::min(static_cast<int>(s.size()), buf_len);
  if (buf && len > 0) std::memcpy(buf, s.data(), len);
  return len;
}

static int32_t val_get(wasm_exec_env_t env, int32_t obj_h, int32_t key_ptr, int32_t key_len) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(obj_h) : nullptr;
  if (!v || !v->is_object()) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, key_ptr, key_len)) return 0;
  char* key = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, key_ptr));
  std::string k(key, key_len);
  if (!v->contains(k)) return 0;
  return ctx->alloc_val((*v)[k]);
}
static void val_set(wasm_exec_env_t env, int32_t obj_h, int32_t key_ptr, int32_t key_len, int32_t value_h) {
  auto* ctx = get_ctx(env);
  if (!ctx) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, key_ptr, key_len)) return;
  char* key = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, key_ptr));
  // Copies the value into obj's subtree AND frees the (now-consumed) value
  // handle — see WasmContext::set_val_member; this is what stops the per-frame
  // val-handle leak that eventually wedges the executor.
  ctx->set_val_member(obj_h, std::string(key, key_len), value_h);
}
static int32_t val_keys_count(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  return (v && v->is_object()) ? static_cast<int32_t>(v->size()) : 0;
}
static int32_t val_key_at(wasm_exec_env_t env, int32_t h, int32_t index, int32_t buf_ptr, int32_t buf_len) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  if (!v || !v->is_object() || index < 0 || index >= static_cast<int32_t>(v->size())) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) return 0;
  char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
  auto it = v->begin();
  std::advance(it, index);
  const auto& key = it.key();
  int len = std::min(static_cast<int>(key.size()), buf_len);
  if (buf && len > 0) std::memcpy(buf, key.data(), len);
  return len;
}

static int32_t val_get_index(wasm_exec_env_t env, int32_t arr_h, int32_t index) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(arr_h) : nullptr;
  if (!v || !v->is_array() || index < 0 || index >= static_cast<int32_t>(v->size())) return 0;
  return ctx->alloc_val((*v)[index]);
}
static void val_push(wasm_exec_env_t env, int32_t arr_h, int32_t value_h) {
  auto* ctx = get_ctx(env);
  // Appends the value AND frees the (now-consumed) value handle — see
  // WasmContext::push_val_member; stops the per-frame val-handle leak.
  if (ctx) ctx->push_val_member(arr_h, value_h);
}
static int32_t val_length(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  return (v && v->is_array()) ? static_cast<int32_t>(v->size()) : 0;
}

static void val_release(wasm_exec_env_t env, int32_t h) {
  auto* ctx = get_ctx(env);
  if (ctx) ctx->release_val(h);
}

static int32_t val_to_json(wasm_exec_env_t env, int32_t h, int32_t buf_ptr, int32_t buf_len) {
  auto* ctx = get_ctx(env);
  auto* v = ctx ? ctx->get_val(h) : nullptr;
  if (!v) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, buf_ptr, buf_len)) return 0;
  char* buf = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, buf_ptr));
  std::string json = v->dump();
  int len = std::min(static_cast<int>(json.size()), buf_len);
  if (buf && len > 0) std::memcpy(buf, json.data(), len);
  return len;
}

static NativeSymbol val_symbols[] = {
    {"null", reinterpret_cast<void*>(val_null), "()i", nullptr},
    {"bool", reinterpret_cast<void*>(val_bool), "(i)i", nullptr},
    {"number", reinterpret_cast<void*>(val_number), "(F)i", nullptr},
    {"string", reinterpret_cast<void*>(val_string), "(ii)i", nullptr},
    {"array", reinterpret_cast<void*>(val_array), "()i", nullptr},
    {"object", reinterpret_cast<void*>(val_object), "()i", nullptr},
    {"type_of", reinterpret_cast<void*>(val_type_of), "(i)i", nullptr},
    {"as_number", reinterpret_cast<void*>(val_as_number), "(i)F", nullptr},
    {"as_bool", reinterpret_cast<void*>(val_as_bool), "(i)i", nullptr},
    {"as_string", reinterpret_cast<void*>(val_as_string), "(iii)i", nullptr},
    {"get", reinterpret_cast<void*>(val_get), "(iii)i", nullptr},
    {"set", reinterpret_cast<void*>(val_set), "(iiii)", nullptr},
    {"keys_count", reinterpret_cast<void*>(val_keys_count), "(i)i", nullptr},
    {"key_at", reinterpret_cast<void*>(val_key_at), "(iiii)i", nullptr},
    {"get_index", reinterpret_cast<void*>(val_get_index), "(ii)i", nullptr},
    {"push", reinterpret_cast<void*>(val_push), "(ii)", nullptr},
    {"length", reinterpret_cast<void*>(val_length), "(i)i", nullptr},
    {"release", reinterpret_cast<void*>(val_release), "(i)", nullptr},
    {"to_json", reinterpret_cast<void*>(val_to_json), "(iii)i", nullptr},
};

// ========================================================================
// Module "gpu" — GPU compute and rendering
// ========================================================================

static gpu::GPUBackend* get_gpu(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? ctx->gpu_backend : nullptr;
}

static int32_t gpu_get_backend(wasm_exec_env_t env) {
  auto* g = get_gpu(env);
  return g ? g->getBackend() : -1;
}

static int32_t gpu_create_buffer(wasm_exec_env_t env, int64_t size, int32_t usage) {
  auto* g = get_gpu(env);
  if (!g || size <= 0) return -1;
  return g->createBuffer((uint64_t)size, usage);
}

static int32_t gpu_create_texture(wasm_exec_env_t env, int32_t w, int32_t h, int32_t fmt) {
  auto* g = get_gpu(env);
  return g ? g->createTexture(w, h, fmt) : -1;
}

static int32_t gpu_create_compute_pso(wasm_exec_env_t env, int32_t shader, int32_t entry_ptr, int32_t entry_len) {
  auto* g = get_gpu(env);
  if (!g) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, entry_ptr, entry_len)) return -1;
  char* e = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, entry_ptr));
  return e ? g->createComputePSO(shader, std::string(e, entry_len)) : -1;
}

static int32_t gpu_create_render_pso(wasm_exec_env_t env,
    int32_t vs_shader, int32_t vs_ptr, int32_t vs_len,
    int32_t fs_shader, int32_t fs_ptr, int32_t fs_len, int32_t fmt) {
  auto* g = get_gpu(env);
  if (!g) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, vs_ptr, vs_len)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, fs_ptr, fs_len)) return -1;
  char* vs = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, vs_ptr));
  char* fs = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, fs_ptr));
  if (!vs || !fs) return -1;
  return g->createRenderPSO(vs_shader, std::string(vs, vs_len),
                             fs_shader, std::string(fs, fs_len), fmt);
}

static void gpu_write_buffer(wasm_exec_env_t env, int32_t buf, int32_t offset, int32_t data_ptr, int32_t data_len) {
  auto* g = get_gpu(env);
  if (!g) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, data_ptr, data_len)) return;
  auto* data = static_cast<uint8_t*>(wasm_runtime_addr_app_to_native(inst, data_ptr));
  if (data) g->writeBuffer(buf, offset, data, data_len);
}

// GPU→CPU readback. Native buffers are CPU-coherent (MTLStorageModeShared), so
// there is nothing to stage on request; the poll reads directly (after draining
// in-flight GPU work in readBuffer). Kept as a request/poll pair to match the web
// ABI, where readback is genuinely async.
static void gpu_request_readback(wasm_exec_env_t env, int32_t buf, int32_t byte_len) {
  (void)env; (void)buf; (void)byte_len;  // no-op on native (coherent buffers)
}

static int32_t gpu_poll_readback(wasm_exec_env_t env, int32_t buf, int32_t dst_ptr, int32_t byte_len) {
  auto* g = get_gpu(env);
  if (!g || byte_len <= 0) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, dst_ptr, byte_len)) return 0;
  auto* dst = wasm_runtime_addr_app_to_native(inst, dst_ptr);
  if (!dst) return 0;
  return g->readBuffer(buf, 0, dst, (uint32_t)byte_len);
}

static int32_t gpu_begin_compute_pass(wasm_exec_env_t env) {
  auto* g = get_gpu(env); return g ? g->beginComputePass() : -1;
}
static void gpu_compute_set_pso(wasm_exec_env_t env, int32_t pass, int32_t pso) {
  auto* g = get_gpu(env); if (g) g->computeSetPSO(pass, pso);
}
static void gpu_compute_set_buffer(wasm_exec_env_t env, int32_t pass, int32_t buf, int32_t offset, int32_t slot) {
  auto* g = get_gpu(env); if (g) g->computeSetBuffer(pass, buf, offset, slot);
}
static void gpu_compute_set_texture(wasm_exec_env_t env, int32_t pass, int32_t tex, int32_t slot, int32_t access) {
  auto* g = get_gpu(env); if (g) g->computeSetTexture(pass, tex, slot, access);
}
static int32_t gpu_get_input_texture(wasm_exec_env_t env, int32_t index) {
  auto* ctx = get_ctx(env);
  if (!ctx || index < 0 || index >= static_cast<int32_t>(ctx->input_texture_handles.size())) return -1;
  return ctx->input_texture_handles[index];
}
static int32_t gpu_get_input_texture_count(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  return ctx ? static_cast<int32_t>(ctx->input_texture_handles.size()) : 0;
}
static int32_t gpu_texture_for_field(wasm_exec_env_t env, int32_t path_ptr, int32_t path_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, path_ptr, path_len)) return -1;
  char* path = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, path_ptr));
  if (!path) return -1;
  std::string field_path(path, path_len);
  // Barrel path: the executor wires textures onto the effect instance.
  if (ctx->effect_instance) {
    int h = ctx->effect_instance->textureField(field_path);
    if (h >= 0) return h;
  }
  auto it = ctx->texture_fields.find(field_path);
  return it != ctx->texture_fields.end() ? it->second : -1;
}
// Counterpart to gpu_texture_for_field for GPU storage-buffer struct-rail leaves.
// The executor binds a producer's published buffer handle onto the consumer
// instance (effrt_set_buffer_field → EffectInstance::setBufferField); the
// consumer effect resolves it here via gpu::bufferForField. 0 == unbound.
static int32_t gpu_buffer_for_field(wasm_exec_env_t env, int32_t path_ptr, int32_t path_len) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->effect_instance) return 0;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, path_ptr, path_len)) return 0;
  char* path = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, path_ptr));
  if (!path) return 0;
  int h = ctx->effect_instance->bufferField(std::string(path, path_len));
  return h > 0 ? h : 0;
}
static void gpu_compute_dispatch(wasm_exec_env_t env, int32_t pass, int32_t x, int32_t y, int32_t z) {
  auto* g = get_gpu(env); if (g) g->computeDispatch(pass, x, y, z);
}
static void gpu_end_compute_pass(wasm_exec_env_t env, int32_t pass) {
  auto* g = get_gpu(env); if (g) g->endComputePass(pass);
}

static int32_t gpu_begin_render_pass(wasm_exec_env_t env, int32_t tex, float cr, float cg, float cb, float ca) {
  auto* g = get_gpu(env); return g ? g->beginRenderPass(tex, cr, cg, cb, ca) : -1;
}
static void gpu_render_set_pso(wasm_exec_env_t env, int32_t pass, int32_t pso) {
  auto* g = get_gpu(env); if (g) g->renderSetPSO(pass, pso);
}
static void gpu_render_set_vertex_buffer(wasm_exec_env_t env, int32_t pass, int32_t buf, int32_t offset, int32_t slot) {
  auto* g = get_gpu(env); if (g) g->renderSetVertexBuffer(pass, buf, offset, slot);
}
static void gpu_render_draw(wasm_exec_env_t env, int32_t pass, int32_t vc, int32_t ic) {
  auto* g = get_gpu(env); if (g) g->renderDraw(pass, vc, ic);
}
static void gpu_end_render_pass(wasm_exec_env_t env, int32_t pass) {
  auto* g = get_gpu(env); if (g) g->endRenderPass(pass);
}

static void gpu_submit(wasm_exec_env_t env) {
  auto* g = get_gpu(env); if (g) g->submit();
}
static int32_t gpu_get_render_target(wasm_exec_env_t env) {
  auto* g = get_gpu(env); return g ? g->getSurfaceTexture() : -1;
}
static int32_t gpu_get_render_target_width(wasm_exec_env_t env) {
  auto* g = get_gpu(env); return g ? g->getSurfaceWidth() : 0;
}
static int32_t gpu_get_render_target_height(wasm_exec_env_t env) {
  auto* g = get_gpu(env); return g ? g->getSurfaceHeight() : 0;
}
static void gpu_release(wasm_exec_env_t env, int32_t handle) {
  auto* g = get_gpu(env); if (g) g->release(handle);
}

// Executor-only GPU ops (the unified executor.wasm; effects never call these):
// per-stage render target, format query for delayed-wire texture retention, the
// frame submit-batch coalescing, and a no-layout compute PSO for fused kernels.
static void gpu_set_surface(wasm_exec_env_t env, int32_t tex, int32_t w, int32_t h) {
  auto* g = get_gpu(env); if (g) g->setSurface(tex, (uint32_t)w, (uint32_t)h);
}
static int32_t gpu_get_texture_format(wasm_exec_env_t env, int32_t handle) {
  auto* g = get_gpu(env); return g ? g->getTextureFormat(handle) : -1;
}
// Sketch working format — what TextureFormat::SketchDefault (6) resolves to.
// set_ is executor-only (once per execute()); get_ is part of the effect ABI.
static void gpu_set_default_texture_format(wasm_exec_env_t env, int32_t format) {
  auto* g = get_gpu(env); if (g) g->setDefaultTextureFormat(format);
}
static int32_t gpu_get_default_texture_format(wasm_exec_env_t env) {
  auto* g = get_gpu(env); return g ? g->getDefaultTextureFormat() : 1;
}
static void gpu_begin_submit_batch(wasm_exec_env_t env) {
  auto* g = get_gpu(env); if (g) g->beginSubmitBatch();
}
static void gpu_end_submit_batch(wasm_exec_env_t env) {
  auto* g = get_gpu(env); if (g) g->endSubmitBatch();
}

// MSL reserves "main"; spirv-cross renames our shaders' entry "main"→"main0".
// Effects ask for "main" (matching WebGPU); map it for Metal — mirrors
// gpu_impls::mapEntryName on the native static path.
static std::string map_entry_name(gpu::GPUBackend* g, const char* entry, int len) {
  std::string e(entry, len);
  if (g && g->getBackend() == 0 /*Metal*/ && e == "main") return "main0";
  return e;
}

// gpu.create_shader_module_named — resolve a SPV shader the effect registered
// (state.register_shader_spv) into a backend module. The runtime owns the
// SPV→MSL translation (EffectHostSink::createShaderModuleByName); for WASM
// effects this replaces the build-time pre-baked MSL the native path uses.
static int32_t gpu_create_shader_module_named(wasm_exec_env_t env,
    int32_t name_ptr, int32_t name_len) {
  auto* ctx = get_ctx(env);
  if (!ctx || !ctx->effect_instance || !ctx->gpu_backend) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, name_ptr, name_len)) return -1;
  char* name = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, name_ptr));
  if (!name) return -1;
  return ctx->effect_instance->createShaderModuleByName(
      std::string(name, name_len), ctx->gpu_backend);
}

// gpu.create_compute_pso_v2 — layout + packed spec constants. The binding
// layout is for WebGPU's explicit bind groups; Metal binds by
// [[texture(n)]]/[[buffer(n)]] in the MSL, so it's ignored here. Entry name
// is mapped for Metal (main→main0). The constants
// payload (u32 count; per entry: u32 name_len, name bytes, f64 value) MUST be
// decoded and applied: shaders with [[function_constant(N)]] (e.g. motion_blur)
// fail Metal PSO validation without their values set. Mirrors gpu_impls.
static int32_t gpu_create_compute_pso_v2(wasm_exec_env_t env,
    int32_t shader, int32_t entry_ptr, int32_t entry_len,
    int32_t binding_count, int32_t bindings_ptr,
    int32_t constants_ptr, int32_t constants_len) {
  (void)binding_count; (void)bindings_ptr;
  auto* g = get_gpu(env);
  if (!g) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, entry_ptr, entry_len)) return -1;
  char* e = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, entry_ptr));
  if (!e) return -1;
  std::string entry = map_entry_name(g, e, entry_len);

  std::vector<gpu::GPUBackend::SpecConstant> consts;
  if (constants_len >= 4 &&
      wasm_runtime_validate_app_addr(inst, constants_ptr, constants_len)) {
    const unsigned char* p = static_cast<const unsigned char*>(
        wasm_runtime_addr_app_to_native(inst, constants_ptr));
    if (p) {
      int len = constants_len;
      auto rd32 = [](const unsigned char* q) {
        return (uint32_t)q[0] | ((uint32_t)q[1] << 8) |
               ((uint32_t)q[2] << 16) | ((uint32_t)q[3] << 24);
      };
      uint32_t count = rd32(p); p += 4; len -= 4;
      for (uint32_t i = 0; i < count && len >= 4; ++i) {
        uint32_t nlen = rd32(p); p += 4; len -= 4;
        if (len < (int)nlen + 8) break;
        std::string name(reinterpret_cast<const char*>(p), nlen);
        p += nlen; len -= (int)nlen;
        double v = 0; std::memcpy(&v, p, 8); p += 8; len -= 8;
        consts.push_back({std::move(name), v});
      }
    }
  }
  if (consts.empty()) return g->createComputePSO(shader, entry);
  return g->createComputePSOWithConstants(shader, entry, consts);
}

// Remaining resource/pass ops — thin pass-throughs to the GPUBackend (which
// provides Metal implementations / sensible defaults). Needed so a full effect
// bundle's effects (samplers, mip pyramids, copies) load without trapping.
static int32_t gpu_create_sampler(wasm_exec_env_t env, int32_t desc_ptr) {
  auto* g = get_gpu(env);
  if (!g) return -1;
  // Sized-descriptor read (gpu.h SamplerDesc): first i32 is the sent size.
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, desc_ptr, 4)) return -1;
  int32_t sent = 0;
  std::memcpy(&sent, wasm_runtime_addr_app_to_native(inst, desc_ptr), 4);
  if (sent < 4 || !wasm_runtime_validate_app_addr(inst, desc_ptr, sent)) return -1;
  auto* p = static_cast<const uint8_t*>(
      wasm_runtime_addr_app_to_native(inst, desc_ptr));
  return g->createSampler(gpu::GPUBackend::decodeSamplerDesc(p, sent));
}
static int32_t gpu_create_texture_mips(wasm_exec_env_t env, int32_t w, int32_t h,
    int32_t fmt, int32_t mips) {
  auto* g = get_gpu(env); return g ? g->createTextureWithMips(w, h, fmt, mips) : -1;
}
static int32_t gpu_create_texture_3d(wasm_exec_env_t env, int32_t w, int32_t h,
    int32_t d, int32_t fmt) {
  auto* g = get_gpu(env); return g ? g->createTexture3D(w, h, d, fmt) : -1;
}
static void gpu_compute_set_sampler(wasm_exec_env_t env, int32_t pass, int32_t s, int32_t slot) {
  auto* g = get_gpu(env); if (g) g->computeSetSampler(pass, s, slot);
}
static void gpu_compute_set_texture_mip(wasm_exec_env_t env, int32_t pass, int32_t tex,
    int32_t slot, int32_t access, int32_t mip) {
  auto* g = get_gpu(env); if (g) g->computeSetTextureMip(pass, tex, slot, access, mip);
}
static void gpu_clear_texture(wasm_exec_env_t env, int32_t tex,
    float r, float g_, float b, float a) {
  auto* g = get_gpu(env); if (g) g->clearTexture(tex, r, g_, b, a);
}
static void gpu_copy_texture(wasm_exec_env_t env, int32_t src, int32_t dst) {
  auto* g = get_gpu(env); if (g) g->copyTexture(src, dst);
}

// Instanced raster (particles / procedural-quad effects in lights/nano). The
// binding layout is WebGPU-only; Metal binds by slot. vs/fs entries mapped.
static int32_t gpu_create_instanced_render_pso_blend_layout(wasm_exec_env_t env,
    int32_t vs, int32_t vs_ptr, int32_t vs_len, int32_t fs, int32_t fs_ptr,
    int32_t fs_len, int32_t format, int32_t binding_count, int32_t bindings_ptr,
    int32_t blend_mode) {
  (void)binding_count; (void)bindings_ptr;
  auto* g = get_gpu(env);
  if (!g) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, vs_ptr, vs_len)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, fs_ptr, fs_len)) return -1;
  char* vse = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, vs_ptr));
  char* fse = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, fs_ptr));
  if (!vse || !fse) return -1;
  return g->createInstancedRenderPSO(vs, map_entry_name(g, vse, vs_len),
                                     fs, map_entry_name(g, fse, fs_len),
                                     format, blend_mode);
}
static int32_t gpu_begin_render_pass_load(wasm_exec_env_t env, int32_t tex) {
  auto* g = get_gpu(env); return g ? g->beginRenderPassLoad(tex) : -1;
}
static void gpu_render_set_buffer(wasm_exec_env_t env, int32_t pass, int32_t buf, int32_t slot) {
  auto* g = get_gpu(env); if (g) g->renderSetBuffer(pass, buf, slot);
}
// Bindings-explicit render-PSO factories. The backend derives bindings from
// shader reflection, so the binding layout args are ignored (as gpu_impls.cpp
// does). These complete the effect gpu ABI in the bundles host — without them an
// effect that calls one in module_init (e.g. debug.gpu_test,
// debug.particles_renderer) traps on an unlinked import, which leaks the wasm
// aux-stack pointer and breaks every effect registered after it in the bundle.
static int32_t gpu_create_render_pso_layout(wasm_exec_env_t env,
    int32_t vs, int32_t vs_ptr, int32_t vs_len, int32_t fs, int32_t fs_ptr,
    int32_t fs_len, int32_t format, int32_t binding_count, int32_t bindings_ptr) {
  (void)binding_count; (void)bindings_ptr;
  auto* g = get_gpu(env);
  if (!g) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, vs_ptr, vs_len)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, fs_ptr, fs_len)) return -1;
  char* vse = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, vs_ptr));
  char* fse = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, fs_ptr));
  if (!vse || !fse) return -1;
  return g->createRenderPSO(vs, map_entry_name(g, vse, vs_len),
                            fs, map_entry_name(g, fse, fs_len), format);
}
static int32_t gpu_create_instanced_render_pso_layout(wasm_exec_env_t env,
    int32_t vs, int32_t vs_ptr, int32_t vs_len, int32_t fs, int32_t fs_ptr,
    int32_t fs_len, int32_t format, int32_t binding_count, int32_t bindings_ptr) {
  (void)binding_count; (void)bindings_ptr;
  auto* g = get_gpu(env);
  if (!g) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, vs_ptr, vs_len)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, fs_ptr, fs_len)) return -1;
  char* vse = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, vs_ptr));
  char* fse = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, fs_ptr));
  if (!vse || !fse) return -1;
  return g->createInstancedRenderPSO(vs, map_entry_name(g, vse, vs_len),
                                     fs, map_entry_name(g, fse, fs_len),
                                     format, /*blend=*/0);
}
static int32_t gpu_create_instanced_render_pso_mrt_layout(wasm_exec_env_t env,
    int32_t vs, int32_t vs_ptr, int32_t vs_len, int32_t fs, int32_t fs_ptr,
    int32_t fs_len, int32_t target_count, int32_t target_formats_ptr,
    int32_t binding_count, int32_t bindings_ptr, int32_t target_blends_ptr) {
  (void)binding_count; (void)bindings_ptr;
  auto* g = get_gpu(env);
  if (!g || target_count < 0) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, vs_ptr, vs_len)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, fs_ptr, fs_len)) return -1;
  if (!wasm_runtime_validate_app_addr(inst, target_formats_ptr,
                                      target_count * (int32_t)sizeof(int32_t)))
    return -1;
  if (!wasm_runtime_validate_app_addr(inst, target_blends_ptr,
                                      target_count * (int32_t)sizeof(int32_t)))
    return -1;
  char* vse = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, vs_ptr));
  char* fse = static_cast<char*>(wasm_runtime_addr_app_to_native(inst, fs_ptr));
  int* fmts = static_cast<int*>(wasm_runtime_addr_app_to_native(inst, target_formats_ptr));
  int* blends = static_cast<int*>(wasm_runtime_addr_app_to_native(inst, target_blends_ptr));
  if (!vse || !fse || !fmts || !blends) return -1;
  return g->createInstancedRenderPSOMRT(vs, map_entry_name(g, vse, vs_len),
                                        fs, map_entry_name(g, fse, fs_len),
                                        target_count, fmts, blends);
}
static int32_t gpu_begin_render_pass_mrt(wasm_exec_env_t env, int32_t count,
    int32_t texs_ptr, int32_t clears_ptr, int32_t loads_ptr) {
  auto* g = get_gpu(env);
  if (!g || count < 0) return -1;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  if (!wasm_runtime_validate_app_addr(inst, texs_ptr, count * (int32_t)sizeof(int32_t)))
    return -1;
  if (!wasm_runtime_validate_app_addr(inst, clears_ptr,
                                      count * 4 * (int32_t)sizeof(float)))
    return -1;
  if (!wasm_runtime_validate_app_addr(inst, loads_ptr, count * (int32_t)sizeof(int32_t)))
    return -1;
  int* texs = static_cast<int*>(wasm_runtime_addr_app_to_native(inst, texs_ptr));
  float* clears = static_cast<float*>(wasm_runtime_addr_app_to_native(inst, clears_ptr));
  int* loads = static_cast<int*>(wasm_runtime_addr_app_to_native(inst, loads_ptr));
  if (!texs || !clears || !loads) return -1;
  return g->beginRenderPassMRT(count, texs, clears, loads);
}
static void gpu_compute_dispatch_indirect(wasm_exec_env_t env, int32_t pass,
    int32_t buf, int64_t offset) {
  auto* g = get_gpu(env);
  if (g && offset >= 0) g->computeDispatchIndirect(pass, buf, (uint64_t)offset);
}
static void gpu_render_draw_indirect(wasm_exec_env_t env, int32_t pass,
    int32_t buf, int64_t offset) {
  auto* g = get_gpu(env);
  if (g && offset >= 0) g->renderDrawIndirect(pass, buf, (uint64_t)offset);
}

static NativeSymbol gpu_symbols[] = {
    {"get_backend", reinterpret_cast<void*>(gpu_get_backend), "()i", nullptr},
    {"create_shader_module_named", reinterpret_cast<void*>(gpu_create_shader_module_named), "(ii)i", nullptr},
    {"create_sampler", reinterpret_cast<void*>(gpu_create_sampler), "(i)i", nullptr},
    {"create_texture_mips", reinterpret_cast<void*>(gpu_create_texture_mips), "(iiii)i", nullptr},
    {"create_texture_3d", reinterpret_cast<void*>(gpu_create_texture_3d), "(iiii)i", nullptr},
    {"compute_set_sampler", reinterpret_cast<void*>(gpu_compute_set_sampler), "(iii)", nullptr},
    {"compute_set_texture_mip", reinterpret_cast<void*>(gpu_compute_set_texture_mip), "(iiiii)", nullptr},
    {"clear_texture", reinterpret_cast<void*>(gpu_clear_texture), "(iffff)", nullptr},
    {"copy_texture", reinterpret_cast<void*>(gpu_copy_texture), "(ii)", nullptr},
    {"create_instanced_render_pso_blend_layout", reinterpret_cast<void*>(gpu_create_instanced_render_pso_blend_layout), "(iiiiiiiiii)i", nullptr},
    {"create_render_pso_layout", reinterpret_cast<void*>(gpu_create_render_pso_layout), "(iiiiiiiii)i", nullptr},
    {"create_instanced_render_pso_layout", reinterpret_cast<void*>(gpu_create_instanced_render_pso_layout), "(iiiiiiiii)i", nullptr},
    {"create_instanced_render_pso_mrt_layout", reinterpret_cast<void*>(gpu_create_instanced_render_pso_mrt_layout), "(iiiiiiiiiii)i", nullptr},
    {"begin_render_pass_mrt", reinterpret_cast<void*>(gpu_begin_render_pass_mrt), "(iiii)i", nullptr},
    {"compute_dispatch_indirect", reinterpret_cast<void*>(gpu_compute_dispatch_indirect), "(iiI)", nullptr},
    {"render_draw_indirect", reinterpret_cast<void*>(gpu_render_draw_indirect), "(iiI)", nullptr},
    {"begin_render_pass_load", reinterpret_cast<void*>(gpu_begin_render_pass_load), "(i)i", nullptr},
    {"render_set_buffer", reinterpret_cast<void*>(gpu_render_set_buffer), "(iii)", nullptr},
    {"create_compute_pso_v2", reinterpret_cast<void*>(gpu_create_compute_pso_v2), "(iiiiiii)i", nullptr},
    {"create_buffer", reinterpret_cast<void*>(gpu_create_buffer), "(Ii)i", nullptr},
    {"create_texture", reinterpret_cast<void*>(gpu_create_texture), "(iii)i", nullptr},
    {"create_compute_pso", reinterpret_cast<void*>(gpu_create_compute_pso), "(iii)i", nullptr},
    {"create_render_pso", reinterpret_cast<void*>(gpu_create_render_pso), "(iiiiiii)i", nullptr},
    {"write_buffer", reinterpret_cast<void*>(gpu_write_buffer), "(iiii)", nullptr},
    {"request_readback", reinterpret_cast<void*>(gpu_request_readback), "(ii)", nullptr},
    {"poll_readback", reinterpret_cast<void*>(gpu_poll_readback), "(iii)i", nullptr},
    {"begin_compute_pass", reinterpret_cast<void*>(gpu_begin_compute_pass), "()i", nullptr},
    {"compute_set_pso", reinterpret_cast<void*>(gpu_compute_set_pso), "(ii)", nullptr},
    {"compute_set_buffer", reinterpret_cast<void*>(gpu_compute_set_buffer), "(iiii)", nullptr},
    {"compute_set_texture", reinterpret_cast<void*>(gpu_compute_set_texture), "(iiii)", nullptr},
    {"compute_dispatch", reinterpret_cast<void*>(gpu_compute_dispatch), "(iiii)", nullptr},
    {"end_compute_pass", reinterpret_cast<void*>(gpu_end_compute_pass), "(i)", nullptr},
    {"begin_render_pass", reinterpret_cast<void*>(gpu_begin_render_pass), "(iffff)i", nullptr},
    {"render_set_pso", reinterpret_cast<void*>(gpu_render_set_pso), "(ii)", nullptr},
    {"render_set_vertex_buffer", reinterpret_cast<void*>(gpu_render_set_vertex_buffer), "(iiii)", nullptr},
    {"render_draw", reinterpret_cast<void*>(gpu_render_draw), "(iii)", nullptr},
    {"end_render_pass", reinterpret_cast<void*>(gpu_end_render_pass), "(i)", nullptr},
    {"submit", reinterpret_cast<void*>(gpu_submit), "()", nullptr},
    {"get_render_target", reinterpret_cast<void*>(gpu_get_render_target), "()i", nullptr},
    {"get_render_target_width", reinterpret_cast<void*>(gpu_get_render_target_width), "()i", nullptr},
    {"get_render_target_height", reinterpret_cast<void*>(gpu_get_render_target_height), "()i", nullptr},
    {"release", reinterpret_cast<void*>(gpu_release), "(i)", nullptr},
    {"get_input_texture", reinterpret_cast<void*>(gpu_get_input_texture), "(i)i", nullptr},
    {"get_input_texture_count", reinterpret_cast<void*>(gpu_get_input_texture_count), "()i", nullptr},
    {"texture_for_field", reinterpret_cast<void*>(gpu_texture_for_field), "(ii)i", nullptr},
    {"buffer_for_field", reinterpret_cast<void*>(gpu_buffer_for_field), "(ii)i", nullptr},
    // Executor-only ops (executor.wasm).
    {"set_surface", reinterpret_cast<void*>(gpu_set_surface), "(iii)", nullptr},
    {"get_texture_format", reinterpret_cast<void*>(gpu_get_texture_format), "(i)i", nullptr},
    {"set_default_texture_format", reinterpret_cast<void*>(gpu_set_default_texture_format), "(i)", nullptr},
    {"get_default_texture_format", reinterpret_cast<void*>(gpu_get_default_texture_format), "()i", nullptr},
    {"begin_submit_batch", reinterpret_cast<void*>(gpu_begin_submit_batch), "()", nullptr},
    {"end_submit_batch", reinterpret_cast<void*>(gpu_end_submit_batch), "()", nullptr},
};

// ========================================================================
// Module "module" — effect registration (captures EffectDesc_v2)
// ========================================================================

// A bundle's nano_module_main() registers each effect it provides via a small
// name-keyed builder: begin() allocates a builder and returns its handle;
// str()/fn() fill metadata strings + lifecycle callback table-indices BY NAME;
// end() finalizes. Nothing about a descriptor's byte layout is baked in here,
// so a new metadata field or lifecycle hook is just a new name captured
// generically — no offset/version changes on this boundary.

static std::string read_app_string(wasm_module_inst_t inst, int32_t ptr,
                                   int32_t len) {
  if (len <= 0 || !wasm_runtime_validate_app_addr(inst, ptr, len)) return {};
  const char* p = static_cast<const char*>(
      wasm_runtime_addr_app_to_native(inst, ptr));
  return p ? std::string(p, len) : std::string();
}

static int32_t module_register_effect_begin(wasm_exec_env_t env) {
  auto* ctx = get_ctx(env);
  if (!ctx) return 0;
  int32_t h = ctx->next_effect_builder++;
  WasmEffectDesc& d = ctx->effect_builders[h];
  d.abi_version = ctx->abi_version;
  return h;
}

static void module_register_effect_str(wasm_exec_env_t env, int32_t handle,
                                       int32_t name_ptr, int32_t name_len,
                                       int32_t val_ptr, int32_t val_len) {
  auto* ctx = get_ctx(env);
  if (!ctx) return;
  auto it = ctx->effect_builders.find(handle);
  if (it == ctx->effect_builders.end()) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  std::string name = read_app_string(inst, name_ptr, name_len);
  std::string val = read_app_string(inst, val_ptr, val_len);
  WasmEffectDesc& d = it->second;
  if (name == "id") d.id = std::move(val);
  else if (name == "name") d.name = std::move(val);
  else if (name == "description") d.description = std::move(val);
  else if (name == "category") d.category = std::move(val);
  else if (name == "keywords") d.keywords = std::move(val);
  // Unknown metadata names are ignored (forward-compatible).
}

static void module_register_effect_fn(wasm_exec_env_t env, int32_t handle,
                                      int32_t name_ptr, int32_t name_len,
                                      int32_t fn_idx) {
  auto* ctx = get_ctx(env);
  if (!ctx) return;
  if (fn_idx == 0) return;  // null callback == "not provided"
  auto it = ctx->effect_builders.find(handle);
  if (it == ctx->effect_builders.end()) return;
  wasm_module_inst_t inst = wasm_runtime_get_module_inst(env);
  std::string name = read_app_string(inst, name_ptr, name_len);
  if (name.empty()) return;
  it->second.fns[name] = static_cast<uint32_t>(fn_idx);
}

static void module_register_effect_end(wasm_exec_env_t env, int32_t handle) {
  auto* ctx = get_ctx(env);
  if (!ctx) return;
  auto it = ctx->effect_builders.find(handle);
  if (it == ctx->effect_builders.end()) return;
  WasmEffectDesc desc = std::move(it->second);
  ctx->effect_builders.erase(it);
  if (auto* host = get_host(env)) {
    host->log("module.register_effect: " + desc.id);
  }
  ctx->registered_effects.push_back(std::move(desc));
}

static NativeSymbol module_symbols[] = {
    {"register_effect_begin", reinterpret_cast<void*>(module_register_effect_begin), "()i", nullptr},
    {"register_effect_str", reinterpret_cast<void*>(module_register_effect_str), "(iiiii)", nullptr},
    {"register_effect_fn", reinterpret_cast<void*>(module_register_effect_fn), "(iiii)", nullptr},
    {"register_effect_end", reinterpret_cast<void*>(module_register_effect_end), "(i)", nullptr},
};

// ========================================================================
// Registration
// ========================================================================

bool register_host_functions() {
  bool ok = true;

  ok = ok && wasm_runtime_register_natives(
      "env", env_symbols,
      sizeof(env_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "host", host_symbols,
      sizeof(host_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "resolume", resolume_symbols,
      sizeof(resolume_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "streams", streams_symbols,
      sizeof(streams_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "resources", resources_symbols,
      sizeof(resources_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "state", state_symbols,
      sizeof(state_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "io", io_symbols,
      sizeof(io_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "val", val_symbols,
      sizeof(val_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "gpu", gpu_symbols,
      sizeof(gpu_symbols) / sizeof(NativeSymbol));

  ok = ok && wasm_runtime_register_natives(
      "module", module_symbols,
      sizeof(module_symbols) / sizeof(NativeSymbol));

  return ok;
}

} // namespace wasm
