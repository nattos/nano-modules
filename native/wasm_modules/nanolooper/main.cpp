/*
 * NanoLooper WASM Module
 *
 * A 4-channel, 16-step looper sequencer with visual overlay.
 * Imports from "canvas", "host", and "resolume" host modules.
 */

#include "core.h"
#include "../../src/json/json_doc_client.h"

#include <cmath>
#include <cstring>

/* ======================================================================
 * Host function imports
 * ====================================================================== */

/* canvas module */
__attribute__((import_module("canvas"), import_name("fill_rect")))
extern void canvas_fill_rect(float x, float y, float w, float h,
                              float r, float g, float b, float a);

__attribute__((import_module("canvas"), import_name("draw_image")))
extern void canvas_draw_image(int tex_id, float x, float y, float w, float h);

__attribute__((import_module("canvas"), import_name("draw_text")))
extern void canvas_draw_text(const char* text, int len,
                              float x, float y, float size,
                              float r, float g, float b, float a);

/* host module */
__attribute__((import_module("host"), import_name("get_time")))
extern double host_get_time(void);

__attribute__((import_module("host"), import_name("get_delta_time")))
extern double host_get_delta_time(void);

__attribute__((import_module("host"), import_name("get_bar_phase")))
extern double host_get_bar_phase(void);

__attribute__((import_module("host"), import_name("get_bpm")))
extern double host_get_bpm(void);

__attribute__((import_module("host"), import_name("get_param")))
extern double host_get_param(int index);

__attribute__((import_module("host"), import_name("trigger_audio")))
extern void host_trigger_audio(int channel);

/* state module */
__attribute__((import_module("state"), import_name("set_schema")))
extern void state_set_schema(const char* id, int id_len, int version_packed,
                              const char* schema, int schema_len);

__attribute__((import_module("state"), import_name("console_log")))
extern void state_console_log(int level, const char* msg, int msg_len);

__attribute__((import_module("state"), import_name("get_key")))
extern int state_get_key(char* buf, int buf_len);

__attribute__((import_module("state"), import_name("set")))
extern void state_set(const char* path, int path_len, const char* json, int json_len);

__attribute__((import_module("state"), import_name("console_log_structured")))
extern void state_console_log_structured(int level, const char* msg, int msg_len,
                                          const char* json, int json_len);

__attribute__((import_module("state"), import_name("read")))
extern int state_read(const char* layout, int field_count, const char* paths,
                      char* output, int output_size, char* results);

/* resolume module */
__attribute__((import_module("resolume"), import_name("trigger_clip")))
extern void resolume_trigger_clip(long long clip_id, int on);

__attribute__((import_module("resolume"), import_name("get_clip_count")))
extern int resolume_get_clip_count(void);

__attribute__((import_module("resolume"), import_name("get_clip_channel")))
extern int resolume_get_clip_channel(int index);

__attribute__((import_module("resolume"), import_name("get_clip_id")))
extern long long resolume_get_clip_id(int index);

__attribute__((import_module("resolume"), import_name("get_clip_connected")))
extern int resolume_get_clip_connected(int index);

__attribute__((import_module("resolume"), import_name("get_clip_name")))
extern int resolume_get_clip_name(int index, char* buf, int buf_len);

__attribute__((import_module("resolume"), import_name("load_thumbnail")))
extern int resolume_load_thumbnail(int clip_index);

/* ======================================================================
 * State
 * ====================================================================== */

static LooperCore looper;
static double phase = 0.0;
static double prev_phase = 0.0;
static double elapsed = 0.0;

/* Per-channel state */
static int trigger_held[NUM_CHANNELS];
static int gate_down[NUM_CHANNELS];
static float gate_timer[NUM_CHANNELS];
static float flash[NUM_CHANNELS];

/* Modifier keys */
static int delete_held;
static int delete_acted;           /* did delete+trigger happen during this press? */
static int last_action_was_clear;  /* was the last standalone delete a clear-all? */
static int mute_held;
static int record_held;
static int show_overlay;

/* Connection state */
static int ws_connected;

