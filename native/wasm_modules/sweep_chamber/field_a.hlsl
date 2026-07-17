// source.particles.sweep_chamber — field pass A: sweep + downsample.
// One thread per FIELD_RES² texel; 16 bilinear taps on the full-res input in
// a fixed 4×4 cell-relative grid (resolution-independent).
//
// Applies the luma band-pass SWEEP window per tap, then reduces the cell to:
//   .r  — mean swept luma L' (the smooth scalar field_b takes the gradient of;
//         the 4×4 box average is the base smoothing, replacing the old
//         full-res Gaussian pre-blur)
//   .gb — intra-cell offset to the luma peak (texel units, |off| ≤ 0.5).
//         A SHARPENED WEIGHTED CENTROID (weight L'⁴), not an argmax: argmax
//         is discontinuous frame-to-frame (scintillating lines), while the
//         peak-biased centroid is continuous in the input and hugs the peak.
//         Exactly 0 in black cells, so free-space consumers never read junk.
//   .a  — MAX swept luma over the cell: the RIDGE DETECTOR. A ridge thinner
//         than a cell still reads ~full strength here — and unlike |∇L'|,
//         it stays high ON the crest (where the gradient vanishes), which is
//         what line trapping and grip must key on.

#include "common.hlsl"

RWTexture2D<float4> fieldA   : register(u0);
Texture2D<float4>   inputTex : register(t1);
SamplerState        lin      : register(s2);

cbuffer Uniforms : register(b3) {
  uint  field_res;
  float sweep_center;
  float sweep_width;
  float sweep_soft;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= field_res || gid.y >= field_res) return;
  float inv_res = 1.0 / float(field_res);

  float Lsum = 0.0, Lmax = 0.0, wsum = 0.0;
  float2 cw = float2(0.0, 0.0);
  [unroll] for (int j = 0; j < 4; j++) {
    [unroll] for (int k = 0; k < 4; k++) {
      float2 o  = (float2(j, k) + 0.5) * 0.25;               // cell-relative [0,1)
      float2 uv = (float2(gid.xy) + o) * inv_res;
      float3 c  = inputTex.SampleLevel(lin, uv, 0).rgb;
      float  Lp = swc_sweep(swc_lum(c), sweep_center, sweep_width, sweep_soft);
      Lsum += Lp;
      Lmax  = max(Lmax, Lp);
      float w = Lp * Lp; w *= w;                             // L'^4 — peak-biased
      cw   += (o - 0.5) * w;
      wsum += w;
    }
  }
  float2 off = (wsum > 1e-5) ? cw / wsum : float2(0.0, 0.0); // texel units, |off| ≤ 0.5
  fieldA[gid.xy] = float4(Lsum * (1.0 / 16.0), off.x, off.y, Lmax);
}
