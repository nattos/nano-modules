// video.shape_fold — shared math for all passes.
//
// An evolving-shape GENERATOR. A baked 3D atlas (frequency × simplicity ×
// temporal-complexity) is interpolated on the CPU each frame down to a handful
// of "terms"; those resolved terms ride in the uniform buffer and every GPU
// pass evaluates the same scalar SDF field `sf_field_at` from them — the 1.1 MB
// atlas never touches the GPU. This is the research testbed's split
// (sampleTerms in JS → fieldAt in WGSL), ported to native.
//
// Output is the raw field, histogram auto-leveled (median→0) and shown as
// grayscale or magma — no line/contour/shading modes (those were dropped on
// purpose). Auto-levels runs every frame on the GPU: minmax → hist → buildlut
// (CLAHE + percentile remap LUT) → present. The histogram needs atomic scatter,
// so stats + LUT ride in storage buffers. The shared uniform block is bound at
// register(b0) in every pass so this file can declare it once and the field
// helpers read it as globals.

#ifndef SHAPE_FOLD_COMMON_HLSL
#define SHAPE_FOLD_COMMON_HLSL

#define SF_MAX_TERMS 8
#define SF_NB        256       // histogram bins / LUT entries
#define SF_SN        160       // auto-levels downsample grid (SN×SN samples)

// Shared uniform block — identical layout in every pass (always register b0).
// 3 std140 rows of scalars, then the resolved terms (per term:
// (theta,mtheta,curv,freq)(phase,h,k,amp)(mix,spc,_,_)).
cbuffer U : register(b0) {
  float res_x;     float res_y;          float n_terms;       float dc;
  float bold_gain; float birth_softness; float domain_scale;  float level_ease;
  float gaussian;  float level_clip;     float output_mode;   float _sf_pad0;
  float4 terms[SF_MAX_TERMS * 3];
};

// One term's raw value at p (bowed, parabolically-warped, repeating cell →
// inverted parabola). Mirrors termRaw in app.js.
float sf_term_raw(uint i, float2 p) {
  float4 a = terms[i * 3u + 0u];          // theta, mtheta, curv, freq
  float4 b = terms[i * 3u + 1u];          // phase, h, k, amp
  float spc = terms[i * 3u + 2u].y;       // parabolic spacing warp
  float2 n = float2(cos(a.x), sin(a.x));
  float2 m = float2(cos(a.y), sin(a.y));
  float dm = dot(m, p);
  float d  = dot(n, p) + a.z * dm * dm;   // bowed coordinate → arcing lines
  float dw = d + spc * d * d;             // light parabola → local spacing varies
  float q  = frac(dw * a.w + b.x) - 0.5;  // repeating cell coord
  return b.y - b.z * q * q;               // inverted parabola
}

// The field: multiplicative AND terms carve shapes (with a soft birth gate),
// additive terms union stripes. Mirrors fieldAt in app.js. F ≥ 0 always
// (dc ≥ 0, additive ≥ 0, the carved product ∈ [0,1]).
float sf_field_at(float2 p) {
  float uni = 0.0;
  float inter = 1.0;
  uint nt = (uint)n_terms;
  for (uint i = 0u; i < nt; i++) {
    float4 b = terms[i * 3u + 1u];        // phase, h, k, amp
    float4 c = terms[i * 3u + 2u];        // mix, spc
    float raw = sf_term_raw(i, p);
    if (c.x >= 0.5) {                     // multiplicative AND (carves shapes)
      // Soft birth gate: active terms sit at h≫softness so statics stay fully
      // carved; births/deaths fade over a wide h-range instead of popping.
      float act = smoothstep(0.0, max(birth_softness, 1e-4), b.y);
      inter = inter * ((1.0 - act) + act * clamp(raw / max(b.y, 1e-3), 0.0, 1.0));
    } else {                              // additive union (stripes)
      uni = uni + b.w * max(0.0, raw);
    }
  }
  return dc + uni + bold_gain * inter;
}

// Auto-levels downsample sample point: canonical [-1,1] square × domain zoom.
// minmax + hist both use this so the leveling matches what present displays.
float2 sf_levels_p(uint2 gid) {
  return ((float2(gid) + 0.5) / float(SF_SN) * 2.0 - 1.0) * domain_scale;
}

// Polynomial magma colormap (same as app.js).
float3 sf_magma(float t) {
  float x = saturate(t);
  float3 c0 = float3(-0.002136, -0.000750, -0.005386);
  float3 c1 = float3(0.251661, 0.677523, 2.494027);
  float3 c2 = float3(8.353717, -3.577720, 0.314468);
  float3 c3 = float3(-27.668733, 14.264731, -13.649213);
  float3 c4 = float3(52.176140, -27.943606, 12.944169);
  float3 c5 = float3(-50.768525, 29.046583, 4.234153);
  float3 c6 = float3(18.655705, -11.489774, -5.601962);
  return c0 + x * (c1 + x * (c2 + x * (c3 + x * (c4 + x * (c5 + x * c6)))));
}

#endif // SHAPE_FOLD_COMMON_HLSL
