// video.blur — 5x5 Gaussian-weighted blur with adjustable tap spacing.
//
// Tap spacing comes from the host as `offset_x` / `offset_y`. Weights are
// derived from a separable Gaussian (kernel sigma ≈ 1.0 in tap units).
//
// Outside-frame samples clamp to the edge (HLSL Texture2D[] is clamped),
// which produces a slight edge-darkening with a transparent input — for
// most patches this is the right behaviour.

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float offset_x;
  float offset_y;
  float2 _pad;
};

// Separable Gaussian weights (kernel size 5, σ ~ 1.0):
// {0.0625, 0.25, 0.375, 0.25, 0.0625}
// 2D weights = outer product, normalized.
static const float W[5] = { 0.0625, 0.25, 0.375, 0.25, 0.0625 };

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 acc = float4(0, 0, 0, 0);
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      int sx = (int)gid.x + (int)round(i * offset_x);
      int sy = (int)gid.y + (int)round(j * offset_y);
      sx = clamp(sx, 0, (int)w - 1);
      sy = clamp(sy, 0, (int)h - 1);
      float wt = W[i + 2] * W[j + 2];
      acc += inputTex[uint2(sx, sy)] * wt;
    }
  }
  outputTex[gid.xy] = acc;
}
