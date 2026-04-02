/*
 * Parameter Linker WASM Module
 *
 * Links two Resolume parameters together. Uses a "learn" mechanism
 * to discover which parameters to link by observing changes.
 */

#define floor(x) __builtin_floor(x)
#define sinf(x) __builtin_sinf(x)
#define fabs(x) __builtin_fabs(x)

/* ======================================================================
 * Host function imports
 * ====================================================================== */

/* canvas module */
__attribute__((import_module("canvas"), import_name("fill_rect")))
extern void canvas_fill_rect(float x, float y, float w, float h,
                              float r, float g, float b, float a);

__attribute__((import_module("canvas"), import_name("draw_text")))
extern void canvas_draw_text(const char* text, int len,
                              float x, float y, float size,
                              float r, float g, float b, float a);

/* host module */
__attribute__((import_module("host"), import_name("get_time")))
extern double host_get_time(void);

__attribute__((import_module("host"), import_name("get_delta_time")))
extern double host_get_delta_time(void);

__attribute__((import_module("host"), import_name("get_viewport_w")))
extern int host_get_viewport_w(void);

__attribute__((import_module("host"), import_name("get_viewport_h")))
extern int host_get_viewport_h(void);

/* resolume module */
__attribute__((import_module("resolume"), import_name("get_param")))
extern double resolume_get_param(long long param_id);

__attribute__((import_module("resolume"), import_name("set_param")))
extern void resolume_set_param(long long param_id, double value);

__attribute__((import_module("resolume"), import_name("subscribe_query")))
extern void resolume_subscribe_query(const char* query, int query_len);

__attribute__((import_module("resolume"), import_name("get_param_path")))
extern int resolume_get_param_path(long long param_id, char* buf, int buf_len);

/* state module */
__attribute__((import_module("state"), import_name("set_metadata")))
extern void state_set_metadata(const char* id, int id_len, int version_packed);

__attribute__((import_module("state"), import_name("declare_param")))
extern void state_declare_param(int index, const char* name, int name_len, int type, float default_value);

__attribute__((import_module("state"), import_name("get_key")))
extern int state_get_key(char* buf, int buf_len);

__attribute__((import_module("state"), import_name("console_log")))
extern void state_console_log(int level, const char* msg, int msg_len);

__attribute__((import_module("state"), import_name("console_log_structured")))
extern void state_console_log_structured(int level, const char* msg, int msg_len,
                                          const char* json, int json_len);

__attribute__((import_module("state"), import_name("set")))
extern void state_set(const char* path, int path_len, const char* json, int json_len);

__attribute__((import_module("state"), import_name("read")))
extern int state_read(const char* layout, int field_count, const char* paths,
                      char* output, int output_size, char* results);

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

static SeenParam seen[MAX_SEEN];
static int seen_count;
static int next_order;

static int learning;
static double learn_elapsed;   /* time since learn started */
static int settled;            /* 1 after settle period */

static long long input_id;
static long long output_id;
static char input_path[64];
static int input_path_len;
static char output_path[64];
static int output_path_len;
static double input_value;
static double output_value;

static int active;
static double elapsed;

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

static void log_msg(int level, const char* msg) {
  state_console_log(level, msg, str_len(msg));
}

static void decl_param(int index, const char* name, int type, float def) {
  state_declare_param(index, name, str_len(name), type, def);
}

/* Find a seen param by ID, returns index or -1 */
static int find_seen(long long param_id) {
  for (int i = 0; i < seen_count; i++) {
    if (seen[i].param_id == param_id) return i;
  }
  return -1;
}

/* Get the two most recent non-ignored params (for input/output assignment) */
static void get_top_two(int* first, int* second) {
  *first = -1;
  *second = -1;
  int best_order = -1;
  int second_order = -1;

  for (int i = 0; i < seen_count; i++) {
    if (seen[i].ignored) continue;
    if (seen[i].order > best_order) {
      *second = *first;
      second_order = best_order;
      *first = i;
      best_order = seen[i].order;
    } else if (seen[i].order > second_order) {
      *second = i;
      second_order = seen[i].order;
    }
  }
}

/* ======================================================================
 * Exports
 * ====================================================================== */

__attribute__((export_name("init")))
void init(void) {
  seen_count = 0;
  next_order = 0;
  learning = 0;
  learn_elapsed = 0;
  settled = 0;
  input_id = -1;
  output_id = -1;
  input_path_len = 0;
  output_path_len = 0;
  input_value = 0;
  output_value = 0;
  active = 1;
  elapsed = 0;

  static const char id[] = "com.nattos.paramlinker";
  state_set_metadata(id, sizeof(id) - 1, (1 << 16) | (0 << 8) | 0);

  decl_param(PID_LEARN,  "Learn",  PARAM_BOOLEAN, 0.0f);
  decl_param(PID_ACTIVE, "Active", PARAM_BOOLEAN, 1.0f);

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
}

__attribute__((export_name("tick")))
void tick(double dt) {
  elapsed += dt;

  if (learning) {
    learn_elapsed += dt;

    /* After settle time, mark all currently seen params as ignored */
    if (!settled && learn_elapsed >= SETTLE_TIME) {
      settled = 1;
      for (int i = 0; i < seen_count; i++) {
        seen[i].ignored = 1;
      }
      log_msg(LOG_INFO, "Settle complete, automation marked");
    }
  }

  /* Active linking: forward input to output */
  if (active && !learning && input_id >= 0 && output_id >= 0) {
    double val = resolume_get_param(input_id);
    if (fabs(val - input_value) > 1e-6) {
      input_value = val;
      output_value = val;
      resolume_set_param(output_id, val);
    }
  }
}

