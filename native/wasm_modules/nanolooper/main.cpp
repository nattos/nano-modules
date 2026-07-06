/*
 * NanoLooper WASM Module
 *
 * A 4-channel, 16-step looper sequencer with visual overlay.
 * Uses shared host API headers for all host function imports.
 *
 * Class-like instance model (v2 ABI): module_init() publishes the schema
 * once per type; each chain entry gets its own State (sequencer core,
 * transport, edge-state, timers, channel mapping) via create(). All
 * instance callbacks take `self`.
 *
 * The visual overlay is drawn with the in-effect overlay toolbox (overlay.h):
 * solid rects/borders via an instanced GPU pass + labels via the host text
 * engine, composited onto tex_out over tex_in. (The old host `canvas_*` ABI is
 * a no-op in the sketch-executor / barrel render path, so the overlay never
 * showed there.) Declaring tex_out is what makes the executor bind a writable
 * render target and call render() at all — without it the looper is a
 * modulation-source passthrough and render() never runs.
 */

#include <gpu.h>
#include <host.h>
#include <overlay.h>
#include <val.h>
#include "core.h"
#include "../../src/json/json_doc_client.h"

#include <cmath>
#include <cstring>

namespace nanolooper {

/* ======================================================================
 * Constants
 * ====================================================================== */

/* Channel → clip mapping */
#define MAX_CHANNEL_CLIPS 8

/* Trigger-rail event ring (mirrors mod.trigger.beat). The executor drains the
 * published "triggers" ring onto the process-global trigger rail, which the
 * shared server launches Resolume clips from. */
#define TRIG_RING_CAP 16
struct LoopEv {
  long long seq = 0;
  bool on = false;
  int channel = 1;   /* 1-based rail channel */
  float velocity = 1.0f;
};

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
#define PID_SEND_TO_RAIL 12
#define PID_QUANTIZE_START  13
#define PID_QUANTIZE_LENGTH 14

/* ======================================================================
 * State
 * ====================================================================== */

/* Per-instance state. One per chain entry. Holds every mutable var that
 * used to live as a file-static in this module. */
struct State {
  LooperCore looper{};
  double phase = 0.0;
  double prev_phase = 0.0;
  double elapsed = 0.0;

  /* Per-channel state. trigger_held = physical press; gate_state = the combined
   * (live press OR played-back window) on/off we've actually emitted, diffed each
   * frame so on/off fire exactly on transitions. No fixed gate timer any more —
   * a played note's gate lasts exactly as long as it was recorded. */
  int trigger_held[NUM_CHANNELS] = {0};
  int gate_state[NUM_CHANNELS] = {0};
  float flash[NUM_CHANNELS] = {0};

  /* Modifier keys */
  int delete_held = 0;
  int delete_acted = 0;           /* did delete+trigger happen during this press? */
  int last_action_was_clear = 0;  /* was the last standalone delete a clear-all? */
  int mute_held = 0;
  int record_held = 0;
  int show_overlay = 0;
  int quantize_start = 0;
  int quantize_length = 0;

  /* Connection state */
  int ws_connected = 0;

  /* Trigger-rail output. `send_to_rail` gates emission; the ring carries on/off
   * events (channel = ch+1); ch_out[] is a per-channel 1→0 decay pulse exposed
   * as the out_N modulation outputs (visible trace + wireable gate). */
  int send_to_rail = 1;
  LoopEv trig_ring[TRIG_RING_CAP] = {};
  int trig_ring_len = 0;
  long long trig_seq = 0;
  float ch_out[NUM_CHANNELS] = {0};

  /* Channel → clip mapping */
  long long channel_clip_ids[NUM_CHANNELS][MAX_CHANNEL_CLIPS] = {{0}};
  int channel_clip_count[NUM_CHANNELS] = {0};
  char channel_names[NUM_CHANNELS][64] = {{0}};
  int channel_thumb_tex[NUM_CHANNELS] = {0};
  int channel_connected[NUM_CHANNELS] = {0};

  /* Debug overlay drawer (solid-quad GPU rects + host-text labels). */
  overlay::Canvas ov;

