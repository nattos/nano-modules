/*
 * Spinning Triangles — GPU compute + render demo.
 *
 * Uses a compute shader to generate vertex positions for N spinning triangles,
 * then rasterizes them with a vertex + fragment shader.
 */

#define sinf(x) __builtin_sinf(x)
#define cosf(x) __builtin_cosf(x)
#define fmodf(x, y) __builtin_fmodf(x, y)

/* ======================================================================
 * Host imports
 * ====================================================================== */

/* state */
__attribute__((import_module("state"), import_name("set_metadata")))
extern void state_set_metadata(const char* id, int id_len, int version_packed);
__attribute__((import_module("state"), import_name("declare_param")))
extern void state_declare_param(int index, const char* name, int name_len, int type, float default_value);
__attribute__((import_module("state"), import_name("get_key")))
extern int state_get_key(char* buf, int buf_len);
__attribute__((import_module("state"), import_name("console_log")))
extern void state_console_log(int level, const char* msg, int msg_len);

/* gpu */
__attribute__((import_module("gpu"), import_name("get_backend")))
extern int gpu_get_backend(void);
__attribute__((import_module("gpu"), import_name("create_shader_module")))
extern int gpu_create_shader_module(const char* src, int src_len);
__attribute__((import_module("gpu"), import_name("create_buffer")))
extern int gpu_create_buffer(int size, int usage);
__attribute__((import_module("gpu"), import_name("create_compute_pso")))
extern int gpu_create_compute_pso(int shader, const char* entry, int entry_len);
__attribute__((import_module("gpu"), import_name("create_render_pso")))
extern int gpu_create_render_pso(int vs_shader, const char* vs, int vs_len,
                                  int fs_shader, const char* fs, int fs_len, int format);
__attribute__((import_module("gpu"), import_name("write_buffer")))
extern void gpu_write_buffer(int buf, int offset, const void* data, int data_len);
__attribute__((import_module("gpu"), import_name("begin_compute_pass")))
extern int gpu_begin_compute_pass(void);
__attribute__((import_module("gpu"), import_name("compute_set_pso")))
extern void gpu_compute_set_pso(int pass, int pipeline);
__attribute__((import_module("gpu"), import_name("compute_set_buffer")))
extern void gpu_compute_set_buffer(int pass, int buf, int offset, int slot);
__attribute__((import_module("gpu"), import_name("compute_dispatch")))
extern void gpu_compute_dispatch(int pass, int x, int y, int z);
__attribute__((import_module("gpu"), import_name("end_compute_pass")))
extern void gpu_end_compute_pass(int pass);
__attribute__((import_module("gpu"), import_name("begin_render_pass")))
extern int gpu_begin_render_pass(int texture, float cr, float cg, float cb, float ca);
__attribute__((import_module("gpu"), import_name("render_set_pso")))
extern void gpu_render_set_pso(int pass, int pipeline);
__attribute__((import_module("gpu"), import_name("render_set_vertex_buffer")))
extern void gpu_render_set_vertex_buffer(int pass, int buf, int offset, int slot);
__attribute__((import_module("gpu"), import_name("render_draw")))
extern void gpu_render_draw(int pass, int vertex_count, int instance_count);
__attribute__((import_module("gpu"), import_name("end_render_pass")))
extern void gpu_end_render_pass(int pass);
__attribute__((import_module("gpu"), import_name("submit")))
extern void gpu_submit(void);
__attribute__((import_module("gpu"), import_name("get_render_target")))
extern int gpu_get_render_target(void);
__attribute__((import_module("gpu"), import_name("get_render_target_width")))
extern int gpu_get_render_target_width(void);
__attribute__((import_module("gpu"), import_name("get_render_target_height")))
extern int gpu_get_render_target_height(void);
__attribute__((import_module("gpu"), import_name("release")))
extern void gpu_release(int handle);

/* ======================================================================
 * Shader sources — generated from GLSL → SPIR-V → WGSL pipeline
 * ====================================================================== */

#include "spinningtris_shaders.h"

/* ======================================================================
 * Constants & types
 * ====================================================================== */

#define MAX_TRIANGLES 1000
#define PARAM_TRI_COUNT 0
#define PARAM_SPEED 1
#define PARAM_STANDARD 10

struct TriSeed {
  float px, py, size, rot, r, g, b, spd;
};

struct Vertex {
  float x, y, r, g, b, a;
};

struct Uniforms {
  float time, count, aspect, speed;
};

/* ======================================================================
 * State
 * ====================================================================== */

static float elapsed;
static int tri_count;
static float speed;
static int initialized;

/* GPU handles */
static int h_shader;
static int h_compute_pipe;
static int h_render_pipe;
static int h_uniform_buf;
static int h_seed_buf;
static int h_vertex_buf;

/* Seed data (on CPU for init upload) */
static struct TriSeed seeds[MAX_TRIANGLES];

/* Simple LCG PRNG */
static unsigned int rng_state = 12345;
static float randf(void) {
  rng_state = rng_state * 1103515245 + 12345;
  return (float)(rng_state >> 16 & 0x7FFF) / 32767.0f;
}

/* ======================================================================
 * Helpers
 * ====================================================================== */

static int str_len(const char* s) { int n = 0; while (s[n]) n++; return n; }
static void log_msg(int level, const char* msg) { state_console_log(level, msg, str_len(msg)); }
static void decl_param(int index, const char* name, int type, float def) {
  state_declare_param(index, name, str_len(name), type, def);
}

/* ======================================================================
 * Exports
 * ====================================================================== */

