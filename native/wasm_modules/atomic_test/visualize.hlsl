// debug.atomic_test pass 2 — visualizes the bins computed in pass 1.
//
// Reads the 4-bin histogram (now read-only) and writes the normalized bin
// totals into the output channels: bin0 → R, bin1 → G, bin2 → B, bin3 → A.
// "total" is the full pixel count of the viewport, so the channel reaches
// 1.0 only if every pixel landed in that bin.

// inputTex is intentionally declared but unused — kept to demonstrate
// that the explicit-layout path tolerates shader bindings the host
// declares without the shader actually referencing them. Auto-layout
// would have pruned this and rejected our bind group.
Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);
StructuredBuffer<int> bins   : register(t2);

cbuffer Uniforms : register(b3) {
  float total_inv;   // 1.0 / (width * height)
  float _pad_x;
  float _pad_y;
  float _pad_z;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float r = (float)bins[0] * total_inv;
  float g = (float)bins[1] * total_inv;
  float b = (float)bins[2] * total_inv;
  float a = (float)bins[3] * total_inv;
  outputTex[gid.xy] = float4(r, g, b, a);
}