  bool initialized = false;
};

/* ======================================================================
 * Pure helpers (no state)
 * ====================================================================== */

static int str_len(const char* s) {
  int n = 0;
  while (s[n]) n++;
  return n;
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

/* Quick JSON snippet builder for structured logs */
static const char* json_ch_step(int ch, int step) {
  static char _jbuf[128];
  int p = 0;
  _jbuf[p++] = '{'; _jbuf[p++] = '"'; _jbuf[p++] = 'c'; _jbuf[p++] = 'h'; _jbuf[p++] = '"'; _jbuf[p++] = ':';
  _jbuf[p++] = '0' + ch;
  _jbuf[p++] = ','; _jbuf[p++] = '"'; _jbuf[p++] = 's'; _jbuf[p++] = 't'; _jbuf[p++] = 'e'; _jbuf[p++] = 'p'; _jbuf[p++] = '"'; _jbuf[p++] = ':';
  if (step >= 10) { _jbuf[p++] = '0' + step / 10; }
  _jbuf[p++] = '0' + step % 10;
  _jbuf[p++] = '}'; _jbuf[p] = 0;
  return _jbuf;
}

/* ======================================================================
 * State-touching helpers
 * ====================================================================== */

/* Publish the current sequencer grid state as JSON */
static void publish_state(State& s) {
  /* Build a JSON string representing the grid and playback state.
   * Format: {"phase":N,"recording":B,"grid":[[steps],[steps],[steps],[steps]]}
   * Keep it compact since this runs every tick. */
  auto state = val::object();
  val::set(state, "phase", val::number(s.phase));
  val::set(state, "recording", val::boolean(s.record_held != 0));
  val::set(state, "event_count", val::number(s.looper.event_count));

  auto grid = val::array();
  for (int ch = 0; ch < NUM_CHANNELS; ch++) {
    auto channel = val::array();
    for (int st = 0; st < NUM_STEPS; st++) {
      if (looper_has_event(&s.looper, ch, st)) {
        val::push(channel, val::number(st));
      }
    }
    val::push(grid, channel);
  }
  val::set(state, "grid", grid);

  /* Per-channel modulation outputs (out_1..out_4): the decaying gate pulse. */
  val::set(state, "out_1", val::number(s.ch_out[0]));
  val::set(state, "out_2", val::number(s.ch_out[1]));
  val::set(state, "out_3", val::number(s.ch_out[2]));
  val::set(state, "out_4", val::number(s.ch_out[3]));

  /* Trigger-rail event ring — {seq,on,channel,velocity}. The executor drains it
   * onto the global rail (drainTriggerRing). Empty unless send_to_rail is on. */
  auto triggers = val::array();
  for (int i = 0; i < s.trig_ring_len; i++) {
    auto e = val::object();
    val::set(e, "seq", val::number((double)s.trig_ring[i].seq));
    val::set(e, "on", val::boolean(s.trig_ring[i].on));
    val::set(e, "channel", val::number(s.trig_ring[i].channel));
    val::set(e, "velocity", val::number(s.trig_ring[i].velocity));
    val::push(triggers, e);
  }
  val::set(state, "triggers", triggers);

  state::setVal(state);
  val::release(state);
}

/* Push an on/off trigger event onto the ring (channel is 1-based). Only when
 * send_to_rail is enabled — otherwise the ring stays empty and the executor has
 * nothing to drain. */
static void push_trigger(State& s, bool on, int ch /*0-based*/) {
  if (!s.send_to_rail) return;
  LoopEv e;
  e.seq = ++s.trig_seq;
  e.on = on;
  e.channel = ch + 1;
  e.velocity = 1.0f;
  if (s.trig_ring_len == TRIG_RING_CAP) {
    for (int i = 1; i < TRIG_RING_CAP; i++) s.trig_ring[i - 1] = s.trig_ring[i];
    s.trig_ring_len--;
  }
  s.trig_ring[s.trig_ring_len++] = e;
}

/* Emit a gate transition for one channel (idempotent — no-op if already in the
 * requested state). ON fires the flash + modulation pulse + audio + rail event;
 * OFF fires the rail off event. */
static void set_gate(State& s, int ch, bool on) {
  if (on && !s.gate_state[ch]) {
    s.gate_state[ch] = 1;
    s.flash[ch] = 0.25f;
    s.ch_out[ch] = 1.0f;              /* per-channel modulation-output pulse */
    push_trigger(s, /*on=*/true, ch); /* → global trigger rail */
    // Legacy direct-launch imports are no-op stubs; the rail is the live path.
    for (int i = 0; i < s.channel_clip_count[ch]; i++)
      resolume_trigger_clip(s.channel_clip_ids[ch][i], 1);
    host_trigger_audio(ch);
  } else if (!on && s.gate_state[ch]) {
    s.gate_state[ch] = 0;
    push_trigger(s, /*on=*/false, ch);
    for (int i = 0; i < s.channel_clip_count[ch]; i++)
      resolume_trigger_clip(s.channel_clip_ids[ch][i], 0);
  }
}

/* Single source of truth for every channel's gate: the live press OR a
 * played-back note window covering the current phase. Called after any input
 * edge and every tick (as the phase moves through recorded windows). Mute
 * silences a channel you're actively holding (mute + that trigger). */
static void recompute_gates(State& s) {
  int active[NUM_CHANNELS];
  looper_active_channels(&s.looper, s.phase, active);
  for (int ch = 0; ch < NUM_CHANNELS; ch++) {
    bool live = s.trigger_held[ch] && !s.mute_held && !s.delete_held;
    bool played = active[ch] && !(s.mute_held && s.trigger_held[ch]);
    set_gate(s, ch, live || played);
  }
}

static void refresh_channels(State& s) {
  int clip_count = resolume_get_clip_count();
  for (int ch = 0; ch < NUM_CHANNELS; ch++) {
    s.channel_clip_count[ch] = 0;
    s.channel_names[ch][0] = 0;
    s.channel_thumb_tex[ch] = -1;
    s.channel_connected[ch] = 0;
  }
  for (int i = 0; i < clip_count; i++) {
    int ch = resolume_get_clip_channel(i);
    if (ch < 0 || ch >= NUM_CHANNELS) continue;
    if (s.channel_clip_count[ch] < MAX_CHANNEL_CLIPS) {
      s.channel_clip_ids[ch][s.channel_clip_count[ch]++] = resolume_get_clip_id(i);
    }
    if (s.channel_clip_count[ch] == 1) {
      resolume_get_clip_name(i, s.channel_names[ch], 64);
      s.channel_connected[ch] = resolume_get_clip_connected(i);
      s.channel_thumb_tex[ch] = resolume_load_thumbnail(i);
    }
  }
}

static void on_param_change(State& s, int index, double value) {
  int pressed = (value >= 0.5);

  if (index >= PID_TRIGGER_1 && index <= PID_TRIGGER_4) {
    int ch = index - PID_TRIGGER_1;
    int was = s.trigger_held[ch];
    s.trigger_held[ch] = pressed;

    if (pressed && !was) {
      /* Rising edge — open a note (records onset + starts measuring the hold) */
      if (s.delete_held) {
        looper_clear_channel(&s.looper, ch);
        s.delete_acted = 1;
        s.last_action_was_clear = 0;
        log_structured(LOG_INFO, "Clear channel", json_ch_step(ch + 1, -1));
      } else if (s.mute_held) {
        /* Muted press: silence only, no recording. */
      } else {
        int step = (int)s.phase % NUM_STEPS;
        s.last_action_was_clear = 0;
        looper_begin_note(&s.looper, ch, s.phase);
        log_structured(LOG_INFO, "Note on", json_ch_step(ch + 1, step));
      }
    } else if (!pressed && was) {
      /* Falling edge — finalize the note's gate length from the hold duration */
      looper_end_note(&s.looper, ch, s.phase);
    }
  } else if (index == PID_DELETE) {
    if (pressed) {
      s.delete_held = 1;
      s.delete_acted = 0;
    } else if (s.delete_held) {
      /* Release: if no trigger was pressed during hold, do clear or undo */
      if (!s.delete_acted) {
        if (s.last_action_was_clear && s.looper.undo_count > 0) {
          /* Double-tap delete = undo */
          looper_undo(&s.looper);
          s.last_action_was_clear = 0;
          log_msg(LOG_INFO, "Undo (double-tap delete)");
        } else {
          looper_clear_all(&s.looper);
          s.last_action_was_clear = 1;
          log_msg(LOG_INFO, "Clear all");
        }
      }
      s.delete_held = 0;
    }
  } else if (index == PID_MUTE) {
    s.mute_held = pressed;
  } else if (index == PID_UNDO) {
    if (pressed) {
      looper_undo(&s.looper);
      s.last_action_was_clear = 0;
      log_msg(LOG_INFO, "Undo");
    }
  } else if (index == PID_REDO) {
    if (pressed) {
      looper_redo(&s.looper);
      s.last_action_was_clear = 0;
      log_msg(LOG_INFO, "Redo");
    }
  } else if (index == PID_RECORD) {
    if (pressed && !s.record_held) {
      s.last_action_was_clear = 0;
      looper_begin_destructive_record(&s.looper);
      log_msg(LOG_WARN, "Record mode ON");
    } else if (!pressed && s.record_held) {
      looper_end_destructive_record(&s.looper);
      log_msg(LOG_INFO, "Record mode OFF");
    }
    s.record_held = pressed;
  } else if (index == PID_SHOW_OVERLAY) {
    s.show_overlay = pressed;
  } else if (index == PID_SEND_TO_RAIL) {
    s.send_to_rail = pressed;
  } else if (index == PID_QUANTIZE_START) {
    s.quantize_start = pressed;
    looper_set_quantize(&s.looper, s.quantize_start, s.quantize_length);
  } else if (index == PID_QUANTIZE_LENGTH) {
    s.quantize_length = pressed;
    looper_set_quantize(&s.looper, s.quantize_start, s.quantize_length);
  }

  /* One authority for gate emission — reflect the new input state immediately. */
  recompute_gates(s);
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

static void load_grid_from_state(State& s) {
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
  s.looper.event_count = 0;
  s.looper.undo_count = 0;
  s.looper.redo_count = 0;

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
      if (step >= 0 && step < NUM_STEPS && s.looper.event_count < MAX_EVENTS) {
        /* The persisted grid only carries onsets; restore each as a one-step
         * gate. Live-recorded gate lengths have full fidelity — this is the
         * lossy reload path (host save/restore of the onset grid only). */
        s.looper.events[s.looper.event_count].start = (double)step;
        s.looper.events[s.looper.event_count].length = 1.0;
        s.looper.events[s.looper.event_count].channel = ch;
        s.looper.event_count++;
      }
    }
  }

  for (int ch = 0; ch < NUM_CHANNELS; ch++) s.looper.pending_index[ch] = -1;
  log_msg(LOG_INFO, "Grid loaded from state");
}

static int field_to_pid(const char* path, int pathLen) {
  struct { const char* name; int pid; } map[] = {
    {"trigger_1", PID_TRIGGER_1}, {"trigger_2", PID_TRIGGER_2},
    {"trigger_3", PID_TRIGGER_3}, {"trigger_4", PID_TRIGGER_4},
    {"delete", PID_DELETE}, {"mute", PID_MUTE},
    {"undo", PID_UNDO}, {"redo", PID_REDO},
    {"record", PID_RECORD}, {"show_overlay", PID_SHOW_OVERLAY},
    {"send_to_rail", PID_SEND_TO_RAIL},
    {"quantize_start", PID_QUANTIZE_START},
    {"quantize_length", PID_QUANTIZE_LENGTH},
  };
  for (auto& m : map) {
    int mlen = std::strlen(m.name);
    if (pathLen == mlen && std::memcmp(path, m.name, mlen) == 0) return m.pid;
  }
  return -1;
}

/* ======================================================================
 * Exports (v2 instance ABI)
 * ====================================================================== */

/* Type-level setup: schema registration. Runs once per type. No GPU work. */
void module_init() {
  /* Register plugin with schema */
  static const char id[] = "control.nanolooper";
  // io 5 = PrimaryInput, 6 = PrimaryOutput. The 4 per-channel `out_N` fields are
  // modulation outputs (0/1 with a short decay), and the module declares
  // trigger_source so the executor drains its "triggers" ring onto the global
  // trigger rail (see sketch_executor drainTriggerRing).
  static const char schema[] =
    "{\"capabilities\":[\"trigger_source\",\"modulation_source\",\"modulation_source_multi\"],"
    "\"fields\":{"
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
    "\"synth_gain\":{\"type\":\"float\",\"default\":0.5,\"min\":0,\"max\":1,\"io\":5,\"order\":11},"
    "\"send_to_rail\":{\"type\":\"bool\",\"default\":true,\"io\":5,\"order\":12},"
    "\"quantize_start\":{\"type\":\"bool\",\"default\":false,\"io\":5,\"order\":13},"
    "\"quantize_length\":{\"type\":\"bool\",\"default\":false,\"io\":5,\"order\":14},"
    "\"out_1\":{\"type\":\"float\",\"default\":0,\"min\":0,\"max\":1,\"io\":6,\"order\":15},"
    "\"out_2\":{\"type\":\"float\",\"default\":0,\"min\":0,\"max\":1,\"io\":6,\"order\":16},"
    "\"out_3\":{\"type\":\"float\",\"default\":0,\"min\":0,\"max\":1,\"io\":6,\"order\":17},"
    "\"out_4\":{\"type\":\"float\",\"default\":0,\"min\":0,\"max\":1,\"io\":6,\"order\":18},"
    // The texture passthrough. Declaring tex_out (PrimaryOutput texture) is what
    // makes the executor treat the looper as a rendering stage — binding a
    // writable output + calling render() — instead of a modulation-source
    // passthrough (which skips render() entirely). It still drains triggers and
    // publishes out_N in the render branch, so those are unaffected.
    "\"tex_in\":{\"type\":\"texture\",\"io\":5,\"order\":19},"
    "\"tex_out\":{\"type\":\"texture\",\"io\":6,\"order\":20}"
    "}}";
  state_set_schema(id, sizeof(id) - 1, (1 << 16), schema, sizeof(schema) - 1);

  /* Compile the overlay toolbox's solid-quad shader up front (idempotent; also
   * retried lazily on first render if no GPU backend exists yet). */
  overlay::initShaders();
}

/* Per-instance construction: allocate State + one-time looper init. */
void* create() {
  auto* s = new State();
  looper_init(&s->looper, (double)NUM_STEPS);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->ov.dispose();
  delete s;
}

/* Per-instance init tail: reset the looper + transport / edge-state /
 * timers and channel mapping, then publish initial state. */
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  looper_init(&s->looper, (double)NUM_STEPS);
  s->phase = 0;
  s->prev_phase = 0;
  s->elapsed = 0;
  s->show_overlay = 1;
  s->ws_connected = 0;

