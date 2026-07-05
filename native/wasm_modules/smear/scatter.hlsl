// filter.blur.smear (Scatter mode) — Pixulant's dissolve, steered directionally.
//
// Like warp.legacy.pixulant this scatters the SAMPLING uv per pixel with a salted
// random offset, samples a light copy (rhs) and a heavier copy (lhs), and blooms
// the abs-difference (the "dive": mix(rhs, abs(lhs-rhs), dive) then an exposure
// gain lifts the edge halo into coloured grain). The one change vs Pixulant: the
// random offset is drawn from the SAME tilted directional footprint the Blur mode
// uses — major reach with the tail bias, minor reach with the perspective tilt —
// instead of an isotropic disc. So the grain streaks along the axis.
//
// Salt animates via `salt_base` (a host tick accumulator + on-change hash). A tiny
// floor keeps the heavy copy displaced more than the light one even at reach 0, so
// the resting halo survives while dived (Pixulant's load-bearing quirk).

Texture2D<float4>   inputTex      : register(t0);
SamplerState        linearSampler : register(s1);
RWTexture2D<float4> outputTex     : register(u2);

cbuffer Uniforms : register(b3) {
  float axis_maj_x, axis_maj_y;   // aspect-scaled UV step per unit major reach
  float axis_min_x, axis_min_y;   // aspect-scaled UV step per unit minor reach
  float reach_fwd, reach_back;    // asymmetric major reach (short-axis fractions)
  float width;                    // minor reach
  float salt_base;                // animated salt (Saw + on-change Random)
  float major_x, major_y;         // screen-unit major dir (perspective proj)
  float tilt;                     // perspective gradient amount
  float dive;                     // mix(rhs, abs(lhs-rhs), dive)
  float exposure_gain;            // photographic lift on the differenced image
  float edge_artifacts;           // bottom-edge grain flair (0 = clean)
  float _pad0, _pad1;
};

static const float LIGHT_STR = 0.35;  // rhs (light) copy displacement fraction
static const float HEAVY_STR = 1.0;   // lhs (heavy) copy displacement fraction
static const float FLOOR     = 0.004;  // resting-halo floor (reach units) × dive

// Pixulant's salted value-hash of the destination uv.
float s_rand(float2 uv, float salt) {
  return frac(sin(dot(uv, float2(12.9898, 78.233 + salt * 1.56783)))
              * (43758.5453 + salt * 86183.526));
}

// One scatter: random displacement of the sampling uv within the directional
// footprint at `strength`.
float2 foot_scatter(float2 uv, float salt, float strength) {
  float a = s_rand(uv, 0.0 + salt);
  float b = s_rand(uv, 0.1 + salt);

  float proj = clamp(dot(uv - 0.5, float2(major_x, major_y)) * 2.0, -1.0, 1.0);
  float persp = clamp(1.0 - tilt * proj, 0.05, 3.0);

  float floor_r = FLOOR * dive;
  float back = max(reach_back, floor_r);
  float fwd  = max(reach_fwd,  floor_r);
  float wid  = max(width,      floor_r) * persp;

  float m = lerp(-back, fwd, a) * strength;    // major, reach units
  float n = (b - 0.5) * 2.0 * wid * strength;  // minor, reach units
  float2 duv = m * float2(axis_maj_x, axis_maj_y) + n * float2(axis_min_x, axis_min_y);
  return uv + duv;
}

float4 sample_in(float2 uv) {
  float4 c = inputTex.SampleLevel(linearSampler, uv, 0.0);
  // Reproduce Pixulant's bottom-edge bug as opaque-white flair when asked (row 0
  // is the top, so the screen bottom is uv.y > 1).
  if (edge_artifacts > 0.0 && uv.y > 1.0)
    c = lerp(c, float4(1.0, 1.0, 1.0, 1.0), edge_artifacts);
  return c;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);

  float4 rhs = sample_in(foot_scatter(uv, salt_base,        LIGHT_STR));
  float4 lhs = sample_in(foot_scatter(uv, salt_base + 0.7,  HEAVY_STR));

  float3 diff = abs(lhs.rgb - rhs.rgb);
  float3 rgb  = lerp(rhs.rgb, diff, dive) * exposure_gain;
  float  a    = lerp(lhs.a, rhs.a, dive * 0.5);

  outputTex[gid.xy] = float4(saturate(rgb), a);
}
