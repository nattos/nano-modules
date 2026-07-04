// filter.sim.simulant — Pass D: the line extractor (display branch).
//
// Faithful port of the original's output chain reading accumRaw (node 20 out):
//   resize → Transform(Zoom) → Pixel Blur(Smoothing, done upstream) →
//   Bright.Contrast("Levels" bias/contrast, node 144) → Posterize(node 64) →
//   Edge Detection(Sobel, strength + sample-offset=Line Width, node 65) →
//   Crop(1px right/bottom, node 149) → Replace Alpha 1 (node 155) → out.
//
// The output is the extracted LINE FIELD (opaque), NOT composited over the
// original — the input shows through only because it continuously seeds the
// accumulator. Runs at viewport res, sampling the sim-res smoothed field.

#include "nano_color.hlsl"

Texture2D<float4>   fieldTex : register(t0);   // smoothed accumRaw (sim-res)
SamplerState        samp     : register(s1);   // Linear + ClampToEdge
RWTexture2D<float4> outTex   : register(u2);   // rgba8

cbuffer Uniforms : register(b3) {
  float zoom, level_bias, level_contrast, posterize_levels;
  float edge_strength, line_width_px, crop_right, crop_bottom;
  float line_r, line_g, line_b, _p1;
};

// Levels (node 144) then Posterize (node 64) on a sampled luma.
float sample_luma(float2 uv) {
  float3 c = fieldTex.SampleLevel(samp, uv, 0).rgb;
  float g = nano_luminance(c);
  g = saturate((g - 0.5) * (1.0 + level_contrast) + 0.5 + level_bias);
  float L = max(posterize_levels, 2.0);
  g = floor(g * L + 0.5) / L;                 // posterize
  return g;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);

  // Crop (node 149): trim the right / bottom edge (a faithful artifact guard).
  if (uv.x > 1.0 - crop_right || uv.y > 1.0 - crop_bottom) {
    outTex[gid.xy] = float4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Zoom about centre (Transform, node 116).
  float2 zuv = (uv - 0.5) / max(zoom, 1e-4) + 0.5;

  // Sobel over the levelled/posterized luma. sample-offset = Line Width (px).
  float2 o = line_width_px / float2(W, H);
  float tl = sample_luma(zuv + float2(-o.x, -o.y));
  float tc = sample_luma(zuv + float2( 0.0, -o.y));
  float tr = sample_luma(zuv + float2( o.x, -o.y));
  float ml = sample_luma(zuv + float2(-o.x,  0.0));
  float mr = sample_luma(zuv + float2( o.x,  0.0));
  float bl = sample_luma(zuv + float2(-o.x,  o.y));
  float bc = sample_luma(zuv + float2( 0.0,  o.y));
  float br = sample_luma(zuv + float2( o.x,  o.y));
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  float edge = saturate(sqrt(gx * gx + gy * gy) * edge_strength);

  float3 col = edge * float3(line_r, line_g, line_b);
  outTex[gid.xy] = float4(col, 1.0);   // Replace Alpha 1
}
