// filter.blur.gaussian — One axis of a separable Gaussian.
//
// CPU-side computes the per-tap weights and the active half-count and
// uploads them via a structured buffer; this shader just does the sum.
// Run twice (horizontal, then vertical) for a full 2D blur.

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float dir_x;        // 1 horizontal pass, 0 vertical pass
  float dir_y;        // 0 horizontal pass, 1 vertical pass
  float spacing_px;   // per-tap distance in pixels (driven by quality only)
  int   half_count;   // number of taps on each side of centre (>=0)
};

// weights[0] = centre weight; weights[i] = symmetric outer-tap weight.
// Length == MAX_HALF_COUNT + 1 on the host side; shader reads up to half_count.
StructuredBuffer<float> weights : register(t3);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 acc = inputTex[gid.xy] * weights[0];
  // The loop bound is dynamic but capped by the host (≤ MAX_HALF_COUNT).
  for (int i = 1; i <= half_count; i++) {
    float ox = float(i) * spacing_px * dir_x;
    float oy = float(i) * spacing_px * dir_y;
    int dx = int(round(ox));
    int dy = int(round(oy));
    int sx_p = clamp((int)gid.x + dx, 0, (int)w - 1);
    int sy_p = clamp((int)gid.y + dy, 0, (int)h - 1);
    int sx_n = clamp((int)gid.x - dx, 0, (int)w - 1);
    int sy_n = clamp((int)gid.y - dy, 0, (int)h - 1);
    acc += weights[i] * (inputTex[uint2(sx_p, sy_p)] + inputTex[uint2(sx_n, sy_n)]);
  }
  outputTex[gid.xy] = acc;
}
