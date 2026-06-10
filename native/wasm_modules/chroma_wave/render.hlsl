// gen.chroma_wave — charge-and-burst prismatic wave bloom.
//
// A soft super-gaussian blob grows out of the top-center while gated. As
// "pressure" builds it strains: the top flattens into a plateau, the blob
// breaks XY symmetry (elongates in X), and the density hollows out at the top
// so the mass piles into a downward CRESCENT — the max-pressure point. On
// release it BURSTS: the radius expands rapidly, the crescent opens out, the
// contrast shallows, and the colour-grade transfer starts scrolling so the
// prismatic bands fold and travel down the density gradient (dominant) while
// secondary bands wash back up the inner edge.
//
// The blob's own brightness/colour is GENERATED here (graded from the density
// field), not read from the input — tex_in is just the background we composite
// the additive prismatic bloom over.

#include "nano_color.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  // row 0
  float cx;            // blob center, uv
  float cy;
  float radius;        // current base radius (uv, isotropic), post charge+burst
  float elong;         // X elongation (>1 widens)

  // row 1
  float ycomp;         // Y compression (<1 squishes vertically)
  float sharp;         // gaussian sharpness (falls during burst → shallow)
  float plateau_p;     // super-gaussian exponent (>1 → flat top)
  float cres;          // crescent carve depth [0,1]

  // row 2
  float cres_off;      // carve-disk vertical offset (q-units, toward top)
  float grade_freq;    // colour bands across the density ramp
  float grade_phase;   // scrolling transfer phase (folds during burst)
  float hue_span;      // hue advance per unit transfer t

  // row 3
  float base_hue;
  float saturation;
  float band_contrast; // alpha banding depth [0,1]
  float alpha_gamma;   // density → alpha power

  // row 4
  float overlay_alpha; // current overlay weight (hold vs burst-spike)
  float intensity;
  float color_r;       // blob tint
  float color_g;

  // row 5
  float color_b;
  float debug_field;   // !=0 → visualise raw density field
  float band_tilt;     // skew bands toward (+, down) / away (-) the wavefront
  float _pad1;
};

static const float TAU = 6.28318530717958647692;

// The density field at a pixel: super-gaussian (plateau) minus an upward-
// shifted carve disk (crescent), in anisotropic + aspect-corrected coords.
// Also returns the signed downward coordinate `qy` (+ = below center, toward
// the wavefront) so the band grade can tilt along it.
float chroma_field(float2 uv, float asp, out float qy_out) {
  float2 rel = uv - float2(cx, cy);
  float qx = (rel.x * asp) / max(radius * elong, 1e-5);
  float qy = (rel.y)       / max(radius * ycomp, 1e-5);
  qy_out = qy;

  float r2  = qx * qx + qy * qy;
  // Carve disk sits ABOVE center (toward the top → +cres_off in qy because uv.y
  // grows downward). Removing it leaves a downward-bulging crescent.
  float qyu = qy + cres_off;
  float ru2 = qx * qx + qyu * qyu;

  float g_main  = exp(-pow(r2, plateau_p) * sharp);
  float g_carve = exp(-ru2 * sharp * 1.6);
  return saturate(g_main - cres * g_carve);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float asp = float(W) / float(H);
  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);

  float4 base = inputTex[gid.xy];
  float qy;
  float g = chroma_field(uv, asp, qy);

  if (debug_field != 0.0) {
    outputTex[gid.xy] = float4(base.rgb * 0.15 + g.xxx, base.a);
    return;
  }

  // Colour-grade the density. The transfer t = g*freq + phase folds the band
  // structure: advancing `phase` during burst sweeps which density maps to
  // which colour, so bands travel outward (down) on the falling edge and back
  // up the inner crescent edge — multiple waves crossing the gradient.
  // band_tilt adds a directional skew along qy so the bands lean toward (+,
  // down/forward) or away from (-) the wavefront.
  float t = g * grade_freq + grade_phase + band_tilt * qy;
  float hue = base_hue + t * hue_span;
  float band = 0.5 + 0.5 * cos(TAU * t);                 // [0,1] periodic
  float band_w = lerp(1.0 - band_contrast, 1.0, band);

  float a = overlay_alpha * pow(g, alpha_gamma) * band_w;
  float3 col = nano_hsv_to_rgb(float3(hue, saturation, 1.0))
             * float3(color_r, color_g, color_b);

  // Crankable intensity with a soft per-channel rolloff (1 - e^-x): high gain
  // pushes the bloom toward saturated, juicy colour instead of hard-clipping
  // every channel to white.
  float3 bloom = 1.0 - exp(-col * a * intensity);
  outputTex[gid.xy] = float4(saturate(base.rgb + bloom), base.a);
}
