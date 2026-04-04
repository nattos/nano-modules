/*
 * GPU Pipeline Test Module
 *
 * Renders a solid color via compute→render pipeline.
 * Color is set via uniform: (0.0, 0.5, 1.0) = blue-ish.
 * Used for automated pixel-level testing of the full GPU pipeline.
 */

#include "gpu_test_shaders.h"

/* gpu imports */
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
extern void gpu_compute_set_pso(int pass, int pso);
__attribute__((import_module("gpu"), import_name("compute_set_buffer")))
extern void gpu_compute_set_buffer(int pass, int buf, int offset, int slot);
__attribute__((import_module("gpu"), import_name("compute_dispatch")))
extern void gpu_compute_dispatch(int pass, int x, int y, int z);
__attribute__((import_module("gpu"), import_name("end_compute_pass")))
extern void gpu_end_compute_pass(int pass);
__attribute__((import_module("gpu"), import_name("begin_render_pass")))
extern int gpu_begin_render_pass(int texture, float cr, float cg, float cb, float ca);
__attribute__((import_module("gpu"), import_name("render_set_pso")))
extern void gpu_render_set_pso(int pass, int pso);
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
__attribute__((import_module("gpu"), import_name("release")))
extern void gpu_release(int handle);

/* state imports (minimal) */
__attribute__((import_module("state"), import_name("set_metadata")))
extern void state_set_metadata(const char* id, int id_len, int version_packed);
__attribute__((import_module("state"), import_name("get_key")))
extern int state_get_key(char* buf, int buf_len);
__attribute__((import_module("state"), import_name("console_log")))
extern void state_console_log(int level, const char* msg, int msg_len);

static int str_len(const char* s) { int n = 0; while (s[n]) n++; return n; }

/* GPU handles */
static int h_compute_pso;
static int h_render_pso;
static int h_uniform_buf;
static int h_vertex_buf;
static int initialized;

/* Known test color: R=0.0, G=0.5, B=1.0 */
struct Uniforms { float r, g, b, _pad; };

__attribute__((export_name("init")))
void init(void) {
  initialized = 0;

  static const char id[] = "com.nattos.gpu_test";
  state_set_metadata(id, sizeof(id) - 1, (1 << 16));

  if (gpu_get_backend() < 0) return;

  int h_cs = gpu_create_shader_module(COMPUTE_WGSL, str_len(COMPUTE_WGSL));
  int h_vs = gpu_create_shader_module(VERTEX_WGSL, str_len(VERTEX_WGSL));
  int h_fs = gpu_create_shader_module(FRAGMENT_WGSL, str_len(FRAGMENT_WGSL));
  if (h_cs < 0 || h_vs < 0 || h_fs < 0) return;

  static const char cs_entry[] = "main";
  static const char vs_entry[] = "main";
  static const char fs_entry[] = "main";

  h_compute_pso = gpu_create_compute_pso(h_cs, cs_entry, sizeof(cs_entry) - 1);
  h_render_pso = gpu_create_render_pso(
      h_vs, vs_entry, sizeof(vs_entry) - 1,
      h_fs, fs_entry, sizeof(fs_entry) - 1, 2);

  h_uniform_buf = gpu_create_buffer(16, 2); /* uniform */
  h_vertex_buf = gpu_create_buffer(6 * 24, 1); /* storage: 6 verts × 24 bytes */

  /* Upload known color */
  struct Uniforms u = { 0.0f, 0.5f, 1.0f, 0.0f };
  gpu_write_buffer(h_uniform_buf, 0, &u, sizeof(u));

  initialized = 1;
  state_console_log(0, "gpu_test: initialized", 21);
}

__attribute__((export_name("tick")))
void tick(double dt) { (void)dt; }

__attribute__((export_name("on_param_change")))
void on_param_change(int index, double value) { (void)index; (void)value; }

__attribute__((export_name("on_state_changed")))
void on_state_changed(void) {}

__attribute__((export_name("render")))
void render(int vp_w, int vp_h) {
  if (!initialized) return;
  (void)vp_w; (void)vp_h;

  /* Compute pass: generate full-screen quad vertices with test color */
  int cp = gpu_begin_compute_pass();
  gpu_compute_set_pso(cp, h_compute_pso);
  gpu_compute_set_buffer(cp, h_uniform_buf, 0, 0);
  gpu_compute_set_buffer(cp, h_vertex_buf, 0, 1);
  gpu_compute_dispatch(cp, 1, 1, 1);
  gpu_end_compute_pass(cp);

  /* Render pass: draw the quad */
  int rt = gpu_get_render_target();
  int rp = gpu_begin_render_pass(rt, 0.0f, 0.0f, 0.0f, 1.0f);
  gpu_render_set_pso(rp, h_render_pso);
  gpu_render_set_vertex_buffer(rp, h_vertex_buf, 0, 0);
  gpu_render_draw(rp, 6, 1);
  gpu_end_render_pass(rp);

  gpu_submit();
}
