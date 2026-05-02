// video.blur — One axis of a separable Gaussian.
//
// Run twice (horizontal, then vertical) for a full 2D blur. 13 taps with
// σ ≈ 2.0 weights. Edge taps clamp to the input edge.

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float dir_x;        // 1 horizontal, 0 vertical
  float dir_y;        // 0 horizontal, 1 vertical
  float spacing_px;   // per-tap distance in pixels
  float _pad;
};

// 13-tap normalized Gaussian (σ ≈ 2.0).
static const float W[13] = {
  0.002216, 0.008764, 0.026995, 0.064759, 0.120985, 0.176033, 0.199471,
  0.176033, 0.120985, 0.064759, 0.026995, 0.008764, 0.002216
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 acc = float4(0, 0, 0, 0);
  for (int i = -6; i <= 6; i++) {
    float ox = i * spacing_px * dir_x;
    float oy = i * spacing_px * dir_y;
    int sx = clamp((int)gid.x + (int)round(ox), 0, (int)w - 1);
    int sy = clamp((int)gid.y + (int)round(oy), 0, (int)h - 1);
    acc += inputTex[uint2(sx, sy)] * W[i + 6];
  }
  outputTex[gid.xy] = acc;
}
