// source.sdf.plume — shell update: author the displacement field on the
// octahedral S² map.
//
// One shader, dispatched TWICE per frame: once at PLM_SHELL_RES writing
// shell_full (all octaves), once at PLM_COARSE_RES writing shell_coarse
// (octave count capped to what the 128³ bake grid can carry without
// aliasing). Both evaluate the SAME field — the march's detail tier uses
// the full map directly, so the two tiers can never disagree about where
// the surface is.
//
// The feather/shingle anisotropy: ridges are stretched along a FLOW
// direction tangent to the sphere — a swirl field around a tilted axis,
// bent per-point by a low-frequency wobble so the flow lines meander like
// wind. Implemented as a line-integral SMEAR along the curved flow line:
// the LOW octaves are averaged over taps walking upwind (re-evaluating
// the flow frame each step so tails bend with the wobble), then contrast-
// compensated; the fine-octave residual is re-added locally. Averaging is
// ripple-free — a max-dilation was tried and inherently washboards (the
// max of a field and its displaced copies ripples at the field's own
// wavelength). A linear domain stretch does NOT work here at all:
// flow/perp are tangent to the sphere, so dot(dir, flow) == 0 and the
// "stretch" would act only on the constant seed/morph offset through the
// spatially rotating frame — a huge accidental domain warp (the
// hair-trigger "curls then noise" failure), with zero real elongation.
//
// Channels: .r = radial displacement h (world units, ≥ 0),
//           .g = crest emphasis (drives material/emission later),
//           .ba = reserved for shell sim state (v1: zero).

#include "common.hlsl"
#include "nano_noise3.hlsl"

RWTexture2D<float4> shellTex : register(u0);

