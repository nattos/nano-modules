// debug.compute_probe cases 3/4 — fill the output with a CPU-chosen colour.
cbuffer Fill : register(b0) {
  float4 color;
};
RWTexture2D<float4> outTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  outTex[gid.xy] = color;
}
