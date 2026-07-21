/*
 * Parameter Linker WASM Module
 *
 * Links two Resolume parameters together. Uses a "learn" mechanism
 * to discover which parameters to link by observing changes.
 *
 * Class-like instance model: module_init() publishes the schema once per
 * type; each chain entry gets its own State via create(). All instance
 * callbacks take `self`. This is a data/tap effect — no GPU, no PSO.
 */

#include <host.h>
#include <val.h>
#include "../../src/json/json_doc_client.h"

#include <cmath>
#include <cstring>

namespace paramlinker {

/* ======================================================================
 * Constants
 * ====================================================================== */

#define MAX_SEEN 256
#define SETTLE_TIME 1.0  /* seconds before marking automation */

#define PID_LEARN  0
#define PID_ACTIVE 1

#define PARAM_BOOLEAN  0
#define PARAM_STANDARD 10

#define LOG_INFO  0
#define LOG_WARN  1

/* ======================================================================
 * State
 * ====================================================================== */

typedef struct {
  long long param_id;
  double last_value;
  int ignored;         /* marked as automation noise */
  int order;           /* first-seen order (higher = newer) */
  char path[64];
  int path_len;
} SeenParam;

// Per-instance state. One per chain entry.
struct State {
  SeenParam seen[MAX_SEEN];
  int seen_count;
  int next_order;

  int learning;
  double learn_elapsed;   /* time since learn started */
  int settled;            /* 1 after settle period */

  long long input_id;
  long long output_id;
  char input_path[64];
  int input_path_len;
  char output_path[64];
  int output_path_len;
  double input_value;
  double output_value;

  int active;
  double elapsed;
};

/* ======================================================================
 * Helpers
 * ====================================================================== */

static int str_len(const char* s) {
  int n = 0;
  while (s[n]) n++;
  return n;
}

// HUD stubs. The host-side canvas_* ABI is gone (it was already a no-op on
// every render path); the learn-state HUD below needs a port to the
// overlay.h primitives (instanced quads + rich-text labels) to become
// visible again. The render() logic is kept so the port is a drop-in.
static void text(const char* s, float x, float y, float size,
                 float r, float g, float b, float a) {
  (void)s; (void)x; (void)y; (void)size; (void)r; (void)g; (void)b; (void)a;
}
static void rect(float x, float y, float w, float h,
                 float r, float g, float b, float a) {
  (void)x; (void)y; (void)w; (void)h; (void)r; (void)g; (void)b; (void)a;
}

static void log_msg(int level, const char* msg) {
  state_console_log(level, msg, str_len(msg));
}

// Removed: decl_param — using schema-based declaration now

/* Find a seen param by ID, returns index or -1 */
static int find_seen(State& s, long long param_id) {
  for (int i = 0; i < s.seen_count; i++) {
    if (s.seen[i].param_id == param_id) return i;
  }
  return -1;
}

/* Get the two most recent non-ignored params (for input/output assignment) */
static void get_top_two(State& s, int* first, int* second) {
  *first = -1;
  *second = -1;
  int best_order = -1;
  int second_order = -1;

  for (int i = 0; i < s.seen_count; i++) {
    if (s.seen[i].ignored) continue;
    if (s.seen[i].order > best_order) {
      *second = *first;
      second_order = best_order;
      *first = i;
      best_order = s.seen[i].order;
    } else if (s.seen[i].order > second_order) {
      *second = i;
      second_order = s.seen[i].order;
    }
  }
}

/* Publish full state via val handles */
static void publish_state(State& s) {
  auto state = val::object();
  val::set(state, "learning", val::boolean(s.learning != 0));
  val::set(state, "settled", val::boolean(s.settled != 0));
  val::set(state, "active", val::boolean(s.active != 0));
  val::set(state, "input_id", val::number(static_cast<double>(s.input_id)));
  val::set(state, "output_id", val::number(static_cast<double>(s.output_id)));
  val::set(state, "input_path", val::string(s.input_path, s.input_path_len));
  val::set(state, "output_path", val::string(s.output_path, s.output_path_len));

  auto seen_arr = val::array();
  for (int i = 0; i < s.seen_count; i++) {
    auto entry = val::object();
    val::set(entry, "id", val::number(static_cast<double>(s.seen[i].param_id)));
    val::set(entry, "path", val::string(s.seen[i].path, s.seen[i].path_len));
    val::set(entry, "ignored", val::boolean(s.seen[i].ignored != 0));
    val::set(entry, "order", val::number(s.seen[i].order));
    val::push(seen_arr, entry);
  }
  val::set(state, "seen", seen_arr);

  state::setVal(state);
  val::release(state);
}

static void on_param_change(State& s, int index, double value);
static void reload_assignment_from_state(State& s);

/* ======================================================================
 * Exports
 * ====================================================================== */

// Type-level setup: schema registration. Runs once per type. No GPU work.
void module_init() {
  static const char id[] = "control.paramlinker";
  static const char schema[] =
    "{\"fields\":{"
    "\"learn\":{\"type\":\"bool\",\"default\":false,\"io\":5,\"order\":0},"
    "\"active\":{\"type\":\"bool\",\"default\":true,\"io\":5,\"order\":1}"
    "}}";
  state_set_schema(id, sizeof(id) - 1, (1 << 16), schema, sizeof(schema) - 1);
}

// Per-instance construction. No GPU buffers.
void* create() {
  auto* s = new State();
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  delete s;
}

// Per-instance init tail: reset params / link tables / accumulators.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  s->seen_count = 0;
  s->next_order = 0;
  s->learning = 0;
  s->learn_elapsed = 0;
  s->settled = 0;
  s->input_id = -1;
  s->output_id = -1;
  s->input_path_len = 0;
  s->output_path_len = 0;
  s->input_value = 0;
  s->output_value = 0;
  s->active = 1;
  s->elapsed = 0;