/* Channel → clip mapping */
#define MAX_CHANNEL_CLIPS 8
static long long channel_clip_ids[NUM_CHANNELS][MAX_CHANNEL_CLIPS];
static int channel_clip_count[NUM_CHANNELS];
static char channel_names[NUM_CHANNELS][64];
static int channel_thumb_tex[NUM_CHANNELS];
static int channel_connected[NUM_CHANNELS];

/* Channel colors (matching original) */
static const float CH_R[4] = {1.0f, 0.33f, 1.0f, 0.33f};
static const float CH_G[4] = {0.33f, 1.0f, 1.0f, 1.0f};
static const float CH_B[4] = {0.33f, 0.33f, 0.33f, 1.0f};

/* Parameter types (matching FFGL / state_document.h ParamType) */
#define PARAM_BOOLEAN  0
#define PARAM_STANDARD 10

/* Param IDs (must match LooperParamID enum) */
#define PID_TRIGGER_1    0
#define PID_TRIGGER_2    1
#define PID_TRIGGER_3    2
#define PID_TRIGGER_4    3
#define PID_DELETE       4
#define PID_MUTE         5
#define PID_UNDO         6
#define PID_REDO         7
#define PID_RECORD       8
#define PID_SHOW_OVERLAY 9
#define PID_SYNTH        10
#define PID_SYNTH_GAIN   11

/* ======================================================================
 * Helpers
 * ====================================================================== */

static int str_len(const char* s) {
  int n = 0;
  while (s[n]) n++;
  return n;
}

static void text(const char* s, float x, float y, float size,
                 float r, float g, float b, float a) {
  canvas_draw_text(s, str_len(s), x, y, size, r, g, b, a);
}

/* Log levels */
#define LOG_INFO  0
#define LOG_WARN  1
#define LOG_ERROR 2

static void log_msg(int level, const char* msg) {
  state_console_log(level, msg, str_len(msg));
}

// Removed: decl_param — using schema-based declaration now

static void log_structured(int level, const char* msg, const char* json) {
  state_console_log_structured(level, msg, str_len(msg), json, str_len(json));
}

/* Publish the current sequencer grid state as JSON */
static void publish_state(void) {
  /* Build a JSON string representing the grid and playback state.
   * Format: {"phase":N,"recording":B,"grid":[[steps],[steps],[steps],[steps]]}
   * Keep it compact since this runs every tick. */
  static char buf[512];
  int pos = 0;

  /* Macro for safe append */
  #define APPEND(s) do { \
    const char* _s = (s); \
    while (*_s && pos < (int)sizeof(buf) - 1) buf[pos++] = *_s++; \
  } while(0)
  #define APPEND_INT(n) do { \
    char _tmp[16]; int _v = (n), _i = 0; \
    if (_v < 0) { buf[pos++] = '-'; _v = -_v; } \
    if (_v == 0) { buf[pos++] = '0'; } else { \
      while (_v > 0) { _tmp[_i++] = '0' + _v % 10; _v /= 10; } \
      while (_i > 0) buf[pos++] = _tmp[--_i]; \
    } \
  } while(0)

  APPEND("{\"phase\":");
  APPEND_INT((int)phase);
  APPEND(",\"recording\":");
  APPEND(record_held ? "true" : "false");
  APPEND(",\"event_count\":");
  APPEND_INT(looper.event_count);
  APPEND(",\"grid\":[");

  for (int ch = 0; ch < NUM_CHANNELS; ch++) {
    if (ch > 0) APPEND(",");
    APPEND("[");
    int first = 1;
    for (int s = 0; s < NUM_STEPS; s++) {
      if (looper_has_event(&looper, ch, s)) {
        if (!first) APPEND(",");
        APPEND_INT(s);
        first = 0;
      }
    }
    APPEND("]");
  }
  APPEND("]}");
  buf[pos] = 0;

  #undef APPEND
  #undef APPEND_INT

  /* Set the entire state document */
  static const char path[] = "";
  state_set(path, 0, buf, pos);
}

