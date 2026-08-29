/*
 * util.triptych — three inputs, side by side in a row.
 *
 * Built to look at `source.mesh.three_walls`, whose three outputs are the three
 * walls of one room. Separately they are three pictures; in a row, in the order
 * the walls physically sit, they are one space — and that is the only way to
 * see whether a frame's light actually carries around the corners instead of
 * jumping.
 *
 * `tex_in` is the MIDDLE panel, so dropping this after any effect wires the
 * main output into the centre automatically and only the two sides need
 * drawing by hand.
 *
 * A fourth input, `led_in`, takes the LED-bar pixel map that both neon-quad
 * instruments publish, and it goes UNDER the middle third rather than beside
 * it — the strip is not a fourth wall, it is the same instrument read a second
 * way, so it belongs beneath the picture it is a reading of.
 *
 * Its height comes off the WHOLE FRAME, not out of the middle panel. The three
 * columns are three walls of one room and have to read as one picture, so they
 * keep the same top and the same bottom always; a middle panel that shrank
 * would step the room at both seams. Unwired, the strip costs nothing and the
 * row is the full frame.
 *
 * Deliberately dumb: no blending, no colour work, no per-panel transform beyond
 * the fit. It is a measuring surface, and a measuring surface that alters what
 * it shows is worse than useless.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "triptych_shaders.h"

namespace triptych {

// Mirrors `cbuffer Uniforms` in render.hlsl, row for row.
struct Uniforms {
  float misc[4];   // fit mode, gap, has_left, has_right
  float view[4];   // vp_w, vp_h, -, -
  float led[4];    // has_led, strip height, -, -
};
static_assert(sizeof(Uniforms) == 48, "Uniforms layout mismatch with render.hlsl");

struct State {
  int fit_mode = 0;
  float gap = 0.0f;
  float led_height = 0.25f;

  bool initialized = false;
  gpu::Buffer uniform_buf;
  gpu::Sampler sampler;
};

static gpu::ComputePSO s_pso;

void module_init() {
  state::init("util.triptych", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Triptych\n"
        "Three pictures, side by side in a row. A measuring surface: it does "
        "no blending and no colour work, so what you see is what the three "
        "inputs are.\n\n"
        "It exists for **Three Walls**, whose three outputs are the three "
        "walls of one room. Wire *Left* and *Right* from its two side outputs "
        "and drop this straight after it — the main output lands in the middle "
        "on its own — and the room is laid out flat in front of you, in the "
        "order the walls actually sit.\n\n"
        "*Fit* decides what happens when an input does not match the shape of "
        "its third — and it never will, since a third of the frame is a third "
        "of the shape. **Fit** letterboxes, so nothing is distorted; that is "
        "the default, because a measuring surface that squashes what it shows "
        "is a worse one. **Stretch** fills the panel instead, wasting no space "
        "and keeping the three continuous, which is better when they are meant "
        "to read as one space rather than be compared. **Fill** crops.\n\n"
        "*LED In* takes the pixel map those cards publish and puts it in a "
        "strip UNDER the middle third — not beside it, because the three "
        "columns are the room and the strip is the same instrument read a "
        "second way. It takes its height off the whole frame, so the three "
        "panels stay an aligned row. On **Stretch** it fills the strip, which "
        "is what you usually want: a pixel map has no aspect worth "
        "preserving.\n\n"
        "Anything unwired is left transparent, so an empty panel and a dark "
        "one never look alike.")

      .group("layout", "Layout")
      .selectField("fit_mode", 0, state::SecondaryInput,
                   {{"Fit", 0}, {"Stretch", 1}, {"Fill", 2}})
        .label("Fit", "Fit")
      .floatField("gap", 0.0f, 0.f, 0.2f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "A transparent divider at each seam, as a fraction of one "
                  "panel's width. Every panel loses the same strip, so they "
                  "stay equal — and the divider under the middle panel is cut "
                  "to the same thickness, so one knob draws one kind of line.")
        .label("Gap", "Gap")
      .floatField("led_height", 0.25f, 0.05f, 0.6f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "How much of the frame's height the LED strip takes. All "
                  "three panels give it up together, so the row stays aligned.")
        .label("LED Height", "LED H")

      // `tex_in` is the middle, so a plain drop-in wires the main output to the
      // centre panel. Declaration order is slot order for texture inputs
      // (schema_util.h's deriveSlotInputTextureFields sorts on it).
      .textureField("tex_in",   state::PrimaryInput)
      .textureField("left_in",  state::SecondaryInput)
      .textureField("right_in", state::SecondaryInput)
      .textureField("led_in",   state::SecondaryInput)
      .textureField("tex_out",  state::PrimaryOutput)

      // A frame is a pure function of its inputs — nothing accumulates, so a
      // time jump lands on exactly the right picture.
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("triptych_render", RENDER_SPV, RENDER_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("triptych_render");
  if (!cs) return;

  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)          // mid   (tex_in)
      .tex2d(1)          // left
      .tex2d(2)          // right
      .storageTex2d(3)   // tex_out
      .sampler(4)
      .uniform(5)
      .tex2d(6));        // led

  state::log("triptych: module initialized");
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  // Linear, so a panel squashed into a third does not alias into stair-steps.
  s->sampler = gpu::Device::createSampler(gpu::FilterMode::Linear,
                                          gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->sampler.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s_pso.valid() || !s->uniform_buf.valid() || !s->sampler.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) {
  (void)self; (void)dt;   // nothing accumulates
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized) return;

  auto mid = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!mid.valid() || !out.valid()) return;

  auto left  = gpu::Device::textureForField("left_in");
  auto right = gpu::Device::textureForField("right_in");
  auto led   = gpu::Device::textureForField("led_in");
  const bool has_left = left.valid();
  const bool has_right = right.valid();
  const bool has_led = led.valid();

  // An unwired side still needs SOMETHING bound for the dispatch to be legal;
  // the middle stands in, and the shader is told not to read it.
  Uniforms u = {};
  u.misc[0] = float(s->fit_mode);
  u.misc[1] = s->gap;
  u.misc[2] = has_left ? 1.0f : 0.0f;
  u.misc[3] = has_right ? 1.0f : 0.0f;
  u.view[0] = float(vp_w);
  u.view[1] = float(vp_h);
  u.led[0] = has_led ? 1.0f : 0.0f;
  u.led[1] = s->led_height;
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(mid, 0, 0);
  cp.setTexture(has_left ? left : mid, 1, 0);
  cp.setTexture(has_right ? right : mid, 2, 0);
  cp.setTexture(out, 3, 1);
  cp.setSampler(s->sampler, 4);
  cp.setBuffer(s->uniform_buf, 5);
  cp.setTexture(has_led ? led : mid, 6, 0);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

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
    if      (state::pathIs(p, l, "fit_mode")) s->fit_mode = state::patchInt(i);
    else if (state::pathIs(p, l, "gap"))      s->gap = state::patchFloat(i);
    else if (state::pathIs(p, l, "led_height")) s->led_height = state::patchFloat(i);
  }
}

}  // namespace triptych