  char key_buf[64];
  int key_len = state_get_key(key_buf, sizeof(key_buf) - 1);
  key_buf[key_len] = 0;

  static char init_msg[128];
  int p = 0;
  const char* prefix = "ParamLinker initialized as ";
  while (*prefix) init_msg[p++] = *prefix++;
  for (int i = 0; i < key_len && p < 127; i++) init_msg[p++] = key_buf[i];
  init_msg[p] = 0;
  log_msg(LOG_INFO, init_msg);
  publish_state(*s);
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  s->elapsed += dt;

  if (s->learning) {
    s->learn_elapsed += dt;

    /* After settle time, mark all currently seen params as ignored */
    if (!s->settled && s->learn_elapsed >= SETTLE_TIME) {
      s->settled = 1;
      for (int i = 0; i < s->seen_count; i++) {
        s->seen[i].ignored = 1;
      }
      log_msg(LOG_INFO, "Settle complete, automation marked");
    }
  }

  /* Active linking: forward input to output */
  if (s->active && !s->learning && s->input_id >= 0 && s->output_id >= 0) {
    double val = resolume_get_param(s->input_id);
    if (fabs(val - s->input_value) > 1e-6) {
      s->input_value = val;
      s->output_value = val;
      resolume_set_param(s->output_id, val);
    }
  }

  publish_state(*s);
}

static void on_param_change(State& s, int index, double value) {
  if (index == PID_LEARN) {
    /* Toggle on rising edge only */
    if (value < 0.5) return;
    int was = s.learning;
    s.learning = !was;

    if (s.learning && !was) {
      /* Learn ON: reset and subscribe */
      s.seen_count = 0;
      s.next_order = 0;
      s.learn_elapsed = 0;
      s.settled = 0;
      s.input_id = -1;
      s.output_id = -1;

      /* Subscribe to all parameters */
      static const char query[] = "/*";
      resolume_subscribe_query(query, sizeof(query) - 1);
      log_msg(LOG_INFO, "Learn started — observing all params");
    }
    else if (!s.learning && was) {
      /* Learn OFF: assign input/output from last two non-ignored */
      int first, second;
      get_top_two(s, &first, &second);

      if (first >= 0 && second >= 0) {
        /* Earlier = input, later = output */
        int inp = second;  /* second has lower order = earlier */
        int out = first;   /* first has higher order = later */

        s.input_id = s.seen[inp].param_id;
        s.output_id = s.seen[out].param_id;
        for (int i = 0; i < s.seen[inp].path_len; i++) s.input_path[i] = s.seen[inp].path[i];
        s.input_path_len = s.seen[inp].path_len;
        s.input_path[s.input_path_len] = 0;
        for (int i = 0; i < s.seen[out].path_len; i++) s.output_path[i] = s.seen[out].path[i];
        s.output_path_len = s.seen[out].path_len;
        s.output_path[s.output_path_len] = 0;

        s.input_value = resolume_get_param(s.input_id);
        s.output_value = s.input_value;

        log_msg(LOG_INFO, "Learn complete");
      } else {
        log_msg(LOG_WARN, "Learn: not enough params detected");
      }
    }
  }
  else if (index == PID_ACTIVE) {
    if (value < 0.5) return;
    s.active = !s.active;
  }
}

