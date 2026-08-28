/*
 * source.mesh.three_walls — three neon quads rushing at you down a tunnel.
 *
 * The companion to source.mesh.three_planes, pointed the other way. three_planes
 * is VERTICAL — quads stacked with gravity, bottom heaviest, read as a level.
 * This one is FRONTAL: the same neon motif coming out of the screen, read as an
 * arrival. It borrows the whole quad field (shaders_common/nano_neon_quad.hlsl,
 * lifted out of three_planes for exactly this) and the VCR grade, and adds
 * perspective and a set of moves.
 *
 * THREE OUTPUTS, ONE SCENE. The tunnel is a 3D scene; the three texture outputs
 * are three CAMERAS on it. `tex_out` looks head-on down the throat; `left_out`
 * and `right_out` watch the same tunnel from off to either side, orbited around
 * its middle by `side_angle`. A quad that grows out of the main frame is, in the
 * same instant, a bar sweeping across the side views — one event, three views,
 * which is what makes the pulse read as passing THROUGH something.
 *
 * `side_angle` is a look knob, not a fact. At 90 degrees the side cameras see
 * the quads exactly edge-on: zero width, and the pulse crosses in no time. Back
 * it off and each quad projects to a skewed quadrilateral with real area and a
 * finite crossing. That is the whole reason it is a parameter.
 *
 * The aux outputs follow chroma_wave's `wave_out` pattern: the effect owns the
 * allocation, publishes the handle once, and skips the dispatch entirely unless
 * something downstream is wired to it. The executor allocates and sizes ONLY
 * `tex_out`.
 *
 * UNLIKE three_planes, this effect owns its rhythm. There is no companion rig
 * and no pattern input — four triggerable moves live in
 * <sketch/three_walls_show.h>, host-free, so the Catch2 goldens in
 * native/tests/test_three_walls_show.cpp drive them at an exact dt with no wasm
 * and no GPU. That also means it is NOT TimeIndependent: every move is an
 * accumulator and cannot be seeked.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include <effect_utils.h>   // fx::coverSquare
#include <sketch/three_walls_show.h>
#include "three_walls_shaders.h"

#include <cmath>
#include <cstdio>
#include <cstring>

namespace three_walls {

namespace show = three_walls_show;

static constexpr int QUADS = show::kQuads;
static constexpr int VIEWS = 3;      // main, left, right
static constexpr float kPi = 3.14159265358979323846f;

/// Anything nearer than this is behind the camera or on top of the lens; a quad
/// with a corner inside it is culled from THAT view rather than projected.
static constexpr float kNearPlane = 0.05f;

// Mirrors `cbuffer Uniforms` in render.hlsl, row for row.
struct Uniforms {
  float corners[6][4];      // rows 0-5   projected, this view
  float quad_color[3][4];   // rows 6-8   rgb = colour, w = emission drive
  float fills[4];           // row  9
  float misc[4];            // row 10     bleed, input opacity, debug, -
  float view[4];            // row 11     vp_w, vp_h, aspect_x, aspect_y
  float style[12];          // rows 12-14 NeonStyle, verbatim
  float grade[16];          // rows 15-18 VcrGrade, verbatim
};
static_assert(sizeof(Uniforms) == 304, "Uniforms layout mismatch with render.hlsl");

struct State {
  show::Params show_p;
  show::Core core;

  /// Rising/falling-edge memory for the four move triggers. The executor
  /// replays every stored value as a PatchReplace EVERY frame, so an event that
  /// fired on patch arrival would re-arm forever (style guide 8.2). The gates
  /// need the falling edge too, which is why this is a level and not a pulse.
  bool move_prev[show::kMoveCount] = {};
  /// Patches only ARM; tick() acts. A trigger and its knobs arriving in the
  /// same transaction then resolve the same way whatever order they land in
  /// (mod_latch's discipline).
  int pending_press = show::MoveNone;
  int pending_release = show::MoveNone;

  // --- Scene ---
  /// 0.35 rather than something rounder: at the default depth range this is the
  /// largest the frames can be while all three of Resonate's evenly-spaced pose
  /// still fit on screen. Bigger and the nearest one is always past the lens.
  float quad_size = 0.35f;
  float fov_deg = 55.0f;
  float side_angle_deg = 55.0f;
  float side_dolly = 1.0f;

  // --- Quads ---
  float color[QUADS][3] = {{1.00f, 0.22f, 0.62f},   // magenta  (quad 1)
                           {0.72f, 0.35f, 1.00f},   // violet   (quad 2)
                           {0.30f, 0.85f, 1.00f}};  // cyan     (quad 3, highlight)
  float emission[QUADS] = {0.85f, 0.85f, 0.85f};
  float fill[QUADS] = {0.0f, 0.0f, 0.0f};

  // --- Neon ---
  float line_width = 0.18f;
  float line_gain = 1.60f;
  float core_whiten = 0.85f;
  float halo_radius = 0.30f;
  float halo_gain = 0.55f;
  float halo_falloff = 0.45f;
  float halo_smooth = 0.35f;
  float corner_radius = 0.012f;
  float fill_gain = 0.22f;

  // --- Grade ---
  float exposure = 1.0f;
  float warmth = 0.35f;
  float drive = 0.35f;
  float asymmetry = 0.20f;
  float toe = 0.25f;
  float shoulder = 0.50f;
  float highlight_desat = 0.70f;
  float highlight_tint[3] = {1.00f, 0.22f, 0.62f};
  float highlight_tint_amount = 0.0f;
  float highlight_tint_pivot = 1.0f;
  float chroma_bleed = 0.25f;
  float scanline = 0.12f;
  int scanline_count = 240;
  float grain = 0.08f;
  float input_opacity = 1.0f;
  bool debug_show_quads = false;

  // --- Derived, recomputed each frame ---
  show::Out frame;

  // --- GPU ---
  bool initialized = false;
  gpu::Buffer uniform_buf[VIEWS];
  /// The two auxiliary views are the effect's own textures — the executor
  /// allocates only tex_out. Sized lazily, and only while something reads them.
  gpu::Texture aux_tex[2];
  int aux_w[2] = {0, 0};
  int aux_h[2] = {0, 0};
};

static gpu::ComputePSO s_pso;

// --- Perceptual mappings (style guide 1.3) --------------------------------
// Shared with three_planes, deliberately: the two cards' neon knobs have to
// mean the same thing or a preset cannot move between them.

static inline float emissionDrive(float e) {
  return std::pow(e < 0.0f ? 0.0f : e, 1.8f) * 3.2f;
}
static inline float lineHalfWidth(float w) {
  float t = w < 0.0f ? 0.0f : (w > 1.0f ? 1.0f : w);
  return 0.0012f + 0.0208f * t * t;
}
static inline float haloRadius(float r) {
  float t = r < 0.0f ? 0.0f : (r > 1.0f ? 1.0f : r);
  return 0.006f * std::pow(40.0f, t);
}

// --- Camera ---------------------------------------------------------------
// The tunnel runs down +z. The main camera sits at the origin looking into it;
// the side cameras ORBIT the tunnel's middle, so they see it from outside
// rather than just aiming at a wall.
//
// Perspective, unlike three_planes' orthographic affine map — a tunnel needs
// things to grow as they arrive, and that is a divide. Everything that follows
// from the divide (the near-plane cull, the per-view liveness) is the cost.

struct Camera {
  float pos[3];
  float ct, st;   // yaw about Y: cos, sin
  float focal;
};

/// `index` 0 = main, 1 = left, 2 = right.
static Camera makeCamera(const State& s, int index) {
  Camera c;
  // Half the tunnel's depth range, in the geometric middle rather than the
  // arithmetic one, so the side views frame what the eye actually reads as the
  // centre of the corridor.
  const float pivot_z = std::sqrt(s.show_p.z_far * s.show_p.z_near);
  const float fov = s.fov_deg * (kPi / 180.0f);
  c.focal = 1.0f / std::tan(0.5f * (fov < 1e-3f ? 1e-3f : fov));

  if (index == 0) {
    c.pos[0] = 0.0f; c.pos[1] = 0.0f; c.pos[2] = 0.0f;
    c.ct = 1.0f; c.st = 0.0f;
    return c;
  }
  const float sign = (index == 1) ? -1.0f : 1.0f;
  const float th = sign * s.side_angle_deg * (kPi / 180.0f);

  // Stand off far enough that the WHOLE tunnel fits, not just the pivot. Seen
  // from an angle the corridor's length subtends roughly extent*sin(th) across
  // the view, so the radius that frames it falls straight out of the FOV. Doing
  // this by hand instead would mean re-dialling the distance every time the
  // depth range moved.
  const float extent = s.show_p.z_far - s.show_p.z_near;
  const float sin_th = std::fabs(std::sin(th));
  const float fit = extent * sin_th * 0.5f * c.focal * 1.15f;   // 1.15 = margin
  const float r = (fit > pivot_z ? fit : pivot_z) *
                  (s.side_dolly < 0.05f ? 0.05f : s.side_dolly);

  c.pos[0] = std::sin(th) * -r;
  c.pos[1] = 0.0f;
  c.pos[2] = pivot_z - std::cos(th) * r;
  c.ct = std::cos(th);
  c.st = std::sin(th);
  return c;
}

/// World point -> this camera's screen position, in cover-square coords.
/// Returns false when the point is at or behind the near plane.
static bool project(const Camera& c, float wx, float wy, float wz,
                    float& sx, float& sy) {
  // Into camera space: translate, then yaw by -theta.
  const float dx = wx - c.pos[0];
  const float dy = wy - c.pos[1];
  const float dz = wz - c.pos[2];
  const float ex =  dx * c.ct - dz * c.st;
  const float ez =  dx * c.st + dz * c.ct;
  if (ez <= kNearPlane) return false;
  sx = c.focal * ex / ez;
  // Cover-square y grows DOWNWARD, hence the negation.
  sy = -c.focal * dy / ez;
  return true;
}

/// Project one quad through one camera. False means "not visible in this view",
/// which the caller turns into a dark quad rather than a garbage one.
static bool projectQuad(const Camera& c, float half, float z, float out[4][2]) {
  const float cx[4] = {-half, +half, +half, -half};
  const float cy[4] = {-half, -half, +half, +half};
  for (int k = 0; k < 4; k++) {
    if (!project(c, cx[k], cy[k], z, out[k][0], out[k][1])) return false;
  }
  return true;
}

// --- Schema ---------------------------------------------------------------

void module_init() {
  state::init("source.mesh.three_walls", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Three Walls\n"
        "Three neon frames rushing at you down a tunnel. The companion to "
        "**Three Planes** — same look, pointed the other way. Where that one "
        "stacks upward and reads as a level, this one comes out of the screen "
        "and reads as a hit.\n\n"
        "It is quiet until you fire a **move**. *Pulse* throws the three "
        "frames at you one after another. The other three are held: they run "
        "for as long as you hold the trigger and speed up the whole time.\n\n"
        "It has **three outputs**, and they are three cameras on the same "
        "tunnel — the main one looks straight down it, and the two extras "
        "watch it from either side. A pulse that fills the main frame is the "
        "same instant a bar sweeping across the side views, which is what "
        "sells it as something you are passing through. Wire the extras only "
        "if you want them; unconnected, they cost nothing.\n\n"
        "**Try:** hold *Resonate* and watch it climb past the frame rate — "
        "past a point it stops reading as motion and starts strobing into "
        "standing patterns. That is the move doing its job.")

      // ---------------- Moves ----------------
      .group("moves", "Moves")
        .groupHelp(
          "Four ways to send the frames down the tunnel. Only one runs at a "
          "time: firing another drops whatever was going, where it stood.\n\n"
          "**Pulse** is a one-shot — it plays out and stops. The other three "
          "are **held**: they run while the trigger is high and their rate "
          "ramps the whole time, so how long you hold is the performance.\n\n"
          "*Cycles* runs two frames against each other, one toward you and one "
          "away, on separate rate curves so they drift in and out of step. "
          "*Resonate* sends all three at once, evenly spaced, fast enough to "
          "beat against the frame rate. *Resonate Rev* is the same going away.")
      .eventField("pulse", state::PrimaryInput).label("Pulse", "Pulse")
      .eventField("cycles", state::PrimaryInput).label("Cycles", "Cycles")
      .eventField("resonate", state::PrimaryInput).label("Resonate", "Reso")
      .eventField("resonate_rev", state::PrimaryInput).label("Resonate Rev", "Reso R")
      .floatField("ease", 0.5f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.f, nullptr,
                  "Travel shape: 0 straight-line, 0.5 eased, 1 heavily eased.")
        .label("Ease", "Ease")

      .floatField("pulse_time", 0.9f, 0.05f, 6.f, state::SecondaryInput,
                  nullptr, 0.f, "s", "How long one frame takes to cross.")
        .label("Pulse Time", "PlsT")
      .floatField("pulse_stagger", 0.12f, 0.f, 2.f, state::SecondaryInput,
                  nullptr, 0.f, "s", "Gap between the three frames of a pulse.")
        .label("Pulse Stagger", "Stgr")

      .floatField("cycles_f0", 0.4f, 0.f, 30.f, state::SecondaryInput,
                  nullptr, 0.f, "Hz", "Cycles rate at the press.")
        .label("Cycles From", "CycF0")
      .floatField("cycles_f1", 2.6f, 0.f, 30.f, state::SecondaryInput,
                  nullptr, 0.f, "Hz", "Cycles rate at the end of the ramp.")
        .label("Cycles To", "CycF1")
      .floatField("cycles_rev_f0", 0.3f, 0.f, 30.f, state::SecondaryInput,
                  nullptr, 0.f, "Hz",
                  "The reverse frame's own start rate. Keep it different from "
                  "the forward one — two identical opposed ramps beat at a "
                  "fixed rate, which is much less interesting than two that "
                  "drift apart.")
        .label("Cycles Rev From", "RevF0")
      .floatField("cycles_rev_f1", 2.0f, 0.f, 30.f, state::SecondaryInput,
                  nullptr, 0.f, "Hz", "The reverse frame's end rate.")
        .label("Cycles Rev To", "RevF1")
      .floatField("cycles_ramp", 4.0f, 0.1f, 30.f, state::SecondaryInput,
                  nullptr, 0.f, "s", "Seconds to get from the start rate to the end rate.")
        .label("Cycles Ramp", "CycRmp")
      .floatField("cycles_duty", 0.5f, 0.f, 1.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "How much of each round the third frame spends going toward you.")
        .label("Duty", "Duty")
      .floatField("cycles_duty_period", 1.5f, 0.05f, 10.f, state::SecondaryInput,
                  nullptr, 0.f, "s", "One there-and-back round of the duty cycle.")
        .label("Duty Period", "DutyT")

      .floatField("resonate_f0", 2.0f, 0.f, 60.f, state::SecondaryInput,
                  nullptr, 0.f, "Hz", "Resonate rate at the press.")
        .label("Resonate From", "ResF0")
      .floatField("resonate_f1", 14.0f, 0.f, 60.f, state::SecondaryInput,
                  nullptr, 0.f, "Hz",
                  "Resonate rate at the end of the ramp. Past roughly half the "
                  "frame rate this stops reading as motion and starts landing "
                  "on standing patterns — which is the point of the move.")
        .label("Resonate To", "ResF1")
      .floatField("resonate_ramp", 6.0f, 0.1f, 30.f, state::SecondaryInput,
                  nullptr, 0.f, "s", "Seconds to get from the start rate to the end rate.")
        .label("Resonate Ramp", "ResRmp")

      // ---------------- Tunnel ----------------
      .group("tunnel", "Tunnel")
        .groupHelp(
          "The space the frames travel through. *Depth Far* and *Depth Near* "
          "are where they enter and leave; the travel between them is "
          "geometric, so a frame grows at a steady rate rather than crawling "
          "and then lunging.\n\n"
          "*Side Angle* is how far round the two extra cameras sit. At 90 "
          "degrees they see the frames exactly edge-on — infinitely thin, "
          "gone in an instant — so back it off until the frames have real "
          "width as they sweep past.")
      .floatField("quad_size", 0.35f, 0.05f, 2.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How big the frames are in the tunnel. Past about 0.4 the "
                  "nearest one is always beyond the edge of the picture.")
        .label("Frame Size", "Size")
      .floatField("z_far", 6.0f, 0.5f, 40.f, state::SecondaryInput)
        .label("Depth Far", "Far")
      .floatField("z_near", 0.35f, 0.05f, 4.f, state::SecondaryInput)
        .label("Depth Near", "Near")
      .floatField("fov", 55.f, 10.f, 120.f, state::SecondaryInput,
                  nullptr, 0.f, "deg")
        .label("Field of View", "FOV")
      .floatField("side_angle", 55.f, 0.f, 90.f, state::PrimaryInput,
                  nullptr, 0.f, "deg",
                  "How far round the side cameras sit. 90 is exactly edge-on, "
                  "where the frames vanish to nothing.")
        .label("Side Angle", "Side")
      .floatField("side_dolly", 1.0f, 0.2f, 4.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "How far back the side cameras stand off.")
        .label("Side Distance", "SideD")

      // ---------------- Quads ----------------
      .group("quads", "Frames")
        .groupHelp(
          "The three frames. Their colours default to Three Planes' own, so "
          "the two cards look like they belong in the same piece.\n\n"
          "*Fill* is signed: positive floods the frame with its own colour, "
          "negative turns it into a black body that eats the glow of anything "
          "behind it while keeping its own outline.")
      .rgbField("quad1_color", 1.00f, 0.22f, 0.62f, state::SecondaryInput)
        .label("Frame 1 Colour", "C1")
      .floatField("quad1_emission", 0.85f, 0.f, 1.f, state::SecondaryInput)
        .label("Frame 1 Emission", "E1")
      .floatField("quad1_fill", 0.0f, -1.f, 1.f, state::SecondaryInput, "signed")
        .label("Frame 1 Fill", "F1")
      .rgbField("quad2_color", 0.72f, 0.35f, 1.00f, state::SecondaryInput)
        .label("Frame 2 Colour", "C2")
      .floatField("quad2_emission", 0.85f, 0.f, 1.f, state::SecondaryInput)
        .label("Frame 2 Emission", "E2")
      .floatField("quad2_fill", 0.0f, -1.f, 1.f, state::SecondaryInput, "signed")
        .label("Frame 2 Fill", "F2")
      .rgbField("quad3_color", 0.30f, 0.85f, 1.00f, state::SecondaryInput)
        .label("Frame 3 Colour", "C3")
      .floatField("quad3_emission", 0.85f, 0.f, 1.f, state::SecondaryInput)
        .label("Frame 3 Emission", "E3")
      .floatField("quad3_fill", 0.0f, -1.f, 1.f, state::SecondaryInput, "signed")
        .label("Frame 3 Fill", "F3")

      // ---------------- Neon ----------------
      .group("neon", "Neon")
        .groupHelp(
          "The tube itself, shared with Three Planes so a look moves between "
          "the two cards. *Core Whiten* is what makes it read as neon at all: "
          "real neon photographs blows its core to white and keeps the hue "
          "only out in the halo.")
      .floatField("line_width", 0.18f, 0.f, 1.f, state::PrimaryInput)
        .label("Line Width", "Width")
      .floatField("line_gain", 1.60f, 0.f, 4.f, state::PrimaryInput)
        .label("Line Gain", "Line G")
      .floatField("core_whiten", 0.85f, 0.f, 1.f, state::SecondaryInput)
        .label("Core Whiten", "Whiten")
      .floatField("halo_radius", 0.30f, 0.f, 1.f, state::PrimaryInput)
        .label("Halo Radius", "Halo R")
      .floatField("halo_gain", 0.55f, 0.f, 3.f, state::PrimaryInput)
        .label("Halo Gain", "Halo G")
      .floatField("halo_falloff", 0.45f, 0.f, 1.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr, "0 = tight and punchy, 1 = wide and soft.")
        .label("Halo Falloff", "Fall")
      .floatField("halo_smooth", 0.35f, 0.f, 1.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "Rounds the corner creases just outside the outline, as a "
                  "fraction of the halo radius. 0 shows the raw ridge.")
        .label("Halo Smoothing", "Smooth")
      .floatField("corner_radius", 0.012f, 0.f, 0.25f, state::SecondaryInput)
        .label("Corner Radius", "Corner")
      .floatField("fill_gain", 0.22f, 0.f, 2.f, state::SecondaryInput)
        .label("Fill Gain", "Fill G")

      // ---------------- Grade ----------------
      .group("grade", "Warmth & Dehancement")
        .groupHelp(
          "The analogue tail, shared verbatim with Three Planes. *Chroma "
          "Bleed* splits R/G/B horizontally the way a tape transport does — "
          "exact here, because the whole stack is re-evaluated at three "
          "offsets rather than blurred.")
      .floatField("chroma_bleed", 0.25f, 0.f, 1.f, state::PrimaryInput)
        .label("Chroma Bleed", "Chroma")
      .floatField("warmth", 0.35f, -1.f, 1.f, state::PrimaryInput, "signed")
        .label("Warmth", "Warm")
      .floatField("drive", 0.35f, 0.f, 1.f, state::PrimaryInput)
        .label("Drive", "Drive")
      .floatField("exposure", 1.0f, 0.f, 2.f, state::PrimaryInput)
        .label("Exposure", "Expo")
      .floatField("asymmetry", 0.20f, -1.f, 1.f, state::SecondaryInput, "signed")
        .label("Asymmetry", "Asym")
      .floatField("toe", 0.25f, 0.f, 1.f, state::SecondaryInput)
        .label("Toe", "Toe")
      .floatField("shoulder", 0.50f, 0.f, 1.f, state::SecondaryInput)
        .label("Shoulder", "Shldr")
      .floatField("highlight_desat", 0.70f, 0.f, 1.f, state::SecondaryInput)
        .label("Highlight Desat", "HiDesat")
      .rgbField("highlight_tint", 1.00f, 0.22f, 0.62f, state::SecondaryInput)
        .label("Highlight Tint", "Hi Tint")
      .floatField("highlight_tint_amount", 0.0f, 0.f, 1.f, state::PrimaryInput)
        .label("Highlight Tint Amount", "Tint Amt")
      .floatField("highlight_tint_pivot", 1.0f, 0.2f, 4.f, state::SecondaryInput)
        .label("Tint Pivot", "Pivot")
      .floatField("scanline", 0.12f, 0.f, 1.f, state::SecondaryInput)
        .label("Scanlines", "Scan")
      .intField("scanline_count", 240, 30, 720, state::SecondaryInput, 0, "lines")
        .label("Scanline Count", "Lines")
      .floatField("grain", 0.08f, 0.f, 1.f, state::SecondaryInput)
        .label("Grain", "Grain")
      .floatField("input_opacity", 1.0f, 0.f, 1.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "How much of the incoming image survives under the stack.")
        .label("Input Opacity", "In Op")

      // ---------------- Debug ----------------
      .group("debug", "Debug")
      .boolField("debug_show_quads", false, state::SecondaryInput,
                 "Flat per-frame keys, no glow or grade — check the projection "
                 "and the near-plane culling on their own.")
        .label("Show Frame Keys", "Keys")

      // ---------------- Outputs ----------------
      // Declared min/max IS the modulation contract for these rails.
      .floatField("depth1", 0.f, 0.f, 1.f, state::PrimaryOutput, "unsigned",
                  0.f, nullptr, "Frame 1's travel, 0 at the far end and 1 at the near.")
        .label("Frame 1 Depth", "D1")
      .floatField("depth2", 0.f, 0.f, 1.f, state::SecondaryOutput, "unsigned",
                  0.f, nullptr, "Frame 2's travel, 0 at the far end and 1 at the near.")
        .label("Frame 2 Depth", "D2")
      .floatField("depth3", 0.f, 0.f, 1.f, state::SecondaryOutput, "unsigned",
                  0.f, nullptr, "Frame 3's travel, 0 at the far end and 1 at the near.")
        .label("Frame 3 Depth", "D3")
      .floatField("move_rate", 0.f, 0.f, 60.f, state::SecondaryOutput, "unsigned",
                  0.f, "Hz", "The cycling rate right now; 0 when nothing is cycling.")
        .label("Move Rate", "Rate")

      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      // The two extra cameras. Effect-owned, and dispatched only when wired —
      // see the note at the top of the file.
      .textureField("left_out",  state::SecondaryOutput)
      .textureField("right_out", state::SecondaryOutput)

      .capability(state::Capability::Generator)
      // NOT TimeIndependent, unlike three_planes: every move here is an
      // accumulator, so a frame is not a pure function of the current inputs
      // and this cannot be seeked.
      .capability(state::Capability::ModulationSource)
      .capability(state::Capability::ModulationSourceMulti)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("three_walls_render", RENDER_SPV, RENDER_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("three_walls_render");
  if (!cs) return;

  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1)
      .uniform(2));

  state::log("three_walls: module initialized");
}

void* create() {
  auto* s = new State();
  for (int v = 0; v < VIEWS; v++)
    s->uniform_buf[v] = gpu::Device::createBuffer(sizeof(Uniforms),
                                                  gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int v = 0; v < VIEWS; v++) s->uniform_buf[v].release();
  for (int i = 0; i < 2; i++) s->aux_tex[i].release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->core.reset();
  if (!s_pso.valid() || !s->uniform_buf[0].valid()) return;
  s->initialized = true;
}

// --- Publishing -----------------------------------------------------------

static void publish(const char* name, float value) {
  auto vh = val::number(value);
  state::setValPath(name, vh);
  val::release(vh);
}

/// The travel rails, 0 at the far end and 1 at the near. Published from tick()
/// so taps read THIS frame's value before it is consumed.
static void publishRails(const State& s) {
  publish("depth1", s.frame.phase[0]);
  publish("depth2", s.frame.phase[1]);
  publish("depth3", s.frame.phase[2]);
  publish("move_rate", s.frame.rate);
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  // A move armed by a patch starts HERE, so it always sees the knobs that
  // arrived with it. Release first, then press: a press in the same transaction
  // as somebody else's release must win.
  if (s->pending_release != show::MoveNone) {
    s->core.release(s->pending_release);
    s->pending_release = show::MoveNone;
  }
  if (s->pending_press != show::MoveNone) {
    s->core.trigger(s->pending_press);
    s->pending_press = show::MoveNone;
  }

  s->frame = s->core.tick(s->show_p, static_cast<float>(dt));
  publishRails(*s);
}

// --- Render ---------------------------------------------------------------

/// Fill the uniform block for one camera. `quad_order` is near-to-far, so a
/// masking frame in front eats the glow of the ones behind it.
static void fillUniforms(State* s, const Camera& cam, int vp_w, int vp_h,
                         Uniforms& u) {
  const auto cs = fx::coverSquare(vp_w, vp_h);
  const float half = s->quad_size;

  // Sort near-to-far for THIS view. Three items, so a hand-rolled insertion
  // sort is smaller and clearer than pulling in <algorithm>.
  int order[QUADS] = {0, 1, 2};
  for (int i = 1; i < QUADS; i++) {
    const int key = order[i];
    int j = i - 1;
    while (j >= 0 && s->frame.z[order[j]] > s->frame.z[key]) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = key;
  }

  for (int slot = 0; slot < QUADS; slot++) {
    const int q = order[slot];
    float pts[4][2] = {};
    const bool visible = s->frame.live[q] &&
                         projectQuad(cam, half, s->frame.z[q], pts);

    // Rows 2*slot and 2*slot+1: (c0.xy, c1.zw) then (c2.xy, c3.zw).
    u.corners[slot * 2 + 0][0] = pts[0][0];
    u.corners[slot * 2 + 0][1] = pts[0][1];
    u.corners[slot * 2 + 0][2] = pts[1][0];
    u.corners[slot * 2 + 0][3] = pts[1][1];
    u.corners[slot * 2 + 1][0] = pts[2][0];
    u.corners[slot * 2 + 1][1] = pts[2][1];
    u.corners[slot * 2 + 1][2] = pts[3][0];
    u.corners[slot * 2 + 1][3] = pts[3][1];

    u.quad_color[slot][0] = s->color[q][0];
    u.quad_color[slot][1] = s->color[q][1];
    u.quad_color[slot][2] = s->color[q][2];
    // A culled or unlit frame goes dark rather than being skipped: the loop is
    // unrolled over a fixed three, and zero emission costs the same as a branch.
    u.quad_color[slot][3] = visible ? emissionDrive(s->emission[q]) : 0.0f;
    u.fills[slot] = visible ? s->fill[q] : 0.0f;
  }
  u.fills[3] = 0.0f;

  const float px = 2.0f / float(vp_w > vp_h ? vp_w : vp_h);

  u.misc[0] = s->chroma_bleed;
  u.misc[1] = s->input_opacity;
  u.misc[2] = s->debug_show_quads ? 1.0f : 0.0f;
  u.misc[3] = 0.0f;

  u.view[0] = float(vp_w);
  u.view[1] = float(vp_h);
  u.view[2] = cs.ax;
  u.view[3] = cs.ay;

  u.style[0]  = lineHalfWidth(s->line_width);
  u.style[1]  = s->line_gain;
  u.style[2]  = s->core_whiten;
  u.style[3]  = haloRadius(s->halo_radius);
  u.style[4]  = s->halo_gain;
  u.style[5]  = s->halo_falloff;
  u.style[6]  = s->corner_radius;
  u.style[7]  = px * 1.2f;
  u.style[8]  = s->fill_gain;
  u.style[9]  = s->halo_smooth;
  u.style[10] = 0.0f;
  u.style[11] = 0.0f;

  u.grade[0]  = s->exposure;
  u.grade[1]  = s->warmth;
  u.grade[2]  = s->drive;
  u.grade[3]  = s->asymmetry;
  u.grade[4]  = s->toe;
  u.grade[5]  = s->shoulder;
  u.grade[6]  = s->highlight_desat;
  u.grade[7]  = s->scanline;
  u.grade[8]  = float(s->scanline_count);
  u.grade[9]  = s->grain;
  u.grade[10] = float(std::fmod(host::time() * 997.0, 4096.0));
  u.grade[11] = s->highlight_tint_pivot;
  u.grade[12] = s->highlight_tint[0];
  u.grade[13] = s->highlight_tint[1];
  u.grade[14] = s->highlight_tint[2];
  u.grade[15] = s->highlight_tint_amount;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  static const char* const kAuxField[2] = {"left_out", "right_out"};

  for (int v = 0; v < VIEWS; v++) {
    gpu::Texture target = out;
    if (v > 0) {
      const int a = v - 1;
      // Nothing downstream, nothing drawn. The aux views are the only optional
      // work here and they are a full-viewport dispatch each.
      if (!state::isOutputConnected(kAuxField[a])) continue;
      if (!s->aux_tex[a].valid() || s->aux_w[a] != vp_w || s->aux_h[a] != vp_h) {
        s->aux_tex[a].release();
        s->aux_tex[a] = gpu::Device::createTexture(vp_w, vp_h);
        s->aux_w[a] = vp_w;
        s->aux_h[a] = vp_h;
        if (!s->aux_tex[a].valid()) continue;
        // Publish on ALLOCATION only — the executor never clears an output
        // handle, so it persists across frames.
        state::setGpuTexture(kAuxField[a], s->aux_tex[a].id);
      }
      target = s->aux_tex[a];
    }

    Uniforms u = {};
    fillUniforms(s, makeCamera(*s, v), vp_w, vp_h, u);
    s->uniform_buf[v].writeOne(u);

    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso);
    cp.setTexture(in, 0, 0);
    cp.setTexture(target, 1, 1);
    cp.setBuffer(s->uniform_buf[v], 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

// --- Patch decode ---------------------------------------------------------

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  static const char* const kMoveField[show::kMoveCount] = {
      "pulse", "cycles", "resonate", "resonate_rev"};

  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];

    // The four move triggers. EDGES ONLY — the executor replays every stored
    // value as a PatchReplace each frame, so acting on arrival would re-arm
    // forever (style guide 8.2). Rising presses; falling releases a gate.
    {
      bool matched = false;
      for (int m = 0; m < show::kMoveCount; m++) {
        if (!state::pathIs(p, l, kMoveField[m])) continue;
        const bool t = state::patchEvent(i);
        if (t && !s->move_prev[m]) s->pending_press = m;
        else if (!t && s->move_prev[m] && show::isGate(m)) s->pending_release = m;
        s->move_prev[m] = t;
        matched = true;
        break;
      }
      if (matched) continue;
    }

    // "quad<k>_color" / "_emission" / "_fill", matched by shape.
    if (l > 6 && std::memcmp(p, "quad", 4) == 0 && p[5] == '_') {
      const int k = p[4] - '1';
      if (k >= 0 && k < QUADS) {
        const char* tail = p + 6;
        const int tl = l - 6;
        if (tl == 5 && std::memcmp(tail, "color", 5) == 0) {
          auto v = state::patchVec3(i);
          s->color[k][0] = v.x; s->color[k][1] = v.y; s->color[k][2] = v.z;
          continue;
        }
        if (tl == 8 && std::memcmp(tail, "emission", 8) == 0) {
          s->emission[k] = state::patchFloat(i);
          continue;
        }
        if (tl == 4 && std::memcmp(tail, "fill", 4) == 0) {
          s->fill[k] = state::patchFloat(i);
          continue;
        }
      }
    }

    if      (state::pathIs(p, l, "ease"))          s->show_p.ease = state::patchFloat(i);
    else if (state::pathIs(p, l, "pulse_time"))    s->show_p.pulse_time = state::patchFloat(i);
    else if (state::pathIs(p, l, "pulse_stagger")) s->show_p.pulse_stagger = state::patchFloat(i);
    else if (state::pathIs(p, l, "cycles_f0"))     s->show_p.cycles_f0 = state::patchFloat(i);
    else if (state::pathIs(p, l, "cycles_f1"))     s->show_p.cycles_f1 = state::patchFloat(i);
    else if (state::pathIs(p, l, "cycles_rev_f0")) s->show_p.cycles_rev_f0 = state::patchFloat(i);
    else if (state::pathIs(p, l, "cycles_rev_f1")) s->show_p.cycles_rev_f1 = state::patchFloat(i);
    else if (state::pathIs(p, l, "cycles_ramp"))   s->show_p.cycles_ramp = state::patchFloat(i);
    else if (state::pathIs(p, l, "cycles_duty"))   s->show_p.cycles_duty = state::patchFloat(i);
    else if (state::pathIs(p, l, "cycles_duty_period")) s->show_p.cycles_duty_period = state::patchFloat(i);
    else if (state::pathIs(p, l, "resonate_f0"))   s->show_p.resonate_f0 = state::patchFloat(i);
    else if (state::pathIs(p, l, "resonate_f1"))   s->show_p.resonate_f1 = state::patchFloat(i);
    else if (state::pathIs(p, l, "resonate_ramp")) s->show_p.resonate_ramp = state::patchFloat(i);
    else if (state::pathIs(p, l, "z_far"))         s->show_p.z_far = state::patchFloat(i);
    else if (state::pathIs(p, l, "z_near"))        s->show_p.z_near = state::patchFloat(i);
    else if (state::pathIs(p, l, "quad_size"))     s->quad_size = state::patchFloat(i);
    else if (state::pathIs(p, l, "fov"))           s->fov_deg = state::patchFloat(i);
    else if (state::pathIs(p, l, "side_angle"))    s->side_angle_deg = state::patchFloat(i);
    else if (state::pathIs(p, l, "side_dolly"))    s->side_dolly = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_width"))    s->line_width = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_gain"))     s->line_gain = state::patchFloat(i);
    else if (state::pathIs(p, l, "core_whiten"))   s->core_whiten = state::patchFloat(i);
    else if (state::pathIs(p, l, "halo_radius"))   s->halo_radius = state::patchFloat(i);
    else if (state::pathIs(p, l, "halo_gain"))     s->halo_gain = state::patchFloat(i);
    else if (state::pathIs(p, l, "halo_falloff"))  s->halo_falloff = state::patchFloat(i);
    else if (state::pathIs(p, l, "halo_smooth"))   s->halo_smooth = state::patchFloat(i);
    else if (state::pathIs(p, l, "corner_radius")) s->corner_radius = state::patchFloat(i);
    else if (state::pathIs(p, l, "fill_gain"))     s->fill_gain = state::patchFloat(i);
    else if (state::pathIs(p, l, "chroma_bleed"))  s->chroma_bleed = state::patchFloat(i);
    else if (state::pathIs(p, l, "warmth"))        s->warmth = state::patchFloat(i);
    else if (state::pathIs(p, l, "drive"))         s->drive = state::patchFloat(i);
    else if (state::pathIs(p, l, "exposure"))      s->exposure = state::patchFloat(i);
    else if (state::pathIs(p, l, "asymmetry"))     s->asymmetry = state::patchFloat(i);
    else if (state::pathIs(p, l, "toe"))           s->toe = state::patchFloat(i);
    else if (state::pathIs(p, l, "shoulder"))      s->shoulder = state::patchFloat(i);
    else if (state::pathIs(p, l, "highlight_desat")) s->highlight_desat = state::patchFloat(i);
    else if (state::pathIs(p, l, "highlight_tint")) {
      auto v = state::patchVec3(i);
      s->highlight_tint[0] = v.x; s->highlight_tint[1] = v.y; s->highlight_tint[2] = v.z;
    }
    else if (state::pathIs(p, l, "highlight_tint_amount")) s->highlight_tint_amount = state::patchFloat(i);
    else if (state::pathIs(p, l, "highlight_tint_pivot"))  s->highlight_tint_pivot = state::patchFloat(i);
    else if (state::pathIs(p, l, "scanline"))       s->scanline = state::patchFloat(i);
    else if (state::pathIs(p, l, "scanline_count")) s->scanline_count = state::patchInt(i);
    else if (state::pathIs(p, l, "grain"))          s->grain = state::patchFloat(i);
    else if (state::pathIs(p, l, "input_opacity"))  s->input_opacity = state::patchFloat(i);
    else if (state::pathIs(p, l, "debug_show_quads")) s->debug_show_quads = state::patchBool(i);
  }
}

}  // namespace three_walls