/* Quick JSON snippet builder for structured logs */
static char _jbuf[128];
static const char* json_ch_step(int ch, int step) {
  int p = 0;
  _jbuf[p++] = '{'; _jbuf[p++] = '"'; _jbuf[p++] = 'c'; _jbuf[p++] = 'h'; _jbuf[p++] = '"'; _jbuf[p++] = ':';
  _jbuf[p++] = '0' + ch;
  _jbuf[p++] = ','; _jbuf[p++] = '"'; _jbuf[p++] = 's'; _jbuf[p++] = 't'; _jbuf[p++] = 'e'; _jbuf[p++] = 'p'; _jbuf[p++] = '"'; _jbuf[p++] = ':';
  if (step >= 10) { _jbuf[p++] = '0' + step / 10; }
  _jbuf[p++] = '0' + step % 10;
  _jbuf[p++] = '}'; _jbuf[p] = 0;
  return _jbuf;
}

static void gate_on(int ch) {
  gate_down[ch] = 1;
  gate_timer[ch] = 0.25f;
  flash[ch] = 0.25f;
  for (int i = 0; i < channel_clip_count[ch]; i++)
    resolume_trigger_clip(channel_clip_ids[ch][i], 1);
  host_trigger_audio(ch);
}

static void gate_off(int ch) {
  if (!gate_down[ch]) return;
  gate_down[ch] = 0;
  for (int i = 0; i < channel_clip_count[ch]; i++)
    resolume_trigger_clip(channel_clip_ids[ch][i], 0);
}

static void refresh_channels(void) {
  int clip_count = resolume_get_clip_count();
  for (int ch = 0; ch < NUM_CHANNELS; ch++) {
    channel_clip_count[ch] = 0;
    channel_names[ch][0] = 0;
    channel_thumb_tex[ch] = -1;
    channel_connected[ch] = 0;
  }
  for (int i = 0; i < clip_count; i++) {
    int ch = resolume_get_clip_channel(i);
    if (ch < 0 || ch >= NUM_CHANNELS) continue;
    if (channel_clip_count[ch] < MAX_CHANNEL_CLIPS) {
      channel_clip_ids[ch][channel_clip_count[ch]++] = resolume_get_clip_id(i);
    }
    if (channel_clip_count[ch] == 1) {
      resolume_get_clip_name(i, channel_names[ch], 64);
      channel_connected[ch] = resolume_get_clip_connected(i);
      channel_thumb_tex[ch] = resolume_load_thumbnail(i);
    }
  }
}

/* ======================================================================
 * Exports
 * ====================================================================== */

__attribute__((export_name("init")))
void init(void) {
  looper_init(&looper, (double)NUM_STEPS);
  phase = 0;
  prev_phase = 0;
  elapsed = 0;
  show_overlay = 1;
  ws_connected = 0;

  for (int i = 0; i < NUM_CHANNELS; i++) {
    trigger_held[i] = 0;
    gate_down[i] = 0;
    gate_timer[i] = 0;
    flash[i] = 0;
    channel_clip_count[i] = 0;
    channel_names[i][0] = 0;
    channel_thumb_tex[i] = -1;
    channel_connected[i] = 0;
  }
  delete_held = 0;
  delete_acted = 0;
  last_action_was_clear = 0;
  mute_held = 0;
  record_held = 0;

  /* Register plugin with schema */
  static const char id[] = "com.nattos.nanolooper";
  static const char schema[] =
    "{\"fields\":{"
    "\"trigger_1\":{\"type\":\"event\",\"io\":5,\"order\":0},"
    "\"trigger_2\":{\"type\":\"event\",\"io\":5,\"order\":1},"
    "\"trigger_3\":{\"type\":\"event\",\"io\":5,\"order\":2},"
    "\"trigger_4\":{\"type\":\"event\",\"io\":5,\"order\":3},"
    "\"delete\":{\"type\":\"event\",\"io\":5,\"order\":4},"
    "\"mute\":{\"type\":\"bool\",\"default\":false,\"io\":5,\"order\":5},"
    "\"undo\":{\"type\":\"event\",\"io\":5,\"order\":6},"
    "\"redo\":{\"type\":\"event\",\"io\":5,\"order\":7},"
    "\"record\":{\"type\":\"bool\",\"default\":false,\"io\":5,\"order\":8},"
    "\"show_overlay\":{\"type\":\"bool\",\"default\":true,\"io\":5,\"order\":9},"
    "\"synth\":{\"type\":\"bool\",\"default\":false,\"io\":5,\"order\":10},"
    "\"synth_gain\":{\"type\":\"float\",\"default\":0.5,\"min\":0,\"max\":1,\"io\":5,\"order\":11}"
    "}}";
  state_set_schema(id, sizeof(id) - 1, (1 << 16), schema, sizeof(schema) - 1);

  char key_buf[64];
  int key_len = state_get_key(key_buf, sizeof(key_buf) - 1);
  key_buf[key_len] = 0;

  /* Build: "NanoLooper initialized as <key>" */
  static char init_msg[128];
  int p = 0;
  const char* prefix = "NanoLooper initialized as ";
  while (*prefix) init_msg[p++] = *prefix++;
  for (int i = 0; i < key_len && p < 127; i++) init_msg[p++] = key_buf[i];
  init_msg[p] = 0;

  log_msg(LOG_INFO, init_msg);
  publish_state();
}

