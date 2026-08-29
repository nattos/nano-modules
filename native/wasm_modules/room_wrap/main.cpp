/*
 * util.room_wrap — one picture, wrapped around the three walls of a room.
 *
 * It exists for the physical rig: a back screen and two side screens, wanting
 * ONE wipe or one field of light to cross all three as a single continuous
 * thing. Cut a gradient into three panels naively and it stalls at the seams —
 * the sides are foreshortened in the viewer's eye and a linear third of the
 * picture takes the wrong amount of time to cross them. This does the geometry
 * instead.
 *
 * The mid output is a plain centred zoom of the input, at square pixels always;
 * `left_out` and `right_out` carry everything that overflowed it to either
 * side, keystoned. Scale is what creates the overflow — at 1 there is none —
 * and Perspective decides how hard the walls foreshorten it, from a flat row at
 * 0 to the honest room at 1.
 *
 * A SIDE OUTPUT IS A PICTURE OF A WALL, NOT A TEXTURE FOR ONE. Its outer end is
 * the end nearest the viewer and is therefore the ENLARGED one, the way
 * anything close is: at Scale 3 and Perspective 1 the outer quarter of a panel
 * carries a fifth of the picture the quarter beside the seam does. The other
 * reading — pack the near end SMALL so a projector spreading the panel evenly
 * over a real angled surface lands it right — is the same geometry run
 * backwards, and would be what to build if a warper sat downstream. It does not
 * here, and a panel whose nearest corner is its most crowded reads immediately
 * as a wall receding the wrong way. See render.hlsl.
 *
 * The projection is shared with `util.triptych` (shaders_common/
 * nano_room_wall.hlsl), which composites three panels INTO a room the way this
 * cuts one picture up for one. Note they are not inverses: triptych's Room mode
 * reads its sides as wall textures and applies the map a second time, so
 * previewing this through it wants triptych's own Perspective at 0 — a flat
 * row, which is what a rig of three flat screens shows anyway.
 *
 * The side outputs are effect-owned and dispatched only when something is wired
 * to them, so the common "just a zoom" case costs one pass. There is no state
 * of any kind: a frame is a pure function of the input and the knobs.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "room_wrap_shaders.h"

namespace room_wrap {

// Mirrors `cbuffer Uniforms` in render.hlsl.
struct Uniforms {
  float pane[4];   // which pane, scale, perspective, back-wall half-height
};
static_assert(sizeof(Uniforms) == 16, "Uniforms layout mismatch with render.hlsl");

// 0 mid, 1 left, 2 right — the same numbering the shader branches on, and the
// order the walls physically sit in once laid out.
constexpr int kPanes = 3;

struct State {
  float scale = 3.0f;
  float perspective = 1.0f;

  bool initialized = false;
  gpu::Buffer uniform_buf[kPanes];
  gpu::Sampler sampler;

  // The two side walls. The executor allocates and sizes `tex_out` only;
  // anything else is ours to own, size and republish.
  gpu::Texture side_tex[2];
  int side_w[2] = {0, 0};
  int side_h[2] = {0, 0};
};

static gpu::ComputePSO s_pso;

void module_init() {
  state::init("util.room_wrap", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Room Wrap\n"
        "One picture, spread across the three walls of a room. A back screen "
        "and two side screens, fed from a single input, so a wipe or a field "
        "of light crosses all three as one continuous thing.\n\n"
        "The main output is the **back wall**: your input, at square pixels, "
        "zoomed in by *Scale*. Whatever that zoom pushes off the left and "
        "right edges comes out of **Left Out** and **Right Out** — all of it, "
        "keystoned into a view of a wall running away from you. So *Scale* is "
        "the whole show: at 1 the picture fits the back wall and the sides "
        "have nothing left to show; turn it up and the picture grows past the "
        "back wall and out around you.\n\n"
        "*Perspective* is how deep the room is. At **1** the walls reach "
        "exactly as far as the picture does, which is the honest room: the "
        "three screens tile your input with nothing repeated and nothing "
        "lost. Lower it and the walls foreshorten less, down to **0**, where "
        "they are just two flat panels in a row with the overflow stretched "
        "evenly across them.\n\n"
        "The OUTER end of each side panel is the one nearest you, so that is "
        "the end the picture opens out on — near things are big. The end that "
        "meets the back wall is packed tight, the way the far end of a "
        "corridor is.\n\n"
        "Either way the seams join CONTINUOUSLY — a side wall's inner edge "
        "reads the same column of the picture the back wall's edge does, at "
        "every setting. It never jumps. The scale steps there, and that is "
        "the corner.\n\n"
        "**Try:** put this after a slow gradient or a soft light wipe and send "
        "the three outputs to *Triptych* with *Middle Size* = Scale and its "
        "own *Perspective* at 0 — a flat row, which is how three screens in a "
        "line actually show it.\n\n"
        "The side outputs cost nothing until something is wired to them.")

      .group("room", "Room")
      .floatField("scale", 3.0f, 1.f, 8.f, state::PrimaryInput,
                  nullptr, 0.f, "x",
                  "How far to zoom the picture into the back wall — and so how "
                  "much of it spills onto the side walls. 1 fits the back wall "
                  "with nothing left over; 3 gives the back wall a third of "
                  "what the viewer sees, which is three even panels.")
        .label("Scale", "Scale")
      .floatField("perspective", 1.0f, 0.f, 1.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How deep the room is. At 1 the side walls reach exactly as "
                  "far as the picture does, so the three screens tile it "
                  "exactly — that is the real geometry, not a taste. At 0 they "
                  "are a flat row and each side is an even stretch of its "
                  "overflow. In between is a shallower room.")
        .label("Perspective", "Persp")

      .textureField("tex_in",    state::PrimaryInput)
      .textureField("tex_out",   state::PrimaryOutput)
      // After `tex_out` deliberately: the first texture output in declaration
      // order is THE output as far as port picking is concerned, and the back
      // wall has to be it (schema-channels.ts / firstFieldOfType).
      .textureField("left_out",  state::SecondaryOutput)
        .label("Left Out", "L")
      .textureField("right_out", state::SecondaryOutput)
        .label("Right Out", "R")

      // A frame is a pure function of its input — nothing accumulates.
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("room_wrap_render", RENDER_SPV, RENDER_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("room_wrap_render");
  if (!cs) return;

  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)          // tex_in
      .storageTex2d(1)   // the pane being written
      .sampler(2)
      .uniform(3));

  state::log("room_wrap: module initialized");
}

void* create() {
  auto* s = new State();
  for (int i = 0; i < kPanes; i++)
    s->uniform_buf[i] = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  // Linear and clamped. Linear because everything this card is for is smooth
  // and the walls minify toward their far ends; clamped because a side wall
  // can reach past the top of a source that is wider than the back wall, and
  // carrying the edge row out is the quiet answer where a wrap would put the
  // other end of the picture in the corner of the room.
  s->sampler = gpu::Device::createSampler(gpu::FilterMode::Linear,
                                          gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < kPanes; i++) s->uniform_buf[i].release();
  for (int i = 0; i < 2; i++) s->side_tex[i].release();
  s->sampler.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s_pso.valid() || !s->sampler.valid()) return;
  for (int i = 0; i < kPanes; i++)
    if (!s->uniform_buf[i].valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) {
  (void)self; (void)dt;   // nothing accumulates
}

/// One pane. `pane` is the shader's own numbering, and the uniform buffer is
/// per-pane so nothing has to reason about rewriting one between dispatches.
static void renderPane(State* s, gpu::Texture in, gpu::Texture out, int pane,
                       int vp_w, int vp_h, int out_w, int out_h) {
  Uniforms u = {};
  u.pane[0] = float(pane);
  u.pane[1] = s->scale;
  u.pane[2] = s->perspective;
  // Every length in the shader is measured on the BACK WALL, whose half-height
  // in units of its own half-width is this. A side pane's dispatch reads its
  // own dimensions, so it could not work this out for itself.
  u.pane[3] = float(vp_h) / float(vp_w > 0 ? vp_w : 1);
  s->uniform_buf[pane].writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in, 0, 0);
  cp.setTexture(out, 1, 1);
  cp.setSampler(s->sampler, 2);
  cp.setBuffer(s->uniform_buf[pane], 3);
  cp.dispatch((out_w + 7) / 8, (out_h + 7) / 8);
  cp.end();
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized) return;
  if (vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  renderPane(s, in, out, 0, vp_w, vp_h, vp_w, vp_h);

  static const char* const kField[2] = {"left_out", "right_out"};
  for (int side = 0; side < 2; side++) {
    if (!state::isOutputConnected(kField[side])) continue;

    if (!s->side_tex[side].valid() || s->side_w[side] != vp_w ||
        s->side_h[side] != vp_h) {
      s->side_tex[side].release();
      s->side_tex[side] = gpu::Device::createTexture(vp_w, vp_h);
      s->side_w[side] = vp_w;
      s->side_h[side] = vp_h;
      if (!s->side_tex[side].valid()) continue;
      // Published once per allocation, not per frame: the id only changes when
      // the texture does.
      state::setGpuTexture(kField[side], s->side_tex[side].id);
    }

    renderPane(s, in, s->side_tex[side], side + 1, vp_w, vp_h, vp_w, vp_h);
  }

  gpu::Device::submit();
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];
    if      (state::pathIs(p, l, "scale"))       s->scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "perspective")) s->perspective = state::patchFloat(i);
  }
}

}  // namespace room_wrap