static void reload_assignment_from_state(State& s) {
  /* Read input_id and output_id from canonical state (may be set by editor) */
  static const char assign_paths[] =
    "/input_id\0"   /* offset 0, len 9 */
    "/output_id\0"; /* offset 10, len 10 */

  struct { double input_id_f; double output_id_f; } abuf;
  JDocField alayout[2] = {
    { 0, 9,  JDOC_TYPE_F64, 0, 0 },
    { 10, 10, JDOC_TYPE_F64, 8, 0 },
  };
  JDocResult aresults[2];

  state_read((const char*)alayout, 2, assign_paths,
             (char*)&abuf, (int)sizeof(abuf), (char*)aresults);

  if (aresults[0].found && aresults[1].found) {
    long long new_input = (long long)abuf.input_id_f;
    long long new_output = (long long)abuf.output_id_f;

    if (new_input != s.input_id || new_output != s.output_id) {
      s.input_id = new_input;
      s.output_id = new_output;

      /* Look up paths */
      if (s.input_id >= 0) {
        s.input_path_len = resolume_get_param_path(s.input_id, s.input_path, sizeof(s.input_path) - 1);
        s.input_path[s.input_path_len] = 0;
        s.input_value = resolume_get_param(s.input_id);
      }
      if (s.output_id >= 0) {
        s.output_path_len = resolume_get_param_path(s.output_id, s.output_path, sizeof(s.output_path) - 1);
        s.output_path[s.output_path_len] = 0;
        s.output_value = resolume_get_param(s.output_id);
      }

      if (s.input_id >= 0 && s.output_id >= 0) {
        log_msg(LOG_INFO, "Assignment updated from editor");
      }
    }
  }
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    float v = state::patchFloat(i);
    if (state::pathIs(pb + off[i], len[i], "learn"))
      on_param_change(*s, PID_LEARN, v);
    else if (state::pathIs(pb + off[i], len[i], "active"))
      on_param_change(*s, PID_ACTIVE, v);
  }
  reload_assignment_from_state(*s);
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  float scale = (float)vp_h / 1080.0f;
  float gw = 24.0f * scale;
  float lh = 28.0f * scale;
  float font_size = 24.0f * scale;
  float small_font = 18.0f * scale;
  float margin = 20.0f * scale;
  float row_gap = 6.0f * scale;

  float y = margin;

  /* Title */
  text("ParamLinker", margin, y, font_size, 0.9f, 0.9f, 0.9f, 0.9f);
  if (s->learning) {
    float lx = margin + gw * 13;
    float pulse = 0.5f + 0.5f * sinf((float)s->elapsed * 6.0f);
    text("LEARN", lx, y, font_size, 1.0f, 0.4f, 0.2f, pulse);
  }
  y += lh + row_gap;

  /* Input/Output assignment */
  if (s->input_id >= 0 && s->output_id >= 0 && !s->learning) {
    text("IN:", margin, y, small_font, 0.3f, 0.8f, 1.0f, 0.9f);
    text(s->input_path, margin + gw * 4, y, small_font, 0.7f, 0.7f, 0.7f, 0.8f);
    y += lh;

    text("OUT:", margin, y, small_font, 1.0f, 0.6f, 0.2f, 0.9f);
    text(s->output_path, margin + gw * 4, y, small_font, 0.7f, 0.7f, 0.7f, 0.8f);
    y += lh;

    /* Show active/inactive status */
    if (s->active) {
      text("Active", margin, y, small_font, 0.2f, 0.9f, 0.2f, 0.7f);
    } else {
      text("Inactive", margin, y, small_font, 0.9f, 0.3f, 0.3f, 0.5f);
    }
    y += lh + row_gap;
  }

  /* During learn: show seen parameters list */
  if (s->learning && s->seen_count > 0) {
    text("Seen parameters:", margin, y, small_font, 0.6f, 0.6f, 0.6f, 0.7f);
    y += lh;

    /* Find top two candidates */
    int top1, top2;
    get_top_two(*s, &top1, &top2);

    /* Display newest first (highest order at top) */
    /* Simple approach: scan by descending order */
    int max_display = 20;
    int displayed = 0;

    for (int ord = s->next_order - 1; ord >= 0 && displayed < max_display; ord--) {
      for (int i = 0; i < s->seen_count; i++) {
        if (s->seen[i].order != ord) continue;

        float r, g, b, a;
        if (i == top1) {
          /* Latest candidate = output (orange) */
          r = 1.0f; g = 0.6f; b = 0.2f; a = 1.0f;
        } else if (i == top2) {
          /* Earlier candidate = input (cyan) */
          r = 0.3f; g = 0.8f; b = 1.0f; a = 1.0f;
        } else if (s->seen[i].ignored) {
          /* Ignored/automation (dim gray) */
          r = 0.4f; g = 0.4f; b = 0.4f; a = 0.4f;
        } else {
          /* Normal (white) */
          r = 0.7f; g = 0.7f; b = 0.7f; a = 0.7f;
        }

        /* Draw indicator bar */
        float bar_w = 4.0f * scale;
        rect(margin, y + 2*scale, bar_w, lh - 4*scale, r, g, b, a);

        /* Draw path text */
        text(s->seen[i].path, margin + bar_w + gw * 0.5f, y, small_font, r, g, b, a);

        y += lh * 0.85f;
        displayed++;
        break;
      }
    }
  }

  /* When not learning and nothing assigned */
  if (!s->learning && s->input_id < 0) {
    text("No link configured", margin, y, small_font, 0.5f, 0.5f, 0.5f, 0.5f);
    text("Press Learn to start", margin, y + lh, small_font, 0.4f, 0.4f, 0.4f, 0.4f);
  }
}

} // namespace paramlinker
