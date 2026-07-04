/*
 * source.shape_burst — a triggered expanding-shape generator.
 *
 * Conceptually an ADSR envelope in "decay only" mode (mirrors mod.source.adsr's
 * trigger surface), but instead of a scalar it RENDERS a shape. Each trigger
 * fires a "voice": a ring (circle / square / triangle) whose scale ramps from
 * min_scale → max_scale over `duration`, shaped by an easing curve, drawn hard-
 * cut solid (no fade) then gone. All bursts are concentric about `center`.
 *
 * Trigger surface (shared with env_adsr, style guide §8.1 / §8.2):
 *   auto_rate (0..1)  — Poisson auto-trigger (default 0.2 so a fresh drop moves)
 *   gate      (bool)  — rising edge fires one burst
 *   trigger   (event) — momentary one-shot (rising-edge detected)
 *   voices / retrigger — polyphony + Reset / Legato / Poly allocation
 *
 * manual (0..1) directly drives ONE highest-priority voice: 0 = not drawn, >0 =
 * a ring at the scale the easing maps `manual` to. It counts against `voices`
 * but always wins a slot (great for wiring a modulation source straight in).
 *
 * Composite mode: black / transparent / custom (bg color) / input (over tex_in).
 *
 * Per-instance ABI (§0): mutable state in State; the compute PSO + shader module
 * are type-shared file statics built once in module_init.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "sketch/envelope.h"   // envelope::applyEase — shared with mod.source.adsr
#include "shape_burst_shaders.h"

#include <cmath>
#include <cstdint>

namespace shape_burst {

enum Shape { ShapeCircle = 0, ShapeSquare = 1, ShapeTriangle = 2 };
enum Retrigger { RetrigReset = 0, RetrigLegato = 1, RetrigPoly = 2 };
enum Composite { CompBlack = 0, CompTransparent = 1, CompCustom = 2, CompInput = 3 };

constexpr int kMaxVoices = 16;

struct Voice {
  float t = 0.0f;        // burst progress [0,1]
  bool active = false;
  uint64_t age = 0;      // trigger order (for poly steal + newest-first draw)
};

// Uniform layout — MUST match compute.hlsl's cbuffer byte-for-byte.
struct Uniforms {
  float aspect_x, aspect_y;   // u_aspect
  float center_x, center_y;   // u_center
  float color[4];             // u_color
  float bg[4];                // u_bg
  uint32_t shape_kind;        // u_shape_kind
  uint32_t composite;         // u_composite
  float thickness;            // u_thickness
  float px;                   // u_px
  uint32_t count;             // u_count
  uint32_t _p0, _p1, _p2;
  float scales[kMaxVoices];   // u_scales (== float4[4])
};

struct State {
  // Shape params.
  int shape = ShapeCircle;
  float min_scale = 0.05f, max_scale = 1.20f;
  float thickness = 0.03f;
  float center[2] = { 0.0f, 0.0f };
  float curve = 0.0f;
  float color[4] = { 1.0f, 1.0f, 1.0f, 1.0f };
  // Timing.
  float duration = 0.30f;
  float manual = 0.0f;
  // Polyphony.
  int voices = 1;
  int retrigger = RetrigReset;
  // Trigger.
  float auto_rate = 0.2f;
  bool gate_prev = false;
  bool trigger_prev = false;
  // Composite.
  int composite = CompBlack;
  float bg_color[4] = { 0.0f, 0.0f, 0.0f, 1.0f };

  uint32_t rng = 0x5EED5EEDu;   // auto-trigger Poisson stream
  uint64_t trig_counter = 0;    // monotonic, stamps Voice::age
  Voice v[kMaxVoices];

  bool initialized = false;
  gpu::Buffer uniform_buf;
};

static gpu::ComputePSO s_pso;   // type-shared
static gpu::Texture s_black;    // type-shared 1x1 fallback for the "input" slot
                                // when nothing is wired upstream (chain-start).

// Param 0..1 → seconds. Quadratic: fine control at the short end, ~4s ceiling.
static inline double seconds(float p) {
  if (p < 0.0f) p = 0.0f;
  if (p > 1.0f) p = 1.0f;
  return 0.003 + (double)p * (double)p * 4.0;
}

// Burst progress t → ring scale (cover-square units), via the shared easing.
static inline float scaleForT(const State* s, float t) {
  float e = envelope::applyEase(t, s->curve);
  return s->min_scale + (s->max_scale - s->min_scale) * e;
}

static void startBurst(State* s, int vi) {
  Voice& v = s->v[vi];
  v.active = true;
  v.t = 0.0f;
  v.age = ++s->trig_counter;
}

// Pick a voice for a poly trigger: a free one if any, else steal the oldest.
static int pickVoice(State* s) {
  int n = s->voices;
  if (n < 1) n = 1;
  if (n > kMaxVoices) n = kMaxVoices;
  for (int i = 0; i < n; i++)
    if (!s->v[i].active) return i;
  int best = 0;
  uint64_t bestAge = s->v[0].age;
  for (int i = 1; i < n; i++)
    if (s->v[i].age < bestAge) { bestAge = s->v[i].age; best = i; }
  return best;
}

// Apply the retrigger policy and fire a burst (decay-only: no hold/sustain).
static void triggerVoice(State* s) {
  if (s->retrigger == RetrigPoly) {
    startBurst(s, pickVoice(s));
  } else if (s->retrigger == RetrigLegato) {
    Voice& v = s->v[0];
    if (!v.active) startBurst(s, 0);       // re-fire only when idle
    else v.age = ++s->trig_counter;        // already bursting → just re-stamp
  } else {  // RetrigReset
    startBurst(s, 0);                      // restart from the beginning
  }
}

void module_init() {
  state::init("source.shape_burst", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Shape Burst\n"
        "A triggered generator: every trigger fires an expanding **ring** "
        "(circle / square / triangle) that grows from *Min Scale* to *Max Scale* "
        "over *Duration*, then vanishes — like an ADSR *Decay* you can see.\n\n"
        "**Try:** sweep *Manual* to scrub one ring by hand (wire a modulation "
        "source into it for a hands-free pulse); raise *Auto Rate* to let it "
        "self-fire, bump *Voices* + *Retrigger → Poly* for overlapping "
        "shockwaves, and set *Composite → Input* to ripple over the layer below.")
      // --- Shape: what's drawn and how big ---
      .group("shape", "Shape")
        .groupHelp(
          "The ring geometry. *Shape* picks circle / square / triangle; *Min* and "
          "*Max Scale* are the start/end radii in aspect-correct screen units "
          "(1 ≈ the viewport edge). *Thickness* is the stroke width and *Curve* "
          "bends the growth (positive = fast-out / snappier). *Center* moves the "
          "origin all bursts emanate from.")
      .selectField("shape", ShapeCircle, state::PrimaryInput,
                   {{"Circle", ShapeCircle}, {"Square", ShapeSquare},
                    {"Triangle", ShapeTriangle}}).label("Shape", "Shape")
      .floatField("min_scale", 0.05f, 0.f, 2.f, state::PrimaryInput).label("Min Scale", "Min")
      .floatField("max_scale", 1.20f, 0.f, 2.f, state::PrimaryInput).label("Max Scale", "Max")
      .floatField("thickness", 0.03f, 0.f, 0.5f, state::PrimaryInput).label("Thickness", "Thick")
      .floatField("curve", 0.0f, -1.f, 1.f, state::PrimaryInput).label("Curve", "Curve")
      .vec2Field("center", 0.0f, 0.0f, state::PrimaryInput, -1.f, 1.f).label("Center", "Center")
      .rgbaField("color", 1.0f, 1.0f, 1.0f, 1.0f, state::PrimaryInput).label("Colour", "Col")
      // --- Timing: how long a burst lasts + a manual scrub ---
      .group("timing", "Timing")
        .groupHelp(
          "*Duration* is how long one ring takes to grow from Min to Max (then it "
          "cuts out). *Manual* directly drives one always-on-top ring: 0 hides it, "
          "and 0→1 scrubs it across the same Min→Max range — wire a rail or LFO "
          "into it for a continuous pulse without triggering.")
      .floatField("duration", 0.30f, 0.f, 1.f, state::PrimaryInput).label("Duration", "Dur")
      .floatField("manual", 0.0f, 0.f, 1.f, state::PrimaryInput).label("Manual", "Man")
      // --- Polyphony: overlapping bursts + retrigger policy ---
      .group("polyphony", "Polyphony")
        .groupHelp(
          "*Voices* is how many rings can expand at once (Manual takes the highest-"
          "priority slot). *Retrigger* decides what a new trigger does: **Reset** "
          "restarts one ring, **Legato** leaves an in-flight ring alone, **Poly** "
          "launches a fresh overlapping ring each time.")
      .intField("voices", 1, 1, kMaxVoices, state::PrimaryInput).label("Voices", "Voices")
      .selectField("retrigger", RetrigReset, state::PrimaryInput,
                   {{"Reset", RetrigReset}, {"Legato", RetrigLegato},
                    {"Poly", RetrigPoly}}).label("Retrigger", "Retrig")
      // --- Trigger: what fires a burst ---
      .group("trigger", "Trigger")
        .groupHelp(
          "*Auto Rate* self-fires at random (Poisson) — 0 stops it. A *Gate*'s "
          "rising edge fires one burst; *Trigger* is a momentary one-shot. Drive "
          "these from MIDI, a beat clock, or another modulation source.")
      .floatField("auto_rate", 0.2f, 0.f, 1.f, state::PrimaryInput).label("Auto Rate", "Auto")
      .boolField("gate", false, state::PrimaryInput).label("Gate", "Gate")
      .eventField("trigger", state::PrimaryInput).label("Trigger", "Trig")
      // --- Composite: how the rings land on the frame ---
      .group("composite", "Composite")
        .groupHelp(
          "The backdrop the rings draw over. **Black** / **Custom** give an opaque "
          "fill, **Transparent** leaves everything but the rings clear (so a layer "
          "below shows through), and **Input** composites the rings over the "
          "incoming image.")
      .selectField("composite", CompBlack, state::PrimaryInput,
                   {{"Black", CompBlack}, {"Transparent", CompTransparent},
                    {"Custom", CompCustom}, {"Input", CompInput}}).label("Composite", "Comp")
      .rgbaField("bg_color", 0.0f, 0.0f, 0.0f, 1.0f, state::SecondaryInput).label("Background", "BG")
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::Generator)
  );
  state::log("shape_burst: init");

  if (gpu::Device::backend() == gpu::Backend::None) return;
  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main",
    gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));

  // 1x1 black bound at the input slot when this generator starts a chain
  // (no upstream tex_in). Out-of-bounds Loads read 0, so "Input" composite
  // falls back to black cleanly.
  s_black = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA8);
  if (s_black.valid()) gpu::Device::clear(s_black, 0.f, 0.f, 0.f, 1.f);
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  gpu::Buffer buf = s->uniform_buf;   // preserve the allocated buffer across reset
  *s = State();
  s->uniform_buf = buf;
  s->initialized = buf.valid();
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  // Poisson auto-trigger (§4.1): rate_hz = pow(60, auto_rate) - 1.
  if (s->auto_rate > 0.0f) {
    float rate_hz = std::pow(60.0f, s->auto_rate) - 1.0f;
    if (rate_hz > 0.0f) {
      float lambda = rate_hz * (float)dt;
      s->rng = s->rng * 1664525u + 1013904223u;
      float u = (s->rng >> 8) * (1.0f / 16777216.0f);
      if (u < 1.0f - std::exp(-lambda)) triggerVoice(s);
    }
  }

  // Advance every active burst; hard-cut when it completes.
  const double dur = seconds(s->duration);
  for (int i = 0; i < kMaxVoices; i++) {
    Voice& v = s->v[i];
    if (!v.active) continue;
    v.t += (float)(dt / dur);
    if (v.t >= 1.0f) { v.active = false; v.t = 0.0f; }
  }
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];
    if      (state::pathIs(p, l, "shape"))      s->shape = state::patchInt(i);
    else if (state::pathIs(p, l, "min_scale"))  s->min_scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "max_scale"))  s->max_scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "thickness"))  s->thickness = state::patchFloat(i);
    else if (state::pathIs(p, l, "curve"))      s->curve = state::patchFloat(i);
    else if (state::pathIs(p, l, "center")) {
      auto v = state::patchVec2(i); s->center[0] = v.x; s->center[1] = v.y;
    }
    else if (state::pathIs(p, l, "color")) {
      auto v = state::patchVec4(i);
      s->color[0] = v.x; s->color[1] = v.y; s->color[2] = v.z; s->color[3] = v.w;
    }
    else if (state::pathIs(p, l, "duration"))   s->duration = state::patchFloat(i);
    else if (state::pathIs(p, l, "manual"))     s->manual = state::patchFloat(i);
    else if (state::pathIs(p, l, "voices"))     s->voices = state::patchInt(i);
    else if (state::pathIs(p, l, "retrigger"))  s->retrigger = state::patchInt(i);
    else if (state::pathIs(p, l, "auto_rate"))  s->auto_rate = state::patchFloat(i);
    else if (state::pathIs(p, l, "composite"))  s->composite = state::patchInt(i);
    else if (state::pathIs(p, l, "bg_color")) {
      auto v = state::patchVec4(i);
      s->bg_color[0] = v.x; s->bg_color[1] = v.y; s->bg_color[2] = v.z; s->bg_color[3] = v.w;
    }
    else if (state::pathIs(p, l, "gate")) {
      bool g = state::patchBool(i);
      if (g && !s->gate_prev) triggerVoice(s);   // rising edge → one burst
      s->gate_prev = g;
    }
    else if (state::pathIs(p, l, "trigger")) {
      bool t = state::patchEvent(i);
      if (t && !s->trigger_prev) triggerVoice(s);  // momentary rising edge
      s->trigger_prev = t;
    }
  }
}

// Build the draw list: manual voice first (highest priority), then the newest
// active pool voices, capped at `voices` total.
static void fillUniforms(State* s, int vp_w, int vp_h, Uniforms& u) {
  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);
  u.aspect_x = ax; u.aspect_y = ay;
  u.center_x = s->center[0]; u.center_y = s->center[1];
  for (int i = 0; i < 4; i++) { u.color[i] = s->color[i]; u.bg[i] = s->bg_color[i]; }
  u.shape_kind = (uint32_t)s->shape;
  u.composite = (uint32_t)s->composite;
  u.thickness = s->thickness;
  int maxDim = vp_w > vp_h ? vp_w : vp_h;
  u.px = maxDim > 0 ? 2.0f / (float)maxDim : 0.002f;   // one pixel in cover-square units
  u._p0 = u._p1 = u._p2 = 0;
  for (int i = 0; i < kMaxVoices; i++) u.scales[i] = -1.0f;

  int cap = s->voices; if (cap < 1) cap = 1; if (cap > kMaxVoices) cap = kMaxVoices;
  int count = 0;

  if (s->manual > 0.0f && count < cap)
    u.scales[count++] = scaleForT(s, s->manual);

  // Newest-first: repeatedly pick the highest-age active voice not yet taken.
  bool taken[kMaxVoices] = { false };
  while (count < cap) {
    int best = -1; uint64_t bestAge = 0;
    for (int i = 0; i < kMaxVoices; i++) {
      if (!s->v[i].active || taken[i]) continue;
      if (best < 0 || s->v[i].age > bestAge) { best = i; bestAge = s->v[i].age; }
    }
    if (best < 0) break;
    taken[best] = true;
    u.scales[count++] = scaleForT(s, s->v[best].t);
  }
  u.count = (uint32_t)count;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;
  if (!in.valid()) in = s_black;   // chain-start: no upstream input
  if (!in.valid()) return;

  Uniforms u = {};
  fillUniforms(s, vp_w, vp_h, u);
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in,  0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace shape_burst
