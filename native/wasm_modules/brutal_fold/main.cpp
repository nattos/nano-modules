/*
 * source.brutal_fold — brutalist axonometric-prism generator.
 *
 * Productionized from the brutal-fold research testbed. A baked control surface
 * — axes complexity (x) × order (y) × liveliness (z), with a co-folded second
 * structure — is interpolated on the CPU each frame (build_params) down to two
 * structures' worth of "terms" + scene scalars; those ride in a uniform buffer
 * and the GPU composites the receding prism layers from them. The atlas itself
 * never touches the GPU (it's CPU-only constant data in brutal_fold_atlas.h).
 *
 * The field is an algebraic occupancy field rendered as solid axonometric
 * (oblique-depth) prisms — "3D without a vanishing point" — in grayscale, with
 * fog fading distant receding layers toward the light sky tone. The solid
 * threshold (`level`) is resolved on the CPU (a coarse occupancy min/max scan)
 * so the GPU work is a SINGLE present compute pass (no auto-levels) — a port of
 * the prototype's field.ts build + shader.wgsl composite.
 *
 * Animation is a seamless bounded loop: integer temporal frequencies return to
 * their t=0 value at t=1, so the loop closes at any speed. Speeds map [0,1]
 * through a QUADRATIC bend onto a deliberately low actual max — the effect reads
 * best very slow. An optional autopilot spirals the (x,y) automatically and
 * broadcasts its live position (autopilot_x/y) without mutating the inputs.
 *
 * GPU passes (one submit): present only. Generator → only tex_out, no tex_in.
 * Internal time/orbit clock → NOT is_identity.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include "brutal_fold_shaders.h"
#include "brutal_fold_atlas.h"

#include <cmath>
#include <cstdint>
#include <algorithm>

namespace brutal_fold {

static constexpr float kPi = 3.14159265358979323846f;
static constexpr float kTau = 6.28318530717958647692f;

// Parameter-buffer layout (mirrors field.ts): per structure,
// [ terms (NT*8) | scene (SCN) | level ]. Two structures sit back to back.
static constexpr int SB1 = BF_NTERMS * 8;   // scene base within a structure (48)
static constexpr int SCN = 19;              // scene scalar count (matches SCENE_FIELDS)
static constexpr int STR = SB1 + SCN + 1;   // per-structure stride incl. level (68)
static_assert(2 * STR <= 256, "P buffer (both structures) must fit in 256 floats");

// Scene scalar positions WITHIN a structure's scene block — order MUST match
// atlas.ts SCENE and the present shader's offsets.
enum Scene {
  S_SEV = 0, S_GX, S_GY, S_FORM_SCALE, S_THRESH, S_BACK_LEN, S_BACK_ANG, S_EXTRUDE,
  S_LAYERS, S_SEP, S_FRONT_DETAIL, S_WIN_DARK, S_FOG, S_FACE, S_SKY_VAL, S_DC,
  S_BOLD_GAIN, S_ROT, S_SLEW,
};

// Atlas accessor tables (the baked flat arrays, ordered to match the loops).
static const float* const TERM_A[8] = {
  BF_THETA, BF_MTHETA, BF_SHEAR, BF_FREQ, BF_PHASE, BF_H, BF_AMP, BF_MIX };
static const float* const B_TERM_A[8] = {
  BF_B_THETA, BF_B_MTHETA, BF_B_SHEAR, BF_B_FREQ, BF_B_PHASE, BF_B_H, BF_B_AMP, BF_B_MIX };
static const float* const SCENE_A[SCN] = {
  BF_SEV, BF_GX, BF_GY, BF_FORM_SCALE, BF_THRESH, BF_BACK_LEN, BF_BACK_ANG, BF_EXTRUDE,
  BF_LAYERS, BF_SEP, BF_FRONT_DETAIL, BF_WIN_DARK, BF_FOG, BF_FACE, BF_SKY_VAL, BF_DC,
  BF_BOLD_GAIN, BF_ROT, BF_SLEW };
static const float* const B_SCENE_A[SCN] = {
  BF_B_SEV, BF_B_GX, BF_B_GY, BF_B_FORM_SCALE, BF_B_THRESH, BF_B_BACK_LEN, BF_B_BACK_ANG, BF_B_EXTRUDE,
  BF_B_LAYERS, BF_B_SEP, BF_B_FRONT_DETAIL, BF_B_WIN_DARK, BF_B_FOG, BF_B_FACE, BF_B_SKY_VAL, BF_B_DC,
  BF_B_BOLD_GAIN, BF_B_ROT, BF_B_SLEW };
// Animation script channels (structure 1 only): h_amp, h_om, h_psi, phase_drift.
static const float* const SCRIPT_A[4] = { BF_H_AMP, BF_H_OM, BF_H_PSI, BF_PHASE_DRIFT };

// Speed mapping: [0,1] squared onto a low actual max (the effect reads best slow).
static constexpr float kTimeMax = 1.0f;    // loops/sec at time_speed=1 (~1 s min loop)
static constexpr float kApMin = 0.05f;     // orbit rad/sec floor
static constexpr float kApMax = 0.6f;      // orbit rad/sec at ap_speed=1
static constexpr float kScrollCells = 1.0f; // structure-2 integer cells scrolled per loop

// Drift: a bounded second-order random walk (the velocity random-walks; a spring
// + damping keep it mean-reverting and bounded; a hard reflect at ±range is the
// final guard). drift_speed scales the whole evolution rate. Smooth (C1) — no
// twitch-style per-frame discontinuity. Tuned by eye.
static constexpr float kDriftSigma  = 3.5f;   // velocity kick magnitude
static constexpr float kDriftSpring = 1.6f;   // mean-reversion toward 0 (weak → wanders wide)
static constexpr float kDriftDamp   = 0.93f;  // per-step velocity damping
static constexpr float kDriftRate   = 1.6f;   // base loops of evolution / sec
static constexpr float kDriftMaxSpeed = 2.5f; // drift_speed=1 → this rate multiplier
// Depth is a sensitive axis (a thin Z window shifts visibly), so its drift gets an
// extra low-pass (one-pole EMA) on top of the walk to keep it gliding, not jumping.
static constexpr float kDepthDriftSmoothRate = 3.0f;  // ~0.33 s time constant

// The blob's radius/softness/depth sliders are normalized 0..1 (default 0.5);
// these map them onto the shader's actual ranges.
static constexpr float kVolRadiusMax = 2.0f;   // radius      slider 1 → 2.0
static constexpr float kVolSoftXYMax = 2.0f;   // softness_xy slider 1 → 2.0
static constexpr float kVolSoftZMax  = 1.0f;   // softness_z  slider 1 → 1.0
static constexpr float kVolDepthMax  = 0.6f;   // depth       slider 1 → 0.6 (Z half-extent)

// Autopilot epicycle constants (verbatim from the shape_fold autopilot). Two
// summed circular motions, 90° out of phase, incommensurate rates → sweeps the
// annulus without stalling at the centre.
static constexpr float kApA = 0.29f, kApB = 0.16f, kApW2 = 0.382f, kApPhi = kPi * 0.5f;
static constexpr float kGoldenAngle = 2.39996323f;

// Uniform block — mirrors cbuffer U in common.hlsl. 4 std140 rows of scalars,
// then the packed parameter array P (both structures).
struct Uniforms {
  float res_x, res_y, n_terms, sb;
  float str, tilt, enable2, h_act;
  float diff_hue_lo, diff_hue_mid, diff_hue_hi, diff_sat;
  float diff_sat_lo, diff_sat_mid, diff_sat_hi, _dpad0;
  float diff_bri_lo, diff_bri_mid, diff_bri_hi, _dpad1;
  float fog_hue_lo, fog_hue_mid, fog_hue_hi, fog_sat;
  float fog_sat_lo, fog_sat_mid, fog_sat_hi, _fpad0;
  float sky_hue, sky_sat, sky_bri, _spad0;
  float noise_blob, noise_fog, noise_seed, noise_blob_tilt;
  // Volumetric fog (DRIFTED/effective values written each frame).
  float vol_amount, vol_anchor_x, vol_anchor_y, vol_z;
  float vol_shape, vol_angle, vol_radius, vol_softness_xy;
  float vol_depth, vol_softness_z, _vpad1, _vpad2;
  float P[256];
};
static_assert(sizeof(Uniforms) == (48 + 256) * 4, "Uniforms layout");

struct State {
  gpu::Buffer uniform_buf;
  bool initialized = false;

  // --- Schema-mirrored params ---
  float complexity        = 0.6f;   // atlas x
  float order             = 0.6f;   // atlas y
  float liveliness        = 1.0f;   // atlas z (temporal layer): 0 still → 1 lively
  float scale             = 1.0f;   // form zoom; higher = zoom IN (inverted in build)
  float balance           = 0.0f;   // signed: zoom S1 in as S2 out
  float extrude           = 1.0f;   // recession depth multiplier
  bool  second_structure  = true;   // enable the co-folded S2 layer
  bool  interp_cells      = true;   // bilinear-blend atlas cells
  float time_speed        = 0.5f;   // [0,1] quadratic → loops/sec (default ≈ 4 s loop)
  float ease              = 0.0f;   // time-warp: rest at loop point, surge through middle
  float anim_amount       = 1.0f;   // in/out (birth) oscillation amplitude
  float fog               = 1.0f;   // fog strength multiplier
  // --- Colour grade: 3-control-point tone→hue twist (diffuse over panel tone,
  //     fog over depth). sat=0 → grayscale passthrough. Defaults are a teal-shadow
  //     / warm-highlight split for diffuse and a cool→deep-blue fog. ---
  float diff_hue_lo       = 0.58f;
  float diff_hue_mid      = 0.08f;
  float diff_hue_hi       = 0.11f;
  float diff_sat          = 0.0f;   // overall strength
  float diff_sat_lo       = 1.0f;   // per-knot saturation (shadows/mids/highs)
  float diff_sat_mid      = 1.0f;
  float diff_sat_hi       = 1.0f;
  float diff_bri_lo       = 1.0f;   // per-knot brightness (shadows/mids/highs)
  float diff_bri_mid      = 1.0f;
  float diff_bri_hi       = 1.0f;
  float fog_hue_lo        = 0.55f;
  float fog_hue_mid       = 0.60f;
  float fog_hue_hi        = 0.66f;
  float fog_sat           = 0.0f;   // overall tint
  float fog_sat_lo        = 1.0f;   // per-knot saturation (near/mid/far)
  float fog_sat_mid       = 1.0f;
  float fog_sat_hi        = 1.0f;
  float sky_hue           = 0.0f;   // sky twist (relative to far): hue offset
  float sky_sat           = 0.0f;   // added saturation
  float sky_bri           = 1.0f;   // brightness scale
  float noise_blob        = 0.0f;   // TV static on the blob density
  float noise_blob_tilt   = 0.0f;   // +1 → static on the transparent halo, -1 → dense centre
  float noise_fog         = 0.0f;   // TV static on the distance fog
  float noise_speed       = 0.5f;   // reroll rate (global): 0 = frozen, 1 ≈ 30 Hz
  float noise_phase       = 0.0f;   // accumulator → floor() is the reroll frame id
  // --- Volumetric fog: a 3D "shape" blob (twitch-style) modulating the fog.
  //     vol_amount=0 → uniform depth fog (backward compatible). ---
  float vol_amount        = 0.0f;   // blend uniform depth fog → blob density
  float vol_anchor_x      = 0.0f;   // blob centre X (cover-square)
  float vol_anchor_y      = 0.0f;   // blob centre Y
  float vol_z             = 0.5f;   // blob Z ANCHOR [0,1]
  float vol_shape         = 1.0f;   // bipolar: |1| sphere → |0.5| slab → |0| solid
  float vol_angle         = 0.0f;   // turns; slab normal sweeps X ↔ depth-plane
  float vol_radius        = 0.5f;   // normalized 0..1 (× kVolRadiusMax)
  float vol_softness_xy    = 0.5f;  // normalized 0..1 (× kVolSoftXYMax) — screen edge
  float vol_softness_z     = 0.5f;  // normalized 0..1 (× kVolSoftZMax)  — depth edge
  float vol_depth         = 0.5f;   // normalized 0..1 (× kVolDepthMax); small = selective slice
  // Drift amounts (bounded 2nd-order random walk on each), + overall speed.
  float drift_xy          = 0.0f;
  float drift_z           = 0.0f;
  float drift_shape       = 0.0f;
  float drift_angle       = 0.0f;
  float drift_speed       = 0.3f;
  bool  autopilot         = false;
  float ap_speed          = 0.43f;  // [0,1] cubic → orbit rad/sec
  bool  ap_snap           = false;
  float ap_hold_period    = 2.0f;   // seconds; 0 = no auto-jump (trigger only)
  float ap_hold_jitter    = 0.0f;   // 0..1 → randomize each hold interval ±fraction

  // --- Internal clocks (advanced in tick) ---
  float clock_t    = 0.0f;          // loop phase 0..1
  float orbit      = 0.0f;          // autopilot epicycle phase
  float snap_accum = 0.0f;          // snap-mode hold timer
  float next_hold  = 0.0f;          // jittered target for the current interval
  uint32_t rng     = 0x2545F491u;   // per-instance PRNG state (seeded in create)
  bool  held_valid = false;
  float held_x = 0.6f, held_y = 0.6f;
  float eff_x = 0.6f, eff_y = 0.6f; // effective XY used for rendering / broadcast
  float ap_jump_prev = 0.0f;        // rising-edge state for the jump trigger
  bool  ap_jump_pending = false;

  // Drift walks: offset (o) + velocity (v) per drifting quantity.
  float dx_o = 0.0f, dx_v = 0.0f;   // anchor x
  float dy_o = 0.0f, dy_v = 0.0f;   // anchor y
  float dz_o = 0.0f, dz_v = 0.0f;   // z
  float dz_smooth = 0.0f;           // extra low-pass on the depth drift
  float dsh_o = 0.0f, dsh_v = 0.0f; // shape
  float dan_o = 0.0f, dan_v = 0.0f; // angle
  // Effective (drifted) blob values — fed to the uniform + broadcast for preview.
  float eff_vol_x = 0.0f, eff_vol_y = 0.0f, eff_vol_z = 0.5f;
  float eff_vol_shape = 1.0f, eff_vol_angle = 0.0f;
};

static void apply_visibility(bool autopilot, bool ap_snap) {
  state::setFieldHidden("ap_speed",       !autopilot);
  state::setFieldHidden("ap_snap",        !autopilot);
  state::setFieldHidden("ap_hold_period", !(autopilot && ap_snap));
  state::setFieldHidden("ap_hold_jitter", !(autopilot && ap_snap));
  state::setFieldHidden("ap_jump",        !(autopilot && ap_snap));
}

// Static (self-less) visibility evaluator — pure over a candidate state.
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops) {
  bool autopilot = false, ap_snap = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "autopilot")) autopilot = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(p, l, "ap_snap"))   ap_snap   = state::patchFloat(i) != 0.0f;
  }
  apply_visibility(autopilot, ap_snap);
}

static void on_state_ready(void* self);

// Type-shared, compiled once in module_init().
static gpu::ComputePSO s_pso_present;

void module_init() {
  state::init("source.brutal_fold", {1, 0, 0},
    state::Schema()
      // --- Shape (the custom XY pad drives complexity + order) ---
      .floatField("complexity", 0.6f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("order", 0.6f, 0.0f, 1.0f, state::PrimaryInput)
      // Liveliness (z): 0 = hold still → 1 = animate as richly as the cell allows.
      .floatField("liveliness", 1.0f, 0.0f, 1.0f, state::PrimaryInput)
      // --- Form ---
      .floatField("scale", 1.0f, 0.3f, 10.0f, state::PrimaryInput)
      // Signed: zoom structure 1 IN as structure 2 zooms OUT (parallax balance).
      .floatField("balance", 0.0f, -1.5f, 1.5f, state::PrimaryInput)
      // Recession depth — how far the prisms extrude back.
      .floatField("extrude", 1.0f, 0.0f, 6.0f, state::PrimaryInput)
      .boolField("second_structure", true, state::PrimaryInput)
      .boolField("interp_cells", true, state::PrimaryInput)
      // --- Animation ---
      // Autoplay clock speed (0 = frozen). [0,1] with a QUADRATIC bend onto a low
      // actual max, so the bottom of the slider is mostly very-slow.
      .floatField("time_speed", 0.5f, 0.0f, 1.0f, state::PrimaryInput)
      // Time-warp (bipolar). τ(t) = t − (ease/2π)·sin(2π t). +1 = rest at the
      // loop point, surge through the middle; 0 = uniform. |ease|≤1 keeps it monotone.
      .floatField("ease", 0.0f, -1.0f, 1.0f, state::PrimaryInput)
      // In/out (birth) oscillation amplitude — how strongly prisms pop in and out.
      .floatField("anim_amount", 1.0f, 0.0f, 2.5f, state::PrimaryInput)
      // --- Atmosphere ---
      .floatField("fog", 1.0f, 0.0f, 5.0f, state::PrimaryInput)
      // --- Colour grade (3-control-point tone→hue twist; sat 0 = grayscale) ---
      // Diffuse: hue at panel shadows / mids / highlights, + tint strength.
      .floatField("diff_hue_lo", 0.58f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("diff_hue_mid", 0.08f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("diff_hue_hi", 0.11f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("diff_sat", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      // Per-knot saturation + brightness (shadows / mids / highs).
      .floatField("diff_sat_lo", 1.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("diff_sat_mid", 1.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("diff_sat_hi", 1.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("diff_bri_lo", 1.0f, 0.0f, 2.0f, state::PrimaryInput)
      .floatField("diff_bri_mid", 1.0f, 0.0f, 2.0f, state::PrimaryInput)
      .floatField("diff_bri_hi", 1.0f, 0.0f, 2.0f, state::PrimaryInput)
      // Fog: hue at near / mid / far depth, + overall tint + per-knot saturation.
      .floatField("fog_hue_lo", 0.55f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("fog_hue_mid", 0.60f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("fog_hue_hi", 0.66f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("fog_sat", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("fog_sat_lo", 1.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("fog_sat_mid", 1.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("fog_sat_hi", 1.0f, 0.0f, 1.0f, state::PrimaryInput)
      // Sky: additional twist on the infinite-distance pixels, relative to far.
      .floatField("sky_hue", 0.0f, -1.0f, 1.0f, state::PrimaryInput)
      .floatField("sky_sat", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("sky_bri", 1.0f, 0.0f, 2.0f, state::PrimaryInput)
      // Stochastic "TV static" grain — separately on the blob and the distance fog.
      .floatField("noise_blob", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("noise_blob_tilt", 0.0f, -1.0f, 1.0f, state::PrimaryInput)
      .floatField("noise_fog", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      // Reroll speed for BOTH statics: 0 = frozen, 1 ≈ 30 Hz.
      .floatField("noise_speed", 0.5f, 0.0f, 1.0f, state::PrimaryInput)
      // --- Volumetric fog: a 3D shape blob modulating the fog (0 = uniform) ---
      .floatField("vol_amount", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("vol_anchor_x", 0.0f, -1.5f, 1.5f, state::PrimaryInput)
      .floatField("vol_anchor_y", 0.0f, -1.5f, 1.5f, state::PrimaryInput)
      .floatField("vol_z", 0.5f, 0.0f, 1.0f, state::PrimaryInput)
      // Bipolar: |1| sphere → |0.5| planar slab → |0| solid; sign flips polarity.
      .floatField("vol_shape", 1.0f, -1.0f, 1.0f, state::PrimaryInput)
      // Turns; rotates the linear band in screen-space (depth is set by vol_depth).
      .floatField("vol_angle", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("vol_radius", 0.5f, 0.0f, 1.0f, state::PrimaryInput)
      // Edge softness, split: screen-space (xy) and depth (z).
      .floatField("vol_softness_xy", 0.5f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("vol_softness_z", 0.5f, 0.0f, 1.0f, state::PrimaryInput)
      // Blob Z extent: small = very selective (a thin depth slice), large = spans
      // many depths. (vol_z is the Z anchor.) Normalized; maps to 0..kVolDepthMax.
      .floatField("vol_depth", 0.5f, 0.0f, 1.0f, state::PrimaryInput)
      // --- Drift: bounded 2nd-order random walk per quantity, + overall speed ---
      .floatField("drift_xy", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("drift_z", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("drift_shape", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("drift_angle", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .floatField("drift_speed", 0.3f, 0.0f, 1.0f, state::PrimaryInput)
      // Broadcast: the live (drifted) blob values, for the fog preview widget.
      .floatField("vol_x_live", 0.0f, -1.5f, 1.5f, state::SecondaryOutput)
      .floatField("vol_y_live", 0.0f, -1.5f, 1.5f, state::SecondaryOutput)
      .floatField("vol_z_live", 0.5f, 0.0f, 1.0f, state::SecondaryOutput)
      .floatField("vol_shape_live", 1.0f, -1.0f, 1.0f, state::SecondaryOutput)
      .floatField("vol_angle_live", 0.0f, 0.0f, 1.0f, state::SecondaryOutput)
      // --- Autopilot (non-destructive XY override + broadcast) ---
      .boolField("autopilot", false, state::PrimaryInput)
      .floatField("ap_speed", 0.43f, 0.0f, 1.0f, state::PrimaryInput)
      .boolField("ap_snap", false, state::PrimaryInput)
      .floatField("ap_hold_period", 2.0f, 0.0f, 8.0f, state::PrimaryInput)
      .floatField("ap_hold_jitter", 0.0f, 0.0f, 1.0f, state::PrimaryInput)
      .eventField("ap_jump", state::PrimaryInput)
      // Broadcast: the effective XY so the custom editor can show the live position.
      .floatField("autopilot_x", 0.6f, 0.0f, 1.0f, state::SecondaryOutput)
      .floatField("autopilot_y", 0.6f, 0.0f, 1.0f, state::SecondaryOutput)
      // --- I/O: pure generator (no input) ---
      .textureField("tex_out", state::PrimaryOutput)
        .capability(state::Capability::Generator)
        .capability(state::Capability::SeekableApproximate)
    );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("brutal_fold_present", PRESENT_SPV, PRESENT_SPV_SIZE);

  auto cs_present = gpu::Device::createShaderModuleByName("brutal_fold_present");
  if (!cs_present) return;

  s_pso_present = gpu::Device::createComputePSO(cs_present, "main", gpu::Bindings()
      .uniform(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)); // tex_out

  state::log("brutal_fold: module initialized");
}

// Distinct PRNG seed per instance (no wall-clock / RNG primitive needed).
static uint32_t s_seed_counter = 0x9E3779B9u;

void* create() {
  auto* s = new State();
  s_seed_counter = s_seed_counter * 1664525u + 1013904223u;
  s->rng = s_seed_counter ^ 0xC0FFEEu;
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
  s->initialized = false;
  if (!s_pso_present.valid()) return;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;
  state::setOnStateReady(&on_state_ready);
}

static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  apply_visibility(s->autopilot, s->ap_snap);
}

static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static inline float lerpf(float a, float b, float f) { return a + (b - a) * f; }
static inline int   clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Per-instance uniform random in [0,1) (LCG).
static inline float rng_unit(State* s) {
  s->rng = s->rng * 1664525u + 1013904223u;
  return (float)((s->rng >> 8) & 0xFFFFFFu) / (float)0x1000000;
}

// One step of a bounded second-order random walk: the velocity gets a random
// kick and mean-reverts (spring) with damping; the offset integrates velocity
// and hard-reflects at ±(amount). `speed` scales the evolution rate. Returns the
// new offset (also writes back o, v). amount<=0 parks it at 0.
static inline float drift_step(State* s, float& o, float& v, float amount,
                               float speed, float fdt) {
  if (amount <= 1e-6f) { o = 0.0f; v = 0.0f; return 0.0f; }
  float rate = speed * kDriftMaxSpeed * kDriftRate;
  float kick = (2.0f * rng_unit(s) - 1.0f) * kDriftSigma;
  v += (kick - kDriftSpring * o) * rate * fdt;
  v *= kDriftDamp;
  o += v * rate * fdt;
  if (o > amount)  { o = amount;  v = -v * 0.4f; }
  if (o < -amount) { o = -amount; v = -v * 0.4f; }
  return o;
}

// Epicycle position at a given orbit phase. Clamped to stay inside the pad.
static inline void orbit_xy(float orbit, float& ox, float& oy) {
  float a1 = orbit;
  float a2 = orbit * kApW2 + kApPhi;
  ox = clampf(0.5f + kApA * std::cos(a1) + kApB * std::cos(a2), 0.03f, 0.97f);
  oy = clampf(0.5f + kApA * std::sin(a1) + kApB * std::sin(a2), 0.03f, 0.97f);
}

// Advance the internal clocks and compute the effective (broadcast) XY.
void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  float fdt = (float)dt;
  // Advance the TV-static reroll phase: speed=0 freezes it, speed=1 ≈ 30 Hz
  // (matches source.noise). floor(phase) is the per-frame seed in the shader.
  s->noise_phase += fdt * (s->noise_speed * 30.0f);
  if (s->noise_phase > 1.0e6f) s->noise_phase -= 1.0e6f;

  // Quadratic speed response onto a low actual max — fine control at the slow end.
  float ts = s->time_speed;
  float time_actual = ts * ts * kTimeMax;                      // loops/sec
  float aps = s->ap_speed;
  float ap_actual = kApMin + aps * aps * (kApMax - kApMin);

  s->clock_t += fdt * time_actual;
  s->clock_t -= std::floor(s->clock_t);

  if (s->autopilot) {
    s->orbit -= fdt * ap_actual;                 // clockwise drift

    bool trig = s->ap_jump_pending;
    s->ap_jump_pending = false;

    if (s->ap_snap) {
      bool hold_on = s->ap_hold_period > 1e-4f;
      bool jump = trig || !s->held_valid;        // trigger or first frame
      if (hold_on) {
        s->snap_accum += fdt;
        if (s->snap_accum >= s->next_hold) jump = true;
      }
      if (jump) {
        if (trig && !hold_on && s->held_valid) s->orbit -= kGoldenAngle;
        orbit_xy(s->orbit, s->held_x, s->held_y);
        s->held_valid = true;
        s->snap_accum = 0.0f;
        float jit = s->ap_hold_jitter * (2.0f * rng_unit(s) - 1.0f);
        s->next_hold = s->ap_hold_period * (1.0f + jit);
        if (s->next_hold < 0.02f) s->next_hold = 0.02f;
      }
      s->eff_x = s->held_x; s->eff_y = s->held_y;
    } else {
      if (trig) s->orbit -= kGoldenAngle;
      orbit_xy(s->orbit, s->eff_x, s->eff_y);
      s->held_valid = false;
    }
  } else {
    s->eff_x = s->complexity;
    s->eff_y = s->order;
    s->held_valid = false;
    s->snap_accum = 0.0f;
    s->ap_jump_pending = false;
  }

  // Broadcast the effective XY so the editor can show the live position.
  auto vx = val::number(s->eff_x);
  state::setValPath("autopilot_x", vx);
  val::release(vx);
  auto vy = val::number(s->eff_y);
  state::setValPath("autopilot_y", vy);
  val::release(vy);

  // --- Volumetric blob drift (bounded 2nd-order random walks) ---
  float sp = s->drift_speed;
  float ox = drift_step(s, s->dx_o, s->dx_v, s->drift_xy, sp, fdt);
  float oy = drift_step(s, s->dy_o, s->dy_v, s->drift_xy, sp, fdt);
  float oz = drift_step(s, s->dz_o, s->dz_v, s->drift_z, sp, fdt);
  float osh = drift_step(s, s->dsh_o, s->dsh_v, s->drift_shape, sp, fdt);
  float oan = drift_step(s, s->dan_o, s->dan_v, s->drift_angle, sp, fdt);
  // Depth drift is sensitive → low-pass it so it glides instead of jumping.
  float zk = clampf(fdt * kDepthDriftSmoothRate, 0.0f, 1.0f);
  s->dz_smooth += (oz - s->dz_smooth) * zk;
  s->eff_vol_x = clampf(s->vol_anchor_x + ox, -1.5f, 1.5f);
  s->eff_vol_y = clampf(s->vol_anchor_y + oy, -1.5f, 1.5f);
  s->eff_vol_z = clampf(s->vol_z + s->dz_smooth, 0.0f, 1.0f);
  s->eff_vol_shape = clampf(s->vol_shape + osh, -1.0f, 1.0f);
  s->eff_vol_angle = s->vol_angle + oan;   // periodic — shader wraps via cos/sin

  // Broadcast the live (drifted) blob values for the fog preview widget.
  auto blx = val::number(s->eff_vol_x);     state::setValPath("vol_x_live", blx);     val::release(blx);
  auto bly = val::number(s->eff_vol_y);     state::setValPath("vol_y_live", bly);     val::release(bly);
  auto blz = val::number(s->eff_vol_z);     state::setValPath("vol_z_live", blz);     val::release(blz);
  auto bls = val::number(s->eff_vol_shape); state::setValPath("vol_shape_live", bls); val::release(bls);
  auto bla = val::number(s->eff_vol_angle - std::floor(s->eff_vol_angle));
  state::setValPath("vol_angle_live", bla); val::release(bla);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  bool mode_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "complexity"))        s->complexity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "order"))             s->order = state::patchFloat(i);
    else if (state::pathIs(path, plen, "liveliness"))        s->liveliness = state::patchFloat(i);
    else if (state::pathIs(path, plen, "scale"))             s->scale = state::patchFloat(i);
    else if (state::pathIs(path, plen, "balance"))           s->balance = state::patchFloat(i);
    else if (state::pathIs(path, plen, "extrude"))           s->extrude = state::patchFloat(i);
    else if (state::pathIs(path, plen, "second_structure"))  s->second_structure = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(path, plen, "interp_cells"))      s->interp_cells = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(path, plen, "time_speed"))        s->time_speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "ease"))              s->ease = state::patchFloat(i);
    else if (state::pathIs(path, plen, "anim_amount"))       s->anim_amount = state::patchFloat(i);
    else if (state::pathIs(path, plen, "fog"))               s->fog = state::patchFloat(i);
    else if (state::pathIs(path, plen, "diff_hue_lo"))       s->diff_hue_lo = state::patchFloat(i);
    else if (state::pathIs(path, plen, "diff_hue_mid"))      s->diff_hue_mid = state::patchFloat(i);
    else if (state::pathIs(path, plen, "diff_hue_hi"))       s->diff_hue_hi = state::patchFloat(i);
    else if (state::pathIs(path, plen, "diff_sat"))          s->diff_sat = state::patchFloat(i);
    else if (state::pathIs(path, plen, "diff_sat_lo"))       s->diff_sat_lo = state::patchFloat(i);
    else if (state::pathIs(path, plen, "diff_sat_mid"))      s->diff_sat_mid = state::patchFloat(i);
    else if (state::pathIs(path, plen, "diff_sat_hi"))       s->diff_sat_hi = state::patchFloat(i);
    else if (state::pathIs(path, plen, "diff_bri_lo"))       s->diff_bri_lo = state::patchFloat(i);
    else if (state::pathIs(path, plen, "diff_bri_mid"))      s->diff_bri_mid = state::patchFloat(i);
    else if (state::pathIs(path, plen, "diff_bri_hi"))       s->diff_bri_hi = state::patchFloat(i);
    else if (state::pathIs(path, plen, "fog_hue_lo"))        s->fog_hue_lo = state::patchFloat(i);
    else if (state::pathIs(path, plen, "fog_hue_mid"))       s->fog_hue_mid = state::patchFloat(i);
    else if (state::pathIs(path, plen, "fog_hue_hi"))        s->fog_hue_hi = state::patchFloat(i);
    else if (state::pathIs(path, plen, "fog_sat"))           s->fog_sat = state::patchFloat(i);
    else if (state::pathIs(path, plen, "fog_sat_lo"))        s->fog_sat_lo = state::patchFloat(i);
    else if (state::pathIs(path, plen, "fog_sat_mid"))       s->fog_sat_mid = state::patchFloat(i);
    else if (state::pathIs(path, plen, "fog_sat_hi"))        s->fog_sat_hi = state::patchFloat(i);
    else if (state::pathIs(path, plen, "sky_hue"))           s->sky_hue = state::patchFloat(i);
    else if (state::pathIs(path, plen, "sky_sat"))           s->sky_sat = state::patchFloat(i);
    else if (state::pathIs(path, plen, "sky_bri"))           s->sky_bri = state::patchFloat(i);
    else if (state::pathIs(path, plen, "noise_blob"))        s->noise_blob = state::patchFloat(i);
    else if (state::pathIs(path, plen, "noise_blob_tilt"))   s->noise_blob_tilt = state::patchFloat(i);
    else if (state::pathIs(path, plen, "noise_fog"))         s->noise_fog = state::patchFloat(i);
    else if (state::pathIs(path, plen, "noise_speed"))       s->noise_speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vol_amount"))        s->vol_amount = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vol_anchor_x"))      s->vol_anchor_x = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vol_anchor_y"))      s->vol_anchor_y = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vol_z"))             s->vol_z = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vol_shape"))         s->vol_shape = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vol_angle"))         s->vol_angle = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vol_radius"))        s->vol_radius = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vol_softness_xy"))   s->vol_softness_xy = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vol_softness_z"))    s->vol_softness_z = state::patchFloat(i);
    else if (state::pathIs(path, plen, "vol_depth"))         s->vol_depth = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drift_xy"))          s->drift_xy = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drift_z"))           s->drift_z = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drift_shape"))       s->drift_shape = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drift_angle"))       s->drift_angle = state::patchFloat(i);
    else if (state::pathIs(path, plen, "drift_speed"))       s->drift_speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "autopilot"))         { bool v = state::patchFloat(i) != 0.0f; if (v != s->autopilot) { s->autopilot = v; mode_changed = true; } }
    else if (state::pathIs(path, plen, "ap_speed"))          s->ap_speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "ap_snap"))           { bool v = state::patchFloat(i) != 0.0f; if (v != s->ap_snap) { s->ap_snap = v; mode_changed = true; } }
    else if (state::pathIs(path, plen, "ap_hold_period"))    s->ap_hold_period = state::patchFloat(i);
    else if (state::pathIs(path, plen, "ap_hold_jitter"))    s->ap_hold_jitter = state::patchFloat(i);
    else if (state::pathIs(path, plen, "ap_jump")) {
      float v = state::patchFloat(i);
      if (v != 0.0f && s->ap_jump_prev == 0.0f) s->ap_jump_pending = true;  // rising edge
      s->ap_jump_prev = v;
    }
  }
  if (mode_changed) apply_visibility(s->autopilot, s->ap_snap);
}

// ---- CPU atlas resolve (port of field.ts: corners / occ / levelFor / build) ----

struct Corners { int idx[4]; float w[4]; };

static Corners bf_corners(float sx, float sy, bool interp) {
  const int G = BF_GRID;
  sx = clampf(sx, 0.0f, 1.0f); sy = clampf(sy, 0.0f, 1.0f);
  float fx = sx * (G - 1), fy = sy * (G - 1);
  int x0, x1, y0, y1; float tx, ty;
  if (interp) {
    x0 = clampi((int)std::floor(fx), 0, G - 1); x1 = std::min(x0 + 1, G - 1); tx = fx - x0;
    y0 = clampi((int)std::floor(fy), 0, G - 1); y1 = std::min(y0 + 1, G - 1); ty = fy - y0;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty); // smoothstep
  } else {
    x0 = x1 = clampi((int)std::lround(fx), 0, G - 1);
    y0 = y1 = clampi((int)std::lround(fy), 0, G - 1);
    tx = ty = 0;
  }
  Corners c;
  c.idx[0] = y0 * G + x0; c.idx[1] = y0 * G + x1; c.idx[2] = y1 * G + x0; c.idx[3] = y1 * G + x1;
  c.w[0] = (1 - tx) * (1 - ty); c.w[1] = tx * (1 - ty); c.w[2] = (1 - tx) * ty; c.w[3] = tx * ty;
  return c;
}

// Occupancy O at field coords (wx,wy) for the structure based at P[base..].
static float bf_occ(const float* P, int base, float wx, float wy) {
  float uni = 0, inter = 1;
  float dc = P[base + SB1 + S_DC], bold = P[base + SB1 + S_BOLD_GAIN];
  for (int i = 0; i < BF_NTERMS; i++) {
    int o = base + i * 8;
    float th = P[o], mth = P[o + 1], sh = P[o + 2], fr = P[o + 3], ph = P[o + 4],
          h = P[o + 5], amp = P[o + 6], mix = P[o + 7];
    float d = std::cos(th) * wx + std::sin(th) * wy + sh * (std::cos(mth) * wx + std::sin(mth) * wy);
    float q = d * fr + ph; q = q - std::floor(q) - 0.5f;
    float box = (h - std::fabs(q) > 0.0f) ? 1.0f : 0.0f;
    float a = clampf(h / BF_H_ACT, 0.0f, 1.0f);
    if (mix >= 0.5f) inter *= (1 - a) + a * box; else uni += amp * box;
  }
  return dc + uni + bold * inter;
}

// Solid threshold lo + thresh*(hi-lo) over the form's value range (coarse grid).
static float bf_levelFor(const float* P, int base, float thresh) {
  float fs = P[base + SB1 + S_FORM_SCALE];
  float mn = 1e9f, mx = -1e9f;
  const int NG = 24;
  for (int gi = 0; gi < NG; gi++) {
    for (int gj = 0; gj < NG; gj++) {
      float o = bf_occ(P, base, ((gi + 0.5f) / NG - 0.5f) * fs, ((gj + 0.5f) / NG - 0.5f) * fs);
      if (o < mn) mn = o;
      if (o > mx) mx = o;
    }
  }
  return mn + thresh * (mx - mn);
}

static void bf_build_struct(State* s, float* P, int base, bool useB, bool animate,
                            float z, float scaleMul, float extrudeMul, float tau,
                            const Corners& c) {
  const int B = BF_NTERMS, Z = BF_NZ;
  const float* const* TA = useB ? B_TERM_A : TERM_A;
  const float* const* SA = useB ? B_SCENE_A : SCENE_A;

  // interpolate term params
  for (int i = 0; i < B; i++) {
    for (int f = 0; f < 8; f++) {
      const float* src = TA[f];
      float v = 0;
      for (int cc = 0; cc < 4; cc++) v += c.w[cc] * src[c.idx[cc] * B + i];
      P[base + i * 8 + f] = v;
    }
  }
  // interpolate scene scalars
  for (int f = 0; f < SCN; f++) {
    const float* src = SA[f];
    float v = 0;
    for (int cc = 0; cc < 4; cc++) v += c.w[cc] * src[c.idx[cc]];
    P[base + SB1 + f] = v;
  }

  // finalize form_scale / extrude / fog (taste multipliers), THEN fix the level
  // from the BASE field — computing it before animation touches h keeps the
  // threshold stable (no popping). No upper clamp on form_scale (the prototype's
  // 0.16 cap was removed) so `scale` can push features large.
  P[base + SB1 + S_SEV] = 0; // orthographic
  P[base + SB1 + S_FORM_SCALE] *= scaleMul;
  P[base + SB1 + S_EXTRUDE] *= extrudeMul;
  P[base + SB1 + S_FOG] = std::min(P[base + SB1 + S_FOG] * s->fog, 0.95f);
  P[base + SB1 + SCN] = bf_levelFor(P, base, P[base + SB1 + S_THRESH]);

  if (animate) {
    float fz = z * (Z - 1);
    int z0 = clampi((int)std::floor(fz), 0, Z - 1);
    int z1 = std::min(z0 + 1, Z - 1);
    float tz = fz - z0;
    float am = s->anim_amount;
    for (int i = 0; i < B; i++) {
      // sc: 0=h_amp, 1=h_om, 2=h_psi, 3=phase_drift (trilinear over x,y,z)
      float sc[4];
      for (int ch = 0; ch < 4; ch++) {
        const float* src = SCRIPT_A[ch];
        float v0 = 0, v1 = 0;
        for (int cc = 0; cc < 4; cc++) {
          v0 += c.w[cc] * src[(c.idx[cc] * Z + z0) * B + i];
          v1 += c.w[cc] * src[(c.idx[cc] * Z + z1) * B + i];
        }
        sc[ch] = v0 * (1 - tz) + v1 * tz;
      }
      // in/out: integer frequency → sin returns to its t=0 value at t=1 (seamless).
      P[base + i * 8 + 5] += am * sc[0] * std::sin(kTau * (std::round(sc[1]) * tau + sc[2]));
      // scroll: advance a whole number of cells per loop (round the blended drift).
      P[base + i * 8 + 4] += std::round(sc[3]) * tau;
    }
  } else {
    // structure 2 has no folded trajectory → a constant integer-cell scroll.
    float scroll = kScrollCells * tau;
    for (int i = 0; i < B; i++) P[base + i * 8 + 4] += scroll;
  }
}

// Fill the uniform buffer's P + header for the current frame.
static void bf_build_params(State* s, float sx, float sy, float t, Uniforms& u) {
  float* P = u.P;
  // Eased time: rests at the loop point, surges through the middle. Seamless
  // (τ(0)=0, τ(1)=1) so integer omega/drift keep the loop closed.
  float tau = t - (s->ease / kTau) * std::sin(kTau * t);
  Corners c = bf_corners(sx, sy, s->interp_cells);

  // Inverted: higher `scale` → smaller form_scale → fewer cells per screen →
  // bigger features → "zoom IN". (scale=1 is unchanged; balance is the relative
  // S1↔S2 zoom on top.)
  float inv = 1.0f / std::max(s->scale, 1e-3f);
  float scaleA = inv * std::pow(2.0f, s->balance);
  float scaleB = inv * std::pow(2.0f, -s->balance);
  bf_build_struct(s, P, 0, /*useB=*/false, /*animate=*/true, s->liveliness, scaleA, s->extrude, tau, c);

  float tilt = 0;
  bool on2 = s->second_structure && BF_CO_FOLD;
  if (on2) {
    bf_build_struct(s, P, STR, /*useB=*/true, /*animate=*/false, 0.0f, scaleB, s->extrude, tau, c);
    const float* bt = BF_B_TILT;
    for (int cc = 0; cc < 4; cc++) tilt += c.w[cc] * bt[c.idx[cc]];
  }

  u.n_terms = (float)BF_NTERMS;
  u.sb = (float)SB1;
  u.str = (float)STR;
  u.tilt = tilt;
  u.enable2 = on2 ? 1.0f : 0.0f;
  u.h_act = BF_H_ACT;

  u.diff_hue_lo = s->diff_hue_lo; u.diff_hue_mid = s->diff_hue_mid;
  u.diff_hue_hi = s->diff_hue_hi; u.diff_sat = s->diff_sat;
  u.diff_sat_lo = s->diff_sat_lo; u.diff_sat_mid = s->diff_sat_mid; u.diff_sat_hi = s->diff_sat_hi;
  u.diff_bri_lo = s->diff_bri_lo; u.diff_bri_mid = s->diff_bri_mid; u.diff_bri_hi = s->diff_bri_hi;
  u.fog_hue_lo = s->fog_hue_lo; u.fog_hue_mid = s->fog_hue_mid;
  u.fog_hue_hi = s->fog_hue_hi; u.fog_sat = s->fog_sat;
  u.fog_sat_lo = s->fog_sat_lo; u.fog_sat_mid = s->fog_sat_mid; u.fog_sat_hi = s->fog_sat_hi;
  u.sky_hue = s->sky_hue; u.sky_sat = s->sky_sat; u.sky_bri = s->sky_bri;
  u.noise_blob = s->noise_blob; u.noise_fog = s->noise_fog;
  u.noise_blob_tilt = s->noise_blob_tilt;
  u.noise_seed = s->noise_phase;   // shader floors via int() → discrete reroll id

  // Volumetric blob — feed the DRIFTED (effective) values.
  u.vol_amount = s->vol_amount;
  u.vol_anchor_x = s->eff_vol_x;
  u.vol_anchor_y = s->eff_vol_y;
  u.vol_z = s->eff_vol_z;
  u.vol_shape = s->eff_vol_shape;
  u.vol_angle = s->eff_vol_angle;
  u.vol_radius = s->vol_radius * kVolRadiusMax;
  u.vol_softness_xy = s->vol_softness_xy * kVolSoftXYMax;
  u.vol_softness_z = s->vol_softness_z * kVolSoftZMax;
  u.vol_depth = s->vol_depth * kVolDepthMax;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  Uniforms u = {};
  u.res_x = (float)vp_w;
  u.res_y = (float)vp_h;
  bf_build_params(s, s->eff_x, s->eff_y, s->clock_t, u);
  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso_present);
  cp.setBuffer(s->uniform_buf, 0);
  cp.setTexture(out, 1, 1);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace brutal_fold