__attribute__((export_name("tick")))
void tick(double dt) {
  elapsed += dt;

  /* Advance phase from host bar phase */
  double bar = host_get_bar_phase();
  prev_phase = phase;
  phase = bar * NUM_STEPS;

  /* Advance looper — fire events */
  int fired[NUM_CHANNELS];
  int fired_count = 0;
  looper_advance(&looper, prev_phase, phase, fired, &fired_count);
  for (int i = 0; i < fired_count; i++) {
    int ch = fired[i];
    if (!mute_held || !trigger_held[ch]) {
      gate_on(ch);
    }
  }

  /* Decay gate timers */
  for (int ch = 0; ch < NUM_CHANNELS; ch++) {
    if (gate_down[ch]) {
      gate_timer[ch] -= (float)dt;
      if (gate_timer[ch] <= 0) {
        gate_off(ch);
      }
    }
    if (flash[ch] > 0)
      flash[ch] -= (float)dt;
  }

  publish_state();
}

__attribute__((export_name("on_param_change")))
void on_param_change(int index, double value) {
  int pressed = (value >= 0.5);

  if (index >= PID_TRIGGER_1 && index <= PID_TRIGGER_4) {
    int ch = index - PID_TRIGGER_1;
    int was = trigger_held[ch];
    trigger_held[ch] = pressed;

    if (pressed && !was) {
      /* Rising edge */
      if (delete_held) {
        looper_clear_channel(&looper, ch);
        delete_acted = 1;
        last_action_was_clear = 0;
        gate_off(ch);
        log_structured(LOG_INFO, "Clear channel", json_ch_step(ch + 1, -1));
      } else if (mute_held) {
        gate_off(ch);
      } else {
        int step = (int)phase % NUM_STEPS;
        last_action_was_clear = 0;
        looper_trigger(&looper, ch, phase);
        gate_on(ch);
        log_structured(LOG_INFO, "Trigger", json_ch_step(ch + 1, step));
      }
    } else if (!pressed && was) {
      /* Falling edge */
      gate_off(ch);
    }
  } else if (index == PID_DELETE) {
    if (pressed) {
      delete_held = 1;
      delete_acted = 0;
    } else if (delete_held) {
      /* Release: if no trigger was pressed during hold, do clear or undo */
      if (!delete_acted) {
        if (last_action_was_clear && looper.undo_count > 0) {
          /* Double-tap delete = undo */
          looper_undo(&looper);
          last_action_was_clear = 0;
          log_msg(LOG_INFO, "Undo (double-tap delete)");
        } else {
          looper_clear_all(&looper);
          last_action_was_clear = 1;
          log_msg(LOG_INFO, "Clear all");
        }
        for (int c = 0; c < NUM_CHANNELS; c++) gate_off(c);
      }
      delete_held = 0;
    }
  } else if (index == PID_MUTE) {
    mute_held = pressed;
  } else if (index == PID_UNDO) {
    if (pressed) {
      looper_undo(&looper);
      last_action_was_clear = 0;
      for (int c = 0; c < NUM_CHANNELS; c++) gate_off(c);
      log_msg(LOG_INFO, "Undo");
    }
  } else if (index == PID_REDO) {
    if (pressed) {
      looper_redo(&looper);
      last_action_was_clear = 0;
      for (int c = 0; c < NUM_CHANNELS; c++) gate_off(c);
      log_msg(LOG_INFO, "Redo");
    }
  } else if (index == PID_RECORD) {
    if (pressed && !record_held) {
      last_action_was_clear = 0;
      looper_begin_destructive_record(&looper);
      log_msg(LOG_WARN, "Record mode ON");
    } else if (!pressed && record_held) {
      looper_end_destructive_record(&looper);
      log_msg(LOG_INFO, "Record mode OFF");
    }
    record_held = pressed;
  } else if (index == PID_SHOW_OVERLAY) {
    show_overlay = pressed;
  }
}