__attribute__((export_name("on_param_change")))
void on_param_change(int index, double value) {
  if (index == PID_LEARN) {
    /* Toggle on rising edge only */
    if (value < 0.5) return;
    int was = learning;
    learning = !was;

    if (learning && !was) {
      /* Learn ON: reset and subscribe */
      seen_count = 0;
      next_order = 0;
      learn_elapsed = 0;
      settled = 0;
      input_id = -1;
      output_id = -1;

      /* Subscribe to all parameters */
      static const char query[] = "/*";
      resolume_subscribe_query(query, sizeof(query) - 1);
      log_msg(LOG_INFO, "Learn started — observing all params");
    }
    else if (!learning && was) {
      /* Learn OFF: assign input/output from last two non-ignored */
      int first, second;
      get_top_two(&first, &second);

      if (first >= 0 && second >= 0) {
        /* Earlier = input, later = output */
        int inp = second;  /* second has lower order = earlier */
        int out = first;   /* first has higher order = later */

        input_id = seen[inp].param_id;
        output_id = seen[out].param_id;
        for (int i = 0; i < seen[inp].path_len; i++) input_path[i] = seen[inp].path[i];
        input_path_len = seen[inp].path_len;
        input_path[input_path_len] = 0;
        for (int i = 0; i < seen[out].path_len; i++) output_path[i] = seen[out].path[i];
        output_path_len = seen[out].path_len;
        output_path[output_path_len] = 0;

        input_value = resolume_get_param(input_id);
        output_value = input_value;

        log_msg(LOG_INFO, "Learn complete");
      } else {
        log_msg(LOG_WARN, "Learn: not enough params detected");
      }
    }
  }
  else if (index == PID_ACTIVE) {
    if (value < 0.5) return;
    active = !active;
  }
}

__attribute__((export_name("on_resolume_param")))
void on_resolume_param(long long param_id, double value) {
  if (!learning) return;

  int idx = find_seen(param_id);
  if (idx >= 0) {
    /* Already seen — update value */
    seen[idx].last_value = value;
    return;
  }

  /* New parameter */
  if (seen_count >= MAX_SEEN) return;

  SeenParam* sp = &seen[seen_count++];
  sp->param_id = param_id;
  sp->last_value = value;
  sp->ignored = settled ? 0 : 1; /* if not yet settled, mark as ignored immediately */
  sp->order = next_order++;
  sp->path_len = resolume_get_param_path(param_id, sp->path, sizeof(sp->path) - 1);
  sp->path[sp->path_len] = 0;
}

__attribute__((export_name("on_state_changed")))
void on_state_changed(void) {
  /* No external state editing for now */
}

__attribute__((export_name("render")))
void render(int vp_w, int vp_h) {
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
  if (learning) {
    float lx = margin + gw * 13;
    float pulse = 0.5f + 0.5f * sinf((float)elapsed * 6.0f);
    text("LEARN", lx, y, font_size, 1.0f, 0.4f, 0.2f, pulse);
  }
  y += lh + row_gap;

  /* Input/Output assignment */
  if (input_id >= 0 && output_id >= 0 && !learning) {
    text("IN:", margin, y, small_font, 0.3f, 0.8f, 1.0f, 0.9f);
    text(input_path, margin + gw * 4, y, small_font, 0.7f, 0.7f, 0.7f, 0.8f);
    y += lh;

    text("OUT:", margin, y, small_font, 1.0f, 0.6f, 0.2f, 0.9f);
    text(output_path, margin + gw * 4, y, small_font, 0.7f, 0.7f, 0.7f, 0.8f);
    y += lh;

    /* Show active/inactive status */
    if (active) {
      text("Active", margin, y, small_font, 0.2f, 0.9f, 0.2f, 0.7f);
    } else {
      text("Inactive", margin, y, small_font, 0.9f, 0.3f, 0.3f, 0.5f);
    }
    y += lh + row_gap;
  }

  /* During learn: show seen parameters list */
  if (learning && seen_count > 0) {
    text("Seen parameters:", margin, y, small_font, 0.6f, 0.6f, 0.6f, 0.7f);
    y += lh;

    /* Find top two candidates */
    int top1, top2;
    get_top_two(&top1, &top2);

    /* Display newest first (highest order at top) */
    /* Simple approach: scan by descending order */
    int max_display = 20;
    int displayed = 0;

    for (int ord = next_order - 1; ord >= 0 && displayed < max_display; ord--) {
      for (int i = 0; i < seen_count; i++) {
        if (seen[i].order != ord) continue;

        float r, g, b, a;
        if (i == top1) {
          /* Latest candidate = output (orange) */
          r = 1.0f; g = 0.6f; b = 0.2f; a = 1.0f;
        } else if (i == top2) {
          /* Earlier candidate = input (cyan) */
          r = 0.3f; g = 0.8f; b = 1.0f; a = 1.0f;
        } else if (seen[i].ignored) {
          /* Ignored/automation (dim gray) */
          r = 0.4f; g = 0.4f; b = 0.4f; a = 0.4f;
        } else {
          /* Normal (white) */
          r = 0.7f; g = 0.7f; b = 0.7f; a = 0.7f;
        }

        /* Draw indicator bar */
        float bar_w = 4.0f * scale;
        canvas_fill_rect(margin, y + 2*scale, bar_w, lh - 4*scale, r, g, b, a);

        /* Draw path text */
        text(seen[i].path, margin + bar_w + gw * 0.5f, y, small_font, r, g, b, a);

        y += lh * 0.85f;
        displayed++;
        break;
      }
    }
  }

  /* When not learning and nothing assigned */
  if (!learning && input_id < 0) {
    text("No link configured", margin, y, small_font, 0.5f, 0.5f, 0.5f, 0.5f);
    text("Press Learn to start", margin, y + lh, small_font, 0.4f, 0.4f, 0.4f, 0.4f);
  }
}
