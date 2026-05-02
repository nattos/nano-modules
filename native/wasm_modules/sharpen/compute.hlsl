// video.sharpen — Discrete Laplacian sharpen with adjustable radius.
// Edge taps clamp to the image edge.

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float amount;     // 0..1
  float radius_px;  // 1..N
  float2 _pad;
};

float4 sample_clamped(int x, int y, int w, int h) {
  return inputTex[uint2(clamp(x, 0, w - 1), clamp(y, 0, h - 1))];
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  int r = max(1, (int)round(radius_px));
  int x = (int)gid.x;
  int y = (int)gid.y;

  float4 c = inputTex[gid.xy];
  float4 up    = sample_clamped(x,     y - r, w, h);
  float4 down  = sample_clamped(x,     y + r, w, h);
  float4 left  = sample_clamped(x - r, y,     w, h);
  float4 right = sample_clamped(x + r, y,     w, h);

  float4 hp = (4.0 * c) - (up + down + left + right);
  float4 sharp = c + amount * hp;
  outputTex[gid.xy] = float4(saturate(sharp.rgb), c.a);
}