__attribute__((export_name("init")))
void init(void) {
  elapsed = 0;
  tri_count = 100;
  speed = 1.0f;
  initialized = 0;

  static const char id[] = "com.nattos.spinningtris";
  state_set_metadata(id, sizeof(id) - 1, (1 << 16) | (0 << 8) | 0);
  decl_param(PARAM_TRI_COUNT, "Triangles", PARAM_STANDARD, 0.1f);
  decl_param(PARAM_SPEED, "Speed", PARAM_STANDARD, 0.5f);

  log_msg(0, "SpinningTris: init");

  /* Generate random seed data */
  for (int i = 0; i < MAX_TRIANGLES; i++) {
    seeds[i].px = randf() * 2.0f - 1.0f;
    seeds[i].py = randf() * 2.0f - 1.0f;
    seeds[i].size = 0.02f + randf() * 0.13f;
    seeds[i].rot = randf() * 6.28318f;
    seeds[i].r = 0.3f + randf() * 0.7f;
    seeds[i].g = 0.3f + randf() * 0.7f;
    seeds[i].b = 0.3f + randf() * 0.7f;
    seeds[i].spd = 0.5f + randf() * 2.0f;
  }

  /* Create GPU resources */
  int backend = gpu_get_backend();
  if (backend < 0) {
    log_msg(2, "SpinningTris: no GPU backend");
    return;
  }

  /* Compile shaders from generated WGSL (originally authored in GLSL,
   * compiled via GLSL → SPIR-V → WGSL pipeline at build time) */
  int h_compute_shader = gpu_create_shader_module(COMPUTE_WGSL, str_len(COMPUTE_WGSL));
  if (h_compute_shader < 0) {
    log_msg(2, "SpinningTris: compute shader compile failed");
    return;
  }

  /* Vertex + fragment are combined into one shader module since naga
   * generates compatible WGSL for both stages */
  int h_render_shader = gpu_create_shader_module(VERTEX_WGSL, str_len(VERTEX_WGSL));
  if (h_render_shader < 0) {
    log_msg(2, "SpinningTris: render shader compile failed");
    return;
  }

  int h_frag_shader = gpu_create_shader_module(FRAGMENT_WGSL, str_len(FRAGMENT_WGSL));
  if (h_frag_shader < 0) {
    log_msg(2, "SpinningTris: fragment shader compile failed");
    return;
  }

  /* Pipelines */
  {
    static const char entry[] = "main";
    h_compute_pipe = gpu_create_compute_pso(h_compute_shader, entry, sizeof(entry) - 1);
  }
  {
    static const char vs[] = "main";
    static const char fs[] = "main";
    h_render_pipe = gpu_create_render_pso(
        h_render_shader, vs, sizeof(vs) - 1,
        h_frag_shader, fs, sizeof(fs) - 1, 2);
  }

  /* Buffers */
  h_uniform_buf = gpu_create_buffer(sizeof(struct Uniforms), 2); /* uniform */
  h_seed_buf = gpu_create_buffer(MAX_TRIANGLES * sizeof(struct TriSeed), 1); /* storage */
  h_vertex_buf = gpu_create_buffer(MAX_TRIANGLES * 3 * sizeof(struct Vertex), 1); /* storage */

  /* Upload seeds */
  gpu_write_buffer(h_seed_buf, 0, seeds, MAX_TRIANGLES * sizeof(struct TriSeed));

  initialized = 1;
  log_msg(0, "SpinningTris: GPU initialized");
}

__attribute__((export_name("tick")))
void tick(double dt) {
  elapsed += (float)dt;
}

__attribute__((export_name("on_param_change")))
void on_param_change(int index, double value) {
  if (index == PARAM_TRI_COUNT) {
    tri_count = 1 + (int)(value * 999.0);
    if (tri_count > MAX_TRIANGLES) tri_count = MAX_TRIANGLES;
    if (tri_count < 1) tri_count = 1;
  } else if (index == PARAM_SPEED) {
    speed = (float)value * 4.0f;
  }
}

__attribute__((export_name("on_state_changed")))
void on_state_changed(void) { }

__attribute__((export_name("render")))
void render(int vp_w, int vp_h) {
  if (!initialized) return;

  /* Update uniform */
  float aspect = (vp_w > 0 && vp_h > 0) ? (float)vp_w / (float)vp_h : 1.0f;
  struct Uniforms u = { elapsed, (float)tri_count, aspect, speed };
  gpu_write_buffer(h_uniform_buf, 0, &u, sizeof(u));

  /* Compute pass: generate vertices */
  int cp = gpu_begin_compute_pass();
  gpu_compute_set_pso(cp, h_compute_pipe);
  gpu_compute_set_buffer(cp, h_uniform_buf, 0, 0);
  gpu_compute_set_buffer(cp, h_seed_buf, 0, 1);
  gpu_compute_set_buffer(cp, h_vertex_buf, 0, 2);
  gpu_compute_dispatch(cp, (tri_count + 63) / 64, 1, 1);
  gpu_end_compute_pass(cp);

  /* Render pass: draw triangles */
  int surface = gpu_get_render_target();
  int rp = gpu_begin_render_pass(surface, 0.05f, 0.05f, 0.08f, 1.0f);
  gpu_render_set_pso(rp, h_render_pipe);
  gpu_render_set_vertex_buffer(rp, h_vertex_buf, 0, 0);
  gpu_render_draw(rp, tri_count * 3, 1);
  gpu_end_render_pass(rp);

  gpu_submit();
}