  for (int i = 0; i < NUM_CHANNELS; i++) {
    s->trigger_held[i] = 0;
    s->gate_state[i] = 0;
    s->flash[i] = 0;
    s->channel_clip_count[i] = 0;
    s->channel_names[i][0] = 0;
    s->channel_thumb_tex[i] = -1;
    s->channel_connected[i] = 0;
    s->ch_out[i] = 0;
  }
  s->quantize_start = 0;
  s->quantize_length = 0;
  looper_set_quantize(&s->looper, 0, 0);
  /* send_to_rail keeps its schema default (on) via on_state_patched; reset the
   * ring so a re-init never replays stale events. */
  s->trig_ring_len = 0;
  s->trig_seq = 0;
  s->delete_held = 0;
  s->delete_acted = 0;
  s->last_action_was_clear = 0;
  s->mute_held = 0;
  s->record_held = 0;

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
  publish_state(*s);

  s->initialized = true;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  s->elapsed += dt;

  /* Advance phase from host bar phase */
  double bar = host_get_bar_phase();
  s->prev_phase = s->phase;
  s->phase = bar * NUM_STEPS;

  /* Gate emission is fully driven by recompute_gates: as the phase sweeps
   * through each recorded note's [start, start+length) window, gates turn on at
   * the onset and off exactly when the recorded gate length elapses. Wrap-safe
   * and frame-rate independent — no per-frame edge scan or fixed timer. */
  recompute_gates(*s);

