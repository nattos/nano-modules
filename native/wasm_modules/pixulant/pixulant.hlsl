// warp.legacy.pixulant — scatter-cascade + Difference "dive" (Wire "Pixulant").
//
// Two ISF shaders fused into one pass:
//   - "Radial Stretch Sample" (rss_*): a per-pixel salted-random scatter of the
//     SAMPLING uv, aspect-corrected on y, with Resolume's load-bearing bottom-row
//     clamp (outputUV.y = max(.,1/H)).
//   - "Difference": mix(rhs, abs(lhs-rhs), Alpha*2).
//
// The patch cascades three Radial Stretch passes (light→mid→heavy) then takes
// the Difference of the heavy copy (lhs) against the light copy (rhs). Because
// each pass is a pure resample (outUV = uv + dir·strength; sample), the cascade
// composes: we chain the three displacements and take ONE sample of the input at
// the composed coordinate per side (rhs needs one pass; lhs needs three). This
// is the v2 re-architecture — shimmer-free, no intermediate render targets —
// versus the original's three full-frame passes (whose intermediate bilinear
// filtering differs only sub-pixel from this).
//
// The "strange colours out of nowhere": abs(lhs-rhs) of two DIFFERENTLY-scattered
// copies is a per-channel edge halo (zero in flat regions, coloured at edges);
// even at Scatter=0 a tiny scatter floor makes the heavy copy displace more than
// the light one, so edges still differ — and the Exposure gain lifts that halo
// into vivid grain. Faithful to the patch, not a Wire rounding accident.

Texture2D<float4>   inputTex      : register(t0);
SamplerState        linearSampler : register(s1);
RWTexture2D<float4> outputTex     : register(u2);

cbuffer Uniforms : register(b3) {
  float str_rhs;        // light-pass scatter strength (RSS191)
  float str_mid;        // middle-pass scatter strength (RSS180)
  float str_lhs;        // heavy-pass scatter strength (RSS185)
  float diff_t;         // Difference mix factor = Alpha*2 = Dive

  float salt_rhs;       // RSS191 salt (= Saw+Random)
  float salt_mid;       // RSS180 salt (+0.4)
  float salt_lhs;       // RSS185 salt (+0.7)
  float exposure_gain;  // photographic gain on the differenced image

  float aspect;         // W/H, for scatterDir.y *= aspect (round scatter on screen)
  float inv_h;          // 1/H, Resolume's bottom-row clamp
  float _pad0;
  float _pad1;
};

// ISF "Radial Stretch Sample" rand: a salted value-hash of the destination uv.
float rss_rand(float2 uv, float salt) {
  return frac(sin(dot(uv, float2(12.9898, 78.233 + salt * 1.56783)))
              * (43758.5453 + salt * 86183.526));
}

// One scatter pass: random per-pixel displacement of the SAMPLING uv.
float2 rss_scatter(float2 uv, float salt, float strength) {
  float2 dir = (float2(rss_rand(uv, 0.0 + salt), rss_rand(uv, 0.1 + salt)) - 0.5) * 2.0;
  dir.y *= aspect;
  float2 outUV = uv + dir * strength;
  outUV.y = max(outUV.y, inv_h); // Resolume's bottom-clamp quirk (kept on purpose)
  return outUV;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);

  // rhs = one light scatter of the input (RSS191 at this uv).
  float2 uvR = rss_scatter(uv, salt_rhs, str_rhs);
  float4 rhs = inputTex.SampleLevel(linearSampler, uvR, 0.0);

  // lhs = the three-deep cascade (RSS185 ∘ RSS180 ∘ RSS191). Each pass
  // re-randomizes from its own destination uv, so chain the displacements
  // and sample the input once at the composed coordinate.
  float2 uvB = rss_scatter(uv,  salt_lhs, str_lhs); // outer (3rd) pass
  float2 uvA = rss_scatter(uvB, salt_mid, str_mid); // middle (2nd) pass
  float2 uvT = rss_scatter(uvA, salt_rhs, str_rhs); // inner (1st) pass = RSS191
  float4 lhs = inputTex.SampleLevel(linearSampler, uvT, 0.0);

  // ISF "Difference": mix(rhs, abs(lhs-rhs), Alpha*2). diff_t = Alpha*2 = Dive.
  float3 diff = abs(lhs.rgb - rhs.rgb);
  float3 rgb  = lerp(rhs.rgb, diff, diff_t);

  // Exposure node: photographic gain that lifts the (mostly dark) difference —
  // this is what makes the edge halo bloom into "strange colours".
  rgb *= exposure_gain;

  // Difference's alpha: mix(lhs.a, rhs.a, Alpha) where Alpha = diff_t*0.5.
  float a = lerp(lhs.a, rhs.a, diff_t * 0.5);
  outputTex[gid.xy] = float4(saturate(rgb), a);
}
