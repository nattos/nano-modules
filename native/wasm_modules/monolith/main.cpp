/*
 * source.mesh.monolith — Glassy 3D primitive generator.
 *
 * Renders a simple convex solid — the 1:4:9 "monolith" slab or a regular
 * triangular pyramid (tetrahedron) — alpha-composited over the input, with
 * up to three concentric echo shells at growing scale and fading opacity.
 *
 * The platform has NO z-buffer and blending only exists on the instanced
 * render-PSO path, so the whole 3D pipeline runs on the CPU each frame
 * (<= 36 triangles): rotate -> project -> facing classification -> flat
 * lambert shade (back faces kept and dimmed: "glassy") -> ANALYTIC painter's
 * order -> write final clip-space verts + colors into a storage buffer ->
 * one AlphaOver draw over the compute-prefilled copy of tex_in.
 *
 * Draw order is exact, not sorted. Depth-sorting triangle centroids fails
 * for thin slabs (a far-face centroid can sit nearer than a near-face
 * centroid once rotated), but nested convex scaled copies admit a closed-
 * form order: along any eye ray the hit sequence is front(outer) ...
 * front(inner), back(inner) ... back(outer), so painting back faces
 * outermost->innermost then front faces innermost->outermost is correct
 * from every viewpoint outside the outermost shell. Within one convex
 * solid, back faces never overlap each other on screen (nor do front
 * faces), so order inside each group is irrelevant.
 *
 * Facing convention: triangle winding is normalized once at module_init so
 * the right-handed cross of each tri's edges points INWARD. Under the
 * perspective projection below, sign(projected signed area) then equals
 * sign(m . a) exactly, so `area2 > 0` <=> the face's outside is toward the
 * eye (front face). This is computed in the pre-flip y-up square-NDC space
 * the GPU never sees, so it is identical across WebGPU/Metal.
 *
 * Motion is accumulator-driven (style guide §2.1 — never time*rate): an
 * eased yaw Arc (sine ping-pong), a two-axis Tumble at golden-ratio-
 * incommensurate rates, or an Arcing Tumble whose angular speed swells and
 * relaxes. Sync = Free (speed knob, exponential Hz mapping) or Bars
 * (host::barPhase() deltas per §2.2 — frozen without a running transport).
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>

#include <algorithm>
#include <cmath>

#include "monolith_shaders.h"

namespace monolith {

constexpr float kPi = 3.14159265358979323846f;
constexpr float kTau = 2.0f * kPi;

// --- Selects ---
constexpr int SHAPE_MONOLITH = 0;
constexpr int SHAPE_PYRAMID = 1;
constexpr int MOTION_ARC = 0;
constexpr int MOTION_TUMBLE = 1;
constexpr int MOTION_ARCING = 2;
constexpr int SYNC_FREE = 0;
constexpr int SYNC_BARS = 1;

// --- Camera (fixed; tuning cut deliberately — keep the surface tight) ---
constexpr float kCamDist = 3.0f;              // object center on the view axis
constexpr float kFocal = 3.7320508f;          // 1/tan(30deg/2)
// Direction from surface toward the light (upper-left, toward camera).
constexpr float kLightX = -0.45f, kLightY = 0.65f, kLightZ = -0.6f;

// ---------------------------------------------------------------------------
// Tiny 3D helpers (no shared mat lib exists; precedent: effects roll local).
// View space: x right, y up, z INTO the screen; camera at origin looking +z.
// ---------------------------------------------------------------------------

struct V3 { float x, y, z; };

static inline V3 v3Sub(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
static inline float v3Dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static inline V3 v3Cross(V3 a, V3 b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
static inline V3 v3Norm(V3 a) {
  float len = std::sqrt(v3Dot(a, a));
  if (len < 1e-8f) return {0.0f, 0.0f, 1.0f};
  return {a.x / len, a.y / len, a.z / len};
}

struct M3 { float m[9]; };  // row-major

static inline M3 m3RotX(float a) {
  float c = std::cos(a), s = std::sin(a);
  return {{1, 0, 0,  0, c, -s,  0, s, c}};
}
static inline M3 m3RotY(float a) {
  float c = std::cos(a), s = std::sin(a);
  return {{c, 0, s,  0, 1, 0,  -s, 0, c}};
}
static inline M3 m3Mul(const M3& a, const M3& b) {
  M3 r;
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++)
      r.m[i * 3 + j] = a.m[i * 3 + 0] * b.m[0 * 3 + j] +
                       a.m[i * 3 + 1] * b.m[1 * 3 + j] +
                       a.m[i * 3 + 2] * b.m[2 * 3 + j];
  return r;
}
static inline V3 m3Apply(const M3& r, V3 v) {
  return {r.m[0] * v.x + r.m[1] * v.y + r.m[2] * v.z,
          r.m[3] * v.x + r.m[4] * v.y + r.m[5] * v.z,
          r.m[6] * v.x + r.m[7] * v.y + r.m[8] * v.z};
}

// ---------------------------------------------------------------------------
// Geometry tables. Winding is normalized programmatically in module_init()
// (right-handed edge cross pointed INWARD, i.e. against the centroid ray) so
// the tables themselves don't need hand-verified orientation.
// ---------------------------------------------------------------------------

// Regular triangular pyramid (tetrahedron), centroid at origin, apex up.
// Circumradius R = 0.70: apex (0, R, 0); base ring at y = -R/3 with
// horizontal radius 2*sqrt(2)/3 * R, one base vertex LEADING toward the
// camera (angle 270 deg) so the frontal view shows two differently-lit
// faces meeting at a slanted center edge. Edge length ~1.143 (regular).
static const V3 kPyrVerts[4] = {
    {0.000000f, 0.700000f, 0.000000f},    // apex
    {0.571577f, -0.233333f, 0.330000f},   // b0 (30 deg)
    {-0.571577f, -0.233333f, 0.330000f},  // b1 (150 deg)
    {0.000000f, -0.233333f, -0.660000f},  // b2 (leading vertex)
};
static uint8_t kPyrTris[4][3] = {
    {1, 2, 3},              // base
    {0, 1, 2},              // side b0-b1
    {0, 2, 3},              // side b1-b2
    {0, 3, 1},              // side b2-b0
};

// The 1:4:9 monolith (depth : width : height), height-normalized.
constexpr float kMonoHx = 0.575f * 4.0f / 9.0f;  // half-width
constexpr float kMonoHy = 0.575f;                // half-height
constexpr float kMonoHz = 0.575f / 9.0f;         // half-depth (slab faces camera)
static const V3 kMonoVerts[8] = {
    {-kMonoHx, -kMonoHy, -kMonoHz}, {kMonoHx, -kMonoHy, -kMonoHz},
    {kMonoHx, kMonoHy, -kMonoHz},   {-kMonoHx, kMonoHy, -kMonoHz},
    {-kMonoHx, -kMonoHy, kMonoHz},  {kMonoHx, -kMonoHy, kMonoHz},
    {kMonoHx, kMonoHy, kMonoHz},    {-kMonoHx, kMonoHy, kMonoHz},
};
static uint8_t kMonoTris[12][3] = {
    {0, 1, 2}, {0, 2, 3},   // near (toward camera at rest)
    {5, 4, 7}, {5, 7, 6},   // far
    {1, 5, 6}, {1, 6, 2},   // right
    {4, 0, 3}, {4, 3, 7},   // left
    {3, 2, 6}, {3, 6, 7},   // top
    {4, 5, 1}, {4, 1, 0},   // bottom
};

struct ShapeDef {
  const V3* verts;
  int vert_count;
  uint8_t (*tris)[3];
  int tri_count;
};
static const ShapeDef kShapes[2] = {
    {kMonoVerts, 8, kMonoTris, 12},  // SHAPE_MONOLITH
    {kPyrVerts, 4, kPyrTris, 4},     // SHAPE_PYRAMID
};

constexpr int kMaxCopies = 3;
constexpr int kMaxTris = 12 * kMaxCopies;      // 36
constexpr int kMaxVerts = kMaxTris * 3;        // 108

// Normalize winding: right-handed cross of the tri's edges must point
// INWARD (opposite the origin->centroid ray — valid because both solids are
// convex and origin-centered). See the facing-convention note up top.
static void normalizeWinding(const ShapeDef& shape) {
  for (int t = 0; t < shape.tri_count; t++) {
    V3 a = shape.verts[shape.tris[t][0]];
    V3 b = shape.verts[shape.tris[t][1]];
    V3 c = shape.verts[shape.tris[t][2]];
    V3 centroid = {(a.x + b.x + c.x) / 3.0f, (a.y + b.y + c.y) / 3.0f,
                   (a.z + b.z + c.z) / 3.0f};
    V3 m = v3Cross(v3Sub(b, a), v3Sub(c, a));
    if (v3Dot(m, centroid) > 0.0f) {
      uint8_t tmp = shape.tris[t][1];
      shape.tris[t][1] = shape.tris[t][2];
      shape.tris[t][2] = tmp;
    }
  }
}

// ---------------------------------------------------------------------------
// GPU-side vertex (mirrors Vtx in vs.hlsl): 8 floats, 16-byte aligned.
// ---------------------------------------------------------------------------
struct GpuVertex {
  float pos[4];   // clip xyzw (z = 0.5 cosmetic, w = 1)
  float rgba[4];  // straight alpha
};

// Type-shared PSOs (immutable post-compile — file-static per the ABI).
static gpu::ComputePSO s_pso_prefill;
static gpu::RenderPSO s_pso_render;

// Per-instance state.
struct State {
  bool initialized = false;
  gpu::Buffer vertex_buf;   // kMaxVerts * 32 B, rewritten each frame

  // Param mirrors.
  int shape = SHAPE_MONOLITH;
  int motion = MOTION_ARC;
  int sync = SYNC_FREE;
  int copies = 1;
  int bars = 4;
  float size = 0.5f;
  float alpha = 0.85f;
  float speed = 0.5f;
  float spread = 0.35f;
  float falloff = 0.6f;
  float color_r = 0.88f, color_g = 0.88f, color_b = 0.92f;
  float arc = 0.5f;
  float tilt = 0.0f;   // signed: + looks down at the top face, 0 neutral
  float shading = 0.7f;
  float back_dim = 0.6f;

  // Accumulators (§2.1) — cycles in [0,1).
  double phase_a = 0.0;         // primary rotation
  double phase_b = 0.0;         // secondary tumble axis (rate x golden conj.)
  double env_phase = 0.0;       // arcing-tumble speed envelope
  double last_bar_phase = -1.0; // §2.2 tracker; -1 = unseeded
};

static void apply_visibility(State* s) {
  state::setFieldHidden("speed", s->sync != SYNC_FREE);
  state::setFieldHidden("bars", s->sync != SYNC_BARS);
  state::setFieldHidden("arc", s->motion != MOTION_ARC);
}

static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  apply_visibility(s);
}

void module_init() {
  // 1.1.0: tilt became signed (-1..1, 0 neutral); the prism became a regular
  // triangular pyramid; Arc sweeps one way and snaps back (was ping-pong).
  state::init("source.mesh.monolith", {1, 1, 0},
    state::Schema()
      .helpField("intro",
        "## Monolith\n"
        "A floating 3D solid — the 1:4:9 slab from *2001* or a regular "
        "triangular pyramid — rendered as tinted glass over the input. Up "
        "to three concentric echo shells grow outward at fading opacity, "
        "and because the faces draw in exact depth order you see the far "
        "side of each shell through the near side.\n\n"
        "**Try:** *Motion* → Tumble with *Copies* 3 and a low *Opacity* for "
        "slow nested glass; *Sync* → Bars to lock one full motion cycle to "
        "the beat grid; *Color* black with *Shading* high for the film's "
        "void-black slab (it reads by its shaded edges alone).")
      // --- Shape ---
      .group("shape", "Shape")
      .selectField("shape", SHAPE_MONOLITH, state::PrimaryInput,
                   {{"Monolith", SHAPE_MONOLITH}, {"Pyramid", SHAPE_PYRAMID}})
          .label("Shape", "Shape")
      .floatField("size", 0.5f, 0.f, 1.f, state::PrimaryInput)
          .label("Size", "Size")
      .rgbField("color", 0.88f, 0.88f, 0.92f, state::PrimaryInput)
          .label("Color", "Color")
      .floatField("alpha", 0.85f, 0.f, 1.f, state::PrimaryInput)
          .label("Opacity", "Alpha")
      // --- Motion ---
      .group("motion", "Motion")
        .groupHelp(
          "*Arc* sweeps the shape one way through a yaw arc — easing in "
          "and out of the sweep — then snaps back to the start instantly. "
          "*Tumble* is constant angular momentum about two incommensurate "
          "axes — the corners trace curves that never repeat. *Arcing "
          "Tumble* is the same tumble but its speed swells and relaxes, so "
          "it seems to arc through its curves. *Free* runs on the Speed "
          "knob; *Bars* locks one motion cycle to N bars of the host "
          "transport (and freezes when no transport is running) — with "
          "Arc, the snap-back lands exactly on the bar line.")
      .selectField("motion", MOTION_ARC, state::PrimaryInput,
                   {{"Arc", MOTION_ARC},
                    {"Tumble", MOTION_TUMBLE},
                    {"Arcing Tumble", MOTION_ARCING}})
          .label("Motion", "Motion")
      .selectField("sync", SYNC_FREE, state::PrimaryInput,
                   {{"Free", SYNC_FREE}, {"Bars", SYNC_BARS}})
          .label("Sync", "Sync")
      .floatField("speed", 0.5f, 0.f, 1.f, state::PrimaryInput)
          .label("Speed", "Speed")
      .selectField("bars", 4, state::PrimaryInput,
                   {{"1", 1}, {"2", 2}, {"4", 4}, {"8", 8}, {"16", 16}})
          .label("Bars / Cycle", "Bars")
      // --- Concentric copies ---
      .group("copies", "Concentric Copies")
        .groupHelp(
          "Echo shells of the same solid at growing scale and fading "
          "opacity, all sharing the core's rotation. *Spread* sets how far "
          "apart the shells sit; *Alpha Falloff* how much fainter each "
          "shell is than the one inside it.")
      .intField("copies", 1, 1, kMaxCopies, state::PrimaryInput)
          .label("Copies", "Copies")
      .floatField("spread", 0.35f, 0.f, 1.f, state::PrimaryInput)
          .label("Spread", "Spread")
      .floatField("falloff", 0.6f, 0.f, 1.f, state::PrimaryInput)
          .label("Alpha Falloff", "Falloff")
      // --- Tuning ---
      .group("tuning", "Tuning")
      .floatField("arc", 0.5f, 0.f, 1.f, state::SecondaryInput)
          .label("Arc Width", "Arc")
      .floatField("tilt", 0.0f, -1.f, 1.f, state::SecondaryInput)
          .label("Tilt", "Tilt")
      .floatField("shading", 0.7f, 0.f, 1.f, state::SecondaryInput)
          .label("Shading", "Shade")
      .floatField("back_dim", 0.6f, 0.f, 1.f, state::SecondaryInput)
          .label("Back Face Dim", "BkDim")
      // --- I/O ---
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::Generator)
      .capability(state::Capability::SeekableApproximate)
  );

  normalizeWinding(kShapes[0]);
  normalizeWinding(kShapes[1]);

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("monolith_prefill", PREFILL_SPV, PREFILL_SPV_SIZE);
  state::registerShaderSPV("monolith_vs", VS_SPV, VS_SPV_SIZE);
  state::registerShaderSPV("monolith_fs", FS_SPV, FS_SPV_SIZE);

  auto cs_prefill = gpu::Device::createShaderModuleByName("monolith_prefill");
  auto vs_module = gpu::Device::createShaderModuleByName("monolith_vs");
  auto fs_module = gpu::Device::createShaderModuleByName("monolith_fs");
  if (!cs_prefill || !vs_module || !fs_module) return;

  s_pso_prefill = gpu::Device::createComputePSO(cs_prefill, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1));
  s_pso_render = gpu::Device::createInstancedRenderPSO(
      vs_module, "main", fs_module, "main",
      gpu::TextureFormat::Surface,
      gpu::Bindings().storage(0),   // verts[] (vertex stage pulls)
      gpu::Device::BlendMode::AlphaOver);

  state::log("monolith: module initialized");
}

void* create() {
  auto* s = new State();
  s->vertex_buf = gpu::Device::createBuffer(
      sizeof(GpuVertex) * kMaxVerts, gpu::BufferUsage::Storage);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->vertex_buf.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->phase_a = 0.0;
  s->phase_b = 0.0;
  s->env_phase = 0.0;
  s->last_bar_phase = -1.0;
  state::setOnStateReady(&on_state_ready);
  s->initialized = s_pso_prefill.valid() && s_pso_render.valid() &&
                   s->vertex_buf.valid();
}

static inline double wrap01(double v) { return v - std::floor(v); }

// Speed knob -> cycles/sec, exponential: ~0.014 at 0, 0.08 centered, ~0.45 at 1.
static inline double rateHz(float speed) {
  return 0.08 * std::pow(2.0, ((double)speed - 0.5) * 5.0);
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!(dt > 0.0)) dt = 0.0;
  if (dt > 0.050) dt = 0.050;   // stall guard: never jump the pose

  double d;   // cycles this frame
  if (s->sync == SYNC_FREE) {
    d = dt * rateHz(s->speed);
  } else {
    // Bars: consume barPhase deltas (§2.2). Frozen without a transport.
    double bp = host::barPhase();
    if (s->last_bar_phase < 0.0) { s->last_bar_phase = bp; return; }
    double dphase = bp - s->last_bar_phase;
    if (dphase < -0.5) dphase += 1.0;   // bar wrap
    if (dphase < 0.0) dphase = 0.0;     // scrub-back: hold rather than reverse
    s->last_bar_phase = bp;
    d = dphase / (double)(s->bars > 0 ? s->bars : 1);
  }

  double mult = 1.0;
  if (s->motion == MOTION_ARCING) {
    s->env_phase = wrap01(s->env_phase + d / 3.0);
    mult = 0.25 + 1.5 * (0.5 - 0.5 * std::cos(kTau * s->env_phase));
  }
  // Both phases always advance so switching motion modes never pops.
  s->phase_a = wrap01(s->phase_a + d * mult);
  s->phase_b = wrap01(s->phase_b + d * mult * 0.6180339887);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  bool vis_dirty = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "shape"))   s->shape = state::patchInt(i);
    else if (state::pathIs(p, l, "size"))    s->size = state::patchFloat(i);
    else if (state::pathIs(p, l, "color")) {
      auto v = state::patchVec3(i);
      s->color_r = v.x; s->color_g = v.y; s->color_b = v.z;
    }
    else if (state::pathIs(p, l, "alpha"))   s->alpha = state::patchFloat(i);
    else if (state::pathIs(p, l, "motion")) {
      int m = state::patchInt(i);
      if (m != s->motion) { s->motion = m; vis_dirty = true; }
    }
    else if (state::pathIs(p, l, "sync")) {
      int v = state::patchInt(i);
      if (v != s->sync) {
        s->sync = v;
        s->last_bar_phase = -1.0;   // re-seed the bar tracker on re-entry
        vis_dirty = true;
      }
    }
    else if (state::pathIs(p, l, "speed"))    s->speed = state::patchFloat(i);
    else if (state::pathIs(p, l, "bars"))     s->bars = state::patchInt(i);
    else if (state::pathIs(p, l, "copies"))   s->copies = state::patchInt(i);
    else if (state::pathIs(p, l, "spread"))   s->spread = state::patchFloat(i);
    else if (state::pathIs(p, l, "falloff"))  s->falloff = state::patchFloat(i);
    else if (state::pathIs(p, l, "arc"))      s->arc = state::patchFloat(i);
    else if (state::pathIs(p, l, "tilt"))     s->tilt = state::patchFloat(i);
    else if (state::pathIs(p, l, "shading"))  s->shading = state::patchFloat(i);
    else if (state::pathIs(p, l, "back_dim")) s->back_dim = state::patchFloat(i);
  }
  if (vis_dirty) apply_visibility(s);
}

// Per-tri record for the analytic painter's order (see the header comment):
// order = copies-1-ci for back faces, copies+ci for front faces.
struct TriRecord {
  int order;
  float clip[3][2];  // projected clip xy per corner
  float r, g, b, a;
};

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  // --- Pose ---
  // Tilt is signed: positive pitches the shape's top edge TOWARD the camera
  // (you look down onto the lit top face); negative reveals the underside.
  const float pitch = (-s->tilt * 40.0f) * (kPi / 180.0f);
  M3 rot;
  if (s->motion == MOTION_ARC) {
    // One-directional eased sweep across the arc, then an instant snap back
    // to the start when the phase wraps (the cosine ease has zero slope at
    // both ends, so the sweep settles into and out of its endpoints).
    const float arc_half = (20.0f + 140.0f * s->arc) * (kPi / 180.0f);
    const float yaw = arc_half * -std::cos(kPi * (float)s->phase_a);
    rot = m3Mul(m3RotY(yaw), m3RotX(pitch));
  } else {
    // Tumble / Arcing Tumble share the matrix; only the phase advance
    // differs (tick modulates it for Arcing).
    rot = m3Mul(m3RotY(kTau * (float)s->phase_a),
                m3RotX(kTau * (float)s->phase_b + pitch));
  }

  const ShapeDef& shape = kShapes[s->shape == SHAPE_PYRAMID ? 1 : 0];
  const auto cs = fx::coverSquare(vp_w, vp_h);
  const V3 light = v3Norm({kLightX, kLightY, kLightZ});
  const float size_world = 0.55f * std::pow(2.0f, (s->size - 0.5f) * 2.0f);
  const float spread_step = 0.15f + 0.85f * s->spread;
  const float falloff_mult = 1.0f - 0.8f * s->falloff;
  const int copies = s->copies < 1 ? 1 : (s->copies > kMaxCopies ? kMaxCopies : s->copies);

  TriRecord tris[kMaxTris];
  int tri_count = 0;

  for (int ci = 0; ci < copies; ci++) {
    const float scale = size_world * (1.0f + (float)ci * spread_step);
    const float alpha_i = s->alpha * std::pow(falloff_mult, (float)ci);
    if (alpha_i < 1.0f / 255.0f) continue;

    // Transform + project this copy's vertex ring once.
    V3 view[8];
    float sq[8][2];
    bool depth_ok = true;
    for (int vi = 0; vi < shape.vert_count; vi++) {
      V3 p = shape.verts[vi];
      p = {p.x * scale, p.y * scale, p.z * scale};
      p = m3Apply(rot, p);
      p.z += kCamDist;
      view[vi] = p;
      if (p.z < 0.1f) { depth_ok = false; break; }
      // y-up square NDC; the GPU never sees this space.
      sq[vi][0] = kFocal * p.x / p.z;
      sq[vi][1] = kFocal * p.y / p.z;
    }
    if (!depth_ok) continue;   // degenerate config; skip the copy

    for (int t = 0; t < shape.tri_count; t++) {
      const uint8_t* idx = shape.tris[t];
      const float ax = sq[idx[0]][0], ay = sq[idx[0]][1];
      const float bx = sq[idx[1]][0], by = sq[idx[1]][1];
      const float cx = sq[idx[2]][0], cy = sq[idx[2]][1];
      // Signed area in the y-up pre-flip space: > 0 <=> front face
      // (winding normalized inward-cross at module_init).
      const float area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (std::fabs(area2) < 1e-7f) continue;   // edge-on sliver
      const bool front = area2 > 0.0f;

      const V3 va = view[idx[0]], vb = view[idx[1]], vc = view[idx[2]];
      // Visible-side unit normal: m points inward, so the front face's
      // outward normal is -m and a back face's eye-side normal is +m.
      V3 nrm = v3Norm(v3Cross(v3Sub(vb, va), v3Sub(vc, va)));
      if (front) nrm = {-nrm.x, -nrm.y, -nrm.z};

      const float lambert = std::fmax(0.0f, v3Dot(nrm, light));
      float shade = 1.0f + s->shading * ((0.30f + 0.70f * lambert) - 1.0f);
      if (!front) shade *= 1.0f - 0.75f * s->back_dim;

      TriRecord& tr = tris[tri_count++];
      tr.order = front ? (copies + ci) : (copies - 1 - ci);
      for (int k = 0; k < 3; k++) {
        // Cover-square -> Vulkan clip. THE single y-flip of the pipeline
        // (y-up square NDC -> y-down Vulkan NDC); see vs.hlsl.
        tr.clip[k][0] = sq[idx[k]][0] * 2.0f * cs.ax;
        tr.clip[k][1] = -sq[idx[k]][1] * 2.0f * cs.ay;
      }
      auto clamp01 = [](float v) { return v < 0.f ? 0.f : (v > 1.f ? 1.f : v); };
      tr.r = clamp01(s->color_r * shade);
      tr.g = clamp01(s->color_g * shade);
      tr.b = clamp01(s->color_b * shade);
      tr.a = alpha_i;
    }
  }

  // --- Prefill: tex_in -> tex_out (passthrough base layer) ---
  if (in.valid()) {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_prefill);
    cp.setTexture(in, 0, 0);
    cp.setTexture(out, 1, 1);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  } else {
    gpu::Device::clear(out, 0.0f, 0.0f, 0.0f, 0.0f);
  }

  if (tri_count > 0) {
    // Analytic painter's order for nested convex copies (exact, not a depth
    // heuristic): back faces outermost->innermost, then front faces
    // innermost->outermost. See the header comment for why this is correct
    // from every exterior viewpoint.
    std::stable_sort(tris, tris + tri_count,
                     [](const TriRecord& a, const TriRecord& b) {
                       return a.order < b.order;
                     });

    GpuVertex verts[kMaxVerts];
    for (int t = 0; t < tri_count; t++) {
      for (int k = 0; k < 3; k++) {
        GpuVertex& v = verts[t * 3 + k];
        v.pos[0] = tris[t].clip[k][0];
        v.pos[1] = tris[t].clip[k][1];
        v.pos[2] = 0.5f;
        v.pos[3] = 1.0f;
        v.rgba[0] = tris[t].r;
        v.rgba[1] = tris[t].g;
        v.rgba[2] = tris[t].b;
        v.rgba[3] = tris[t].a;
      }
    }
    s->vertex_buf.write<GpuVertex>(verts, tri_count * 3);

    auto rp = gpu::RenderPass::beginLoad(out);
    rp.setPSO(s_pso_render);
    rp.setBuffer(s->vertex_buf, 0);
    rp.draw(tri_count * 3, 1);
    rp.end();
  }

  gpu::Device::submit();
}

void on_resolume_param(void* self, long long param_id, double value) {
  (void)self; (void)param_id; (void)value;
}

} // namespace monolith