/* --- State change handler (called by host when canonical state is modified) --- */

/* Buffer layout for reading grid from state document */
struct GridReadBuf {
  /* 4 channels, each: [i32 count][i32 steps[16]] = 4 + 64 = 68 bytes */
  int32_t ch0_count; int32_t ch0_steps[NUM_STEPS];
  int32_t ch1_count; int32_t ch1_steps[NUM_STEPS];
  int32_t ch2_count; int32_t ch2_steps[NUM_STEPS];
  int32_t ch3_count; int32_t ch3_steps[NUM_STEPS];
};

/* Paths for state.read layout (packed, null-separated) */
static const char grid_paths[] =
  "/grid/0\0"   /* 0: offset 0, len 7 */
  "/grid/1\0"   /* 1: offset 8, len 7 */
  "/grid/2\0"   /* 2: offset 16, len 7 */
  "/grid/3\0";  /* 3: offset 24, len 7 */

#define GRID_CH_SIZE (4 + NUM_STEPS * 4)  /* i32 count + i32[16] */

static JDocField grid_layout[NUM_CHANNELS] = {
  { 0,  7, JDOC_TYPE_ARRAY_I32, 0 * GRID_CH_SIZE, NUM_STEPS },
  { 8,  7, JDOC_TYPE_ARRAY_I32, 1 * GRID_CH_SIZE, NUM_STEPS },
  { 16, 7, JDOC_TYPE_ARRAY_I32, 2 * GRID_CH_SIZE, NUM_STEPS },
  { 24, 7, JDOC_TYPE_ARRAY_I32, 3 * GRID_CH_SIZE, NUM_STEPS },
};

static void load_grid_from_state(void) {
  struct GridReadBuf buf;
  JDocResult results[NUM_CHANNELS];

  int overflow = state_read(
    (const char*)grid_layout, NUM_CHANNELS,
    grid_paths,
    (char*)&buf, (int)sizeof(buf),
    (char*)results);
  (void)overflow;

  /* Only update if we actually got grid data */
  int any_found = 0;
  for (int i = 0; i < NUM_CHANNELS; i++) {
    if (results[i].found) any_found = 1;
  }
  if (!any_found) return;

  /* Rebuild looper events from the grid arrays */
  looper.event_count = 0;
  looper.undo_count = 0;
  looper.redo_count = 0;

  int32_t* channel_data[NUM_CHANNELS] = {
    buf.ch0_steps, buf.ch1_steps, buf.ch2_steps, buf.ch3_steps
  };
  int32_t channel_counts[NUM_CHANNELS] = {
    buf.ch0_count, buf.ch1_count, buf.ch2_count, buf.ch3_count
  };

  for (int ch = 0; ch < NUM_CHANNELS; ch++) {
    if (!results[ch].found) continue;
    int count = channel_counts[ch];
    if (count > NUM_STEPS) count = NUM_STEPS;
    for (int j = 0; j < count; j++) {
      int step = channel_data[ch][j];
      if (step >= 0 && step < NUM_STEPS && looper.event_count < MAX_EVENTS) {
        looper.events[looper.event_count].time = (double)step;
        looper.events[looper.event_count].channel = ch;
        looper.event_count++;
      }
    }
  }

  log_msg(LOG_INFO, "Grid loaded from state");
}