  /* Decay overlay flash + the modulation-output pulse. While a gate is held the
   * output pins at 1; on release it decays with a ~120ms tail (matches
   * mod.trigger.beat's feel). */
  for (int ch = 0; ch < NUM_CHANNELS; ch++) {
    if (s->flash[ch] > 0)
      s->flash[ch] -= (float)dt;
    if (s->gate_state[ch]) {
      s->ch_out[ch] = 1.0f;
    } else if (s->ch_out[ch] > 0.0f) {
      s->ch_out[ch] *= (float)std::exp(-dt / 0.12);
      if (s->ch_out[ch] < 0.001f) s->ch_out[ch] = 0.0f;
    }
  }

  publish_state(*s);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  bool grid_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    int pid = field_to_pid(pb + off[i], len[i]);
    if (pid >= 0) {
      on_param_change(*s, pid, state::patchFloat(i));
    } else if (state::pathIs(pb + off[i], len[i], "grid")) {
      grid_changed = true;
    }
  }
  if (grid_changed) load_grid_from_state(*s);
}


/* Draw one recorded note as a continuous bar on a lane's timeline. start/length
 * are in loop units [0, NUM_STEPS); the bar may wrap the loop seam, so it's
 * drawn as up to two segments. A bright leading edge marks the true onset. */