cbuffer ShellUniforms : register(b1) {
  float res;         // target resolution (PLM_SHELL_RES or PLM_COARSE_RES)
  float octaves;     // octave cap for this target
  float ridge_scale; // base spatial frequency on the sphere
  float ridge_amp;   // displacement amplitude, world units
  float ridge_sharp; // 0 round bumps .. 1 knife ridges
  float morph_x;     // closed-circle domain drift (x component)
  float seed;        // variation offset
  float morph_z;     // closed-circle domain drift (z component)
  float aniso;       // flow-direction stretch factor (0 = isotropic)
  float swirl;       // flow direction angle around the local normal
  float wobble;      // low-freq flow meander amount
  float _pad0;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  int R = int(res);
  if (gid.x >= (uint)R || gid.y >= (uint)R) return;

  float2 uv = (float2(gid.xy) + 0.5) / res;
  float3 dir = nano_oct_decode(uv);

  // Flow tangent: swirl around the (tilted) y axis, rotated in the tangent
  // plane by `swirl` + a low-frequency wobble. Poles of the swirl axis
  // fall back smoothly to an arbitrary tangent.
  float3 axis = normalize(float3(0.25, 1.0, 0.1));
  float3 t1 = cross(axis, dir);
  float t1l = length(t1);
  float3 alt = cross(float3(1.0, 0.0, 0.0), dir);
  t1 = t1l > 0.05 ? t1 / t1l : normalize(alt);
  float3 t2 = cross(dir, t1);

  float3 wob_off = float3(seed * 7.3, morph_x * 0.2, morph_z * 0.2);
  float ang = swirl * 3.14159265
            + wobble * 2.2 * nano_gnoise3(dir * 2.3 + wob_off);
  float ca = cos(ang), sa = sin(ang);
  float3 flow = t1 * ca + t2 * sa;         // elongate ALONG this
  float3 perp = -t1 * sa + t2 * ca;        // ...compress across this

  float3 off = float3(seed * 37.7, 0.0, seed * 11.3)
             + float3(morph_x, 0.0, morph_z);
  float3 p = dir * ridge_scale + off;

  // Feathering = dilation swept along the CURVED flow line. Walk upwind in
  // short steps, re-evaluating the flow frame at each step so the tail
  // bends with the wobble field; each tap droops with distance, so every
  // lobe drags a tapering, curving tail downwind. Soft-max keeps the union
  // of tails crease-free, and dilation preserves full contrast (a mean
  // smear just fades the field toward mid-gray). Arc is measured in
  // base-octave noise cells (arc·ridge_scale) so the knob reads the same
  // at any Ridge Scale.
  float arc = min(aniso * 2.6 / ridge_scale, 0.55);
  int oct_full = int(octaves);
  float raw = nano_gfbm3(p, oct_full, 0.45);
  if (arc > 1e-4) {
    // Smear only the LOW octaves: sparse taps can't sample the fine
    // octaves densely enough, and wind-swept regions reading smoother
    // than fresh crests is the right look anyway. The fine-octave
    // residual is re-added locally, faded with feathering so it doesn't
    // pockmark the smoothed tails.
    int oct_lo = max(oct_full - 2, 2);
    float tf = 0.0, tl = 0.0, aw = 0.5;
    [unroll] for (int i = 0; i < 6; i++) {
      if (i < oct_full) tf += aw;
      if (i < oct_lo) tl += aw;
      aw *= 0.45;
    }
    float norm_lo = tl / tf;
    float raw_lo = nano_gfbm3(p, oct_lo, 0.45);
    float fine = raw - raw_lo * norm_lo;   // full-normalized residual
    float step_a = arc * 0.1;
    float sum = raw_lo, wsum = 1.0;
    float3 dcur = dir;
    float3 fcur = flow;
    [loop] for (int k = 1; k <= 10; k++) {
      dcur = normalize(dcur * cos(step_a) - fcur * sin(step_a));  // upwind
      float3 t1k = cross(axis, dcur);
      float t1kl = length(t1k);
      t1k = t1kl > 0.05 ? t1k / t1kl
                        : normalize(cross(float3(1.0, 0.0, 0.0), dcur));
      float3 t2k = cross(dcur, t1k);
      float angk = swirl * 3.14159265
                 + wobble * 2.2 * nano_gnoise3(dcur * 2.3 + wob_off);
      fcur = t1k * cos(angk) + t2k * sin(angk);
      float w = 1.0 - float(k) / 11.0;   // triangular taper upwind
      sum += w * nano_gfbm3(dcur * ridge_scale + off, oct_lo, 0.45);
      wsum += w;
    }
    // The averaged field loses variance — restore contrast so feathering
    // doesn't just read as "flatter".
    float smear = (sum / wsum) * (1.0 + 0.9 * aniso);
    raw = smear * norm_lo + fine * (1.0 - 0.6 * aniso);
  }
  float n = saturate(0.5 + 0.5 * raw);

  // The plate/petal look: the smooth field cut into terraces — broad
  // smooth lobes separated by cliff edges (the overlapping plate rims of
  // the reference look). `ridge_sharp` is the whole dial: 0 keeps the
  // field a fully SMOOTH heightfield (no quantized levels), the terrace
  // cliffs fade in above that and steepen toward 1.
  float terr = smoothstep(0.05, 0.7, ridge_sharp);
  float levels = 4.0;
  float tn = n * levels;
  float f = frac(tn);
  // Smooth plateau -> cliff profile: stays flat, then commits.
  float cliff = lerp(2.5, 14.0, ridge_sharp);
  float step_s = f * f * (3.0 - 2.0 * f);
  step_s = pow(step_s, cliff * 0.5) /
           (pow(step_s, cliff * 0.5) + pow(1.0 - step_s, cliff * 0.5));
  float h = lerp(n, (floor(tn) + step_s) / levels, terr);
  // Faint top texture — scaled down with terr off so the smooth end stays
  // a genuinely smooth heightfield instead of uniform wrinkle.
  h += 0.04 * (0.25 + 0.75 * terr) * (1.0 - abs(nano_gnoise3(p * 2.2 + 5.0)));
  h = saturate(h * 0.96);

  shellTex[gid.xy] = float4(h * ridge_amp, h, 0.0, 0.0);
}