__attribute__((export_name("on_state_changed")))
void on_state_changed(void) {
  load_grid_from_state();
}

__attribute__((export_name("render")))
void render(int vp_w, int vp_h) {
  if (!show_overlay) return;

  /* Scale factor: base design at 1080p, scale proportionally */
  float scale = (float)vp_h / 1080.0f;
  float gw = 24.0f * scale;        /* glyph width (monospace advance) */
  float lh = 28.0f * scale;        /* line height */
  float font_size = 24.0f * scale; /* bitmap font render size */
  float margin = 20.0f * scale;
  float row_gap = 6.0f * scale;

  float y = margin;

  /* --- Title --- */
  text("Looper", margin, y, font_size, 0.9f, 0.9f, 0.9f, 0.9f);
  if (record_held)
    text("* REC", margin + gw * 8, y, font_size, 1, 0.2f, 0.2f, 1);
  y += lh + row_gap;

  /* --- Connection status --- */
  {
    float dot_size = lh * 0.5f;
    float dot_y = y + (lh - dot_size) * 0.5f;
    float text_x = margin + dot_size + gw * 0.5f;
    float t = (float)elapsed;

    float pulse = 0.3f + 0.7f * (0.5f + 0.5f * sinf(t * 8.0f));
    canvas_fill_rect(margin, dot_y, dot_size, dot_size,
                     0.3f, 0.5f, 1.0f, pulse);
    text("Connecting...", text_x, y, font_size, 0.4f, 0.6f, 1.0f, 0.6f);
  }
  y += lh + row_gap;

  /* --- Clip cards --- */
  {
    float card_w = lh * 5;
    float thumb_h = card_w * 0.6f;
    float card_h = thumb_h + lh + 4 * scale;
    float card_gap = 8.0f * scale;
    float border = 3.0f * scale;

    for (int i = 0; i < NUM_CHANNELS; i++) {
      float cx = margin + i * (card_w + card_gap);
      int has_content = (channel_clip_count[i] > 0);
      int ch_active = (gate_down[i]);

      float br, bg, bb, ba;
      if (ch_active) {
        br = CH_R[i]; bg = CH_G[i]; bb = CH_B[i]; ba = 0.9f;
      } else if (has_content) {
        br = CH_R[i]*0.4f; bg = CH_G[i]*0.4f; bb = CH_B[i]*0.4f; ba = 0.5f;
      } else {
        br = 0.25f; bg = 0.25f; bb = 0.25f; ba = 0.3f;
      }

      /* Border */
      canvas_fill_rect(cx, y, card_w, card_h, br, bg, bb, ba);
      /* Inner */
      canvas_fill_rect(cx + border, y + border,
                       card_w - border*2, card_h - border*2,
                       0.05f, 0.05f, 0.05f, 0.85f);

      /* Thumbnail */
      float tw = card_w - border*2 - 2*scale;
      float th = thumb_h - border - 2*scale;
      if (channel_thumb_tex[i] >= 0) {
        canvas_draw_image(channel_thumb_tex[i],
                          cx + border + scale, y + border + scale, tw, th);
      } else {
        canvas_fill_rect(cx + border + scale, y + border + scale,
                         tw, th, 0.12f, 0.12f, 0.12f, 0.6f);
      }

      /* Clip name */
      const char* name = channel_names[i];
      if (name[0] == 0) name = "(empty)";
      float name_y = y + thumb_h + 2*scale;
      float name_size = font_size * 0.7f;
      text(name, cx + border + 2*scale, name_y, name_size,
           0.7f, 0.7f, 0.7f, 0.7f);

      /* Mute overlay */
      if (mute_held && trigger_held[i]) {
        canvas_fill_rect(cx + border, y + border,
                         card_w - border*2, card_h - border*2,
                         0, 0, 0, 0.6f);
        text("MUTE", cx + card_w*0.25f, y + thumb_h*0.4f, font_size,
             0.8f, 0.3f, 0.3f, 0.8f);
      }
    }
    y += card_h + row_gap * 2;
  }

  /* --- Beat markers --- */
  float cells_x = margin + gw * 2;
  float cell = lh + 4*scale;
  int current_step = (int)floor(phase);
  if (current_step >= NUM_STEPS) current_step = 0;

  {
    char buf[4];
    for (int beat = 0; beat < 4; beat++) {
      float bx = cells_x + beat * 4 * cell;
      buf[0] = '|';
      buf[1] = '1' + beat;
      buf[2] = 0;
      canvas_draw_text(buf, 2, bx, y, font_size, 0.5f, 0.5f, 0.5f, 0.4f);
    }
  }
  y += lh * 0.8f + row_gap;

  /* --- Grid --- */
  for (int ch = 0; ch < NUM_CHANNELS; ch++) {
    int is_muted = mute_held && trigger_held[ch];
    float cr = CH_R[ch], cg = CH_G[ch], cb = CH_B[ch];

    char label[2] = { char('1' + ch), 0 };
    text(label, margin, y, font_size,
         is_muted ? cr*0.3f : cr, is_muted ? cg*0.3f : cg, is_muted ? cb*0.3f : cb, 1.0f);

    int act_step = gate_down[ch] ? current_step : -1;

    for (int s = 0; s < NUM_STEPS; s++) {
      float cx = cells_x + s * cell;
      int has_event = looper_has_event(&looper, ch, s);
      int cur = (s == current_step);
      int playing = (s == act_step);

      if (cur)
        canvas_fill_rect(cx - scale, y - scale, cell, cell, 0.5f, 0.5f, 0.5f, 0.25f);

      if (has_event) {
        float bar_w = 3.0f * scale;
        if (is_muted) {
          canvas_fill_rect(cx, y, bar_w, lh, cr, cg, cb, 0.4f);
          canvas_fill_rect(cx + bar_w, y, cell - 2*scale - bar_w, lh, cr, cg, cb, 0.25f);
        } else if (playing) {
          canvas_fill_rect(cx, y, bar_w, lh, cr, cg, cb, 1.0f);
          canvas_fill_rect(cx + bar_w, y, cell - 2*scale - bar_w, lh, cr, cg, cb, 1.0f);
        } else {
          canvas_fill_rect(cx, y, bar_w, lh, cr, cg, cb, 1.0f);
          canvas_fill_rect(cx + bar_w, y, cell - 2*scale - bar_w, lh,
                           cr*0.5f, cg*0.5f, cb*0.5f, 0.7f);
        }
      } else {
        canvas_fill_rect(cx, y, cell - 2*scale, lh, 0.5f, 0.5f, 0.5f, cur ? 0.15f : 0.06f);
      }
    }
    y += cell;
  }
  y += row_gap;

  /* --- Trigger indicators + modifiers --- */
  for (int i = 0; i < NUM_CHANNELS; i++) {
    float x = margin + i * gw * 3;
    float alpha = flash[i] > 0 ? 1.0f : 0.3f;
    char label[2] = { char('1' + i), 0 };
    text(label, x, y, font_size, CH_R[i], CH_G[i], CH_B[i], alpha);
  }
  float mod_x = margin + NUM_CHANNELS * gw * 3 + gw * 2;
  text("D", mod_x, y, font_size, 1, 0.2f, 0.2f, delete_held ? 1.0f : 0.25f);
  text("M", mod_x + gw * 2, y, font_size, 1, 1, 0.2f, mute_held ? 1.0f : 0.25f);
  y += lh + row_gap;

  /* --- Background panel (drawn as first rect, will be behind due to draw order) --- */
  /* Note: Unlike the original GL code, we can't reorder draw commands after the fact.
     So we draw the background first in a separate pass. For the WASM version, the
     host should handle z-ordering or we accept the simpler approach of drawing
     the background first. We insert it at the top. */
  /* TODO: For proper z-ordering, the host would need a "begin layer" / "end layer" concept.
     For now, the background is drawn on top which is acceptable for the prototype. */
}