static void draw_note_bar(overlay::Canvas& ov, const Event& e,
                          float track_x, float track_w, float bar_y, float bar_h,
                          float cr, float cg, float cb,
                          bool muted, bool playing, float scale) {
  const double loop = (double)NUM_STEPS;
  double s0 = e.start;
  if (s0 < 0) s0 = 0; else if (s0 >= loop) s0 -= loop;
  double rem = e.length;
  if (rem > loop) rem = loop;

  const float body_a = muted ? 0.30f : (playing ? 0.95f : 0.72f);
  const float edge_a = muted ? 0.45f : 1.0f;
  const float bf = playing ? 0.85f : 0.55f;   // body brightness

  bool first = true;
  while (rem > 1e-4) {
    double seg = rem;
    if (s0 + seg > loop) seg = loop - s0;      // clip at the seam → wrap

    float x = track_x + (float)(s0 / loop) * track_w;
    float w = (float)(seg / loop) * track_w;
    if (w < 2.0f * scale) w = 2.0f * scale;

    ov.fillRect(x, bar_y, w, bar_h,
                overlay::rgba(cr * bf, cg * bf, cb * bf, body_a));
    if (first)   // onset marker (only on the leading segment)
      ov.fillRect(x, bar_y, 3.5f * scale, bar_h, overlay::rgba(cr, cg, cb, edge_a));

    rem -= seg;
    s0 += seg;
    if (s0 >= loop) s0 -= loop;
    first = false;
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  /* The looper now owns its output texture (tex_out), so it must always write
   * it — even when the overlay is hidden, forward the input so downstream sees
   * the image (this replaces the executor's old alias-passthrough). */
  if (!s->show_overlay || vp_w <= 0 || vp_h <= 0) {
    int out = gpu::Device::textureForField("tex_out").id;
    if (out >= 0) {
      int in = gpu::Device::textureForField("tex_in").id;
      if (in >= 0) gpu::Device::copy(gpu::Texture{in}, gpu::Texture{out});
      else         gpu::Device::clear(gpu::Texture{out}, 0, 0, 0, 0);
      gpu::Device::submit();
    }
    return;
  }

  overlay::Canvas& ov = s->ov;
  ov.begin(vp_w, vp_h);

  /* Base design at 1080p, scaled proportionally. */
  const float scale = (float)vp_h / 1080.0f;
  const float margin = 28.0f * scale;
  const float title_sz = 30.0f * scale;
  const float label_sz = 22.0f * scale;
  const float small_sz = 17.0f * scale;

  const float lane_h = 46.0f * scale;
  const float lane_gap = 10.0f * scale;
  const float number_x = margin + 6.0f * scale;
  const float name_x = margin + 34.0f * scale;
  const float track_x = margin + 210.0f * scale;
  float track_w = (float)vp_w - track_x - margin;
  if (track_w < 60.0f * scale) track_w = 60.0f * scale;

  const float top = margin;
  const float lanes_top = top + title_sz + 20.0f * scale;
  const float lanes_h = NUM_CHANNELS * (lane_h + lane_gap) - lane_gap;
  const float panel_h = (lanes_top - top) + lanes_h + 52.0f * scale;

  /* --- Panel background (first rect → behind everything else) --- */
  ov.fillRect(margin * 0.5f, top - 14.0f * scale, (float)vp_w - margin, panel_h,
              overlay::rgba(0.04f, 0.05f, 0.07f, 0.72f));

  /* --- Title + REC --- */
  ov.text("LOOPER", margin, top, title_sz, overlay::rgba(0.90f, 0.92f, 0.95f, 0.95f), 800);
  if (s->record_held)
    ov.text("\xe2\x97\x8f REC", margin + title_sz * 5.6f, top + 4.0f * scale, label_sz,
            overlay::rgba(1.0f, 0.28f, 0.28f, 1.0f), 700);

  /* --- Connection status (top-right, pulsing dot) --- */
  {
    float t = (float)s->elapsed;
    float pulse = 0.35f + 0.65f * (0.5f + 0.5f * sinf(t * 6.0f));
    float dot = 12.0f * scale;
    float cx = (float)vp_w - margin - 168.0f * scale;
    ov.fillRect(cx, top + 5.0f * scale, dot, dot, overlay::rgba(0.30f, 0.55f, 1.0f, pulse));
    ov.text("connecting", cx + dot + 8.0f * scale, top + 1.0f * scale, small_sz,
            overlay::rgba(0.60f, 0.72f, 1.0f, 0.80f));
  }

  /* --- Beat gridlines behind the lanes (4 beats / bar) --- */
  for (int beat = 0; beat <= 4; beat++) {
    float gx = track_x + (beat / 4.0f) * track_w;
    float a = (beat % 4 == 0) ? 0.34f : 0.15f;
    ov.fillRect(gx, lanes_top, 1.5f * scale, lanes_h, overlay::rgba(0.60f, 0.66f, 0.78f, a));
  }

  /* --- Lanes: continuous note bars per channel --- */
  for (int ch = 0; ch < NUM_CHANNELS; ch++) {
    float ly = lanes_top + ch * (lane_h + lane_gap);
    float cr = CH_R[ch], cg = CH_G[ch], cb = CH_B[ch];
    bool muted = s->mute_held && s->trigger_held[ch];
    float dim = muted ? 0.35f : 1.0f;
    bool playing = s->gate_state[ch] != 0;

    /* Lane track background (highlights while the channel is gated). */
    float track_a = playing ? 0.14f : 0.05f;
    ov.fillRect(track_x, ly, track_w, lane_h, overlay::rgba(cr, cg, cb, track_a));

    /* Channel number + optional clip name. */
    char num[2] = { char('1' + ch), 0 };
    ov.text(num, number_x, ly + lane_h * 0.5f - label_sz * 0.55f, label_sz,
            overlay::rgba(cr * dim, cg * dim, cb * dim, 1.0f), 700);
    if (s->channel_names[ch][0])
      ov.text(s->channel_names[ch], name_x, ly + lane_h * 0.5f - small_sz * 0.55f,
              small_sz, overlay::rgba(0.70f, 0.72f, 0.76f, 0.80f));

    /* Note bars (unquantized: positioned/sized by real onset + gate length). */
    float bar_pad = 6.0f * scale;
    for (int i = 0; i < s->looper.event_count; i++) {
      const Event& e = s->looper.events[i];
      if (e.channel != ch) continue;
      draw_note_bar(ov, e, track_x, track_w, ly + bar_pad, lane_h - 2.0f * bar_pad,
                    cr, cg, cb, muted, playing, scale);
    }
  }

  /* --- Playhead: continuous position across all lanes --- */
  {
    float ph = (float)s->phase / (float)NUM_STEPS;
    if (ph < 0) ph = 0; else if (ph > 1) ph = 1;
    float px = track_x + ph * track_w;
    ov.fillRect(px - 1.5f * scale, lanes_top - 4.0f * scale, 3.0f * scale,
                lanes_h + 8.0f * scale, overlay::rgba(1.0f, 1.0f, 1.0f, 0.88f));
  }

  /* --- Trigger flashes + modifier state (bottom row) --- */
  float row_y = lanes_top + lanes_h + 16.0f * scale;
  for (int i = 0; i < NUM_CHANNELS; i++) {
    float x = margin + i * 44.0f * scale;
    float a = s->flash[i] > 0 ? 1.0f : 0.28f;
    ov.fillRect(x, row_y, 16.0f * scale, 16.0f * scale,
                overlay::rgba(CH_R[i], CH_G[i], CH_B[i], a));
  }
  float mod_x = margin + NUM_CHANNELS * 44.0f * scale + 16.0f * scale;
  ov.text("DEL", mod_x, row_y - 2.0f * scale, small_sz,
          overlay::rgba(1.0f, 0.30f, 0.30f, s->delete_held ? 1.0f : 0.30f), 700);
  ov.text("MUTE", mod_x + 56.0f * scale, row_y - 2.0f * scale, small_sz,
          overlay::rgba(1.0f, 0.85f, 0.30f, s->mute_held ? 1.0f : 0.30f), 700);
  ov.text("Q.start", mod_x + 140.0f * scale, row_y - 2.0f * scale, small_sz,
          overlay::rgba(0.55f, 0.80f, 1.0f, s->quantize_start ? 1.0f : 0.32f), 700);
  ov.text("Q.len", mod_x + 232.0f * scale, row_y - 2.0f * scale, small_sz,
          overlay::rgba(0.55f, 0.80f, 1.0f, s->quantize_length ? 1.0f : 0.32f), 700);

  ov.end();
}

} // namespace nanolooper
