/*
 * NanoLooper WASM Module
 *
 * A 4-channel, 16-step looper sequencer with visual overlay.
 * Imports from "canvas", "host", and "resolume" host modules.
 */

#include "core.h"

/* Use compiler builtins instead of libc math */
#define floor(x) __builtin_floor(x)
#define sinf(x) __builtin_sinf(x)

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

/* Param IDs (must match LooperParamID enum) */
#define PID_TRIGGER_1    0
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
  mute_held = 0;
  record_held = 0;
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
        gate_off(ch);
      } else if (mute_held) {
        gate_off(ch);
      } else {
        looper_trigger(&looper, ch, phase);
        gate_on(ch);
      }
    } else if (!pressed && was) {
      /* Falling edge */
      gate_off(ch);
    }
  } else if (index == PID_DELETE) {
    delete_held = pressed;
    if (pressed) {
      looper_clear_all(&looper);
    }
  } else if (index == PID_MUTE) {
    mute_held = pressed;
  } else if (index == PID_UNDO) {
    if (pressed) looper_undo(&looper);
  } else if (index == PID_REDO) {
    if (pressed) looper_redo(&looper);
  } else if (index == PID_RECORD) {
    if (pressed && !record_held) {
      looper_begin_destructive_record(&looper);
    } else if (!pressed && record_held) {
      looper_end_destructive_record(&looper);
    }
    record_held = pressed;
  } else if (index == PID_SHOW_OVERLAY) {
    show_overlay = pressed;
  }
}

__attribute__((export_name("render")))
void render(int vp_w, int vp_h) {
  if (!show_overlay) return;

  /* Scale factor: base design at 1080p, scale proportionally */
  float scale = (float)vp_h / 1080.0f;
  float gw = 8.0f * scale;        /* glyph width at base size */
  float lh = 8.0f * scale;        /* line height at base size */
  float font_size = 8.0f * scale; /* base font size */
  float margin = 16.0f * scale;
  float row_gap = 4.0f * scale;

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
      char* name = channel_names[i];
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

    char label[2] = { '1' + ch, 0 };
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
    char label[2] = { '1' + i, 0 };
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
