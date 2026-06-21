// filter.edges — Sobel edge detection over input luminance.

#include "nano_color.hlsl"

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float threshold;
  float keep_input;
  float radius_px;
  float line_r;
  float line_g;
  float line_b;
  float bg_r;
  float bg_g;
  float bg_b;
  float _pad0;
  float _pad1;
  float _pad2;
};

// (luminance helper provided by nano_color.hlsl)

float lum_at(int x, int y, int w, int h) {
  uint2 p = uint2(clamp(x, 0, w - 1), clamp(y, 0, h - 1));
  return nano_luminance(inputTex[p].rgb);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  int r = max(1, (int)round(radius_px));
  int x = (int)gid.x;
  int y = (int)gid.y;

  float tl = lum_at(x - r, y - r, w, h);
  float t  = lum_at(x,     y - r, w, h);
  float tr = lum_at(x + r, y - r, w, h);
  float l  = lum_at(x - r, y,     w, h);
  float rr = lum_at(x + r, y,     w, h);
  float bl = lum_at(x - r, y + r, w, h);
  float bb = lum_at(x,     y + r, w, h);
  float br = lum_at(x + r, y + r, w, h);

  // Sobel kernels.
  float gx = (tr + 2.0 * rr + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * bb + br) - (tl + 2.0 * t + tr);
  float mag = sqrt(gx * gx + gy * gy);

  // Smooth threshold: full pass at threshold + 0.05.
  float edge = smoothstep(threshold, threshold + 0.05, mag);

  float3 line_col = float3(line_r, line_g, line_b);
  float3 bg_col   = float3(bg_r,   bg_g,   bg_b);
  float3 src_rgb  = inputTex[gid.xy].rgb;

  // Where there's no edge, optionally blend back to source.
  float3 base = lerp(bg_col, src_rgb, keep_input);
  float3 detected = lerp(base, line_col, edge);

  outputTex[gid.xy] = float4(saturate(detected), inputTex[gid.xy].a);
}
