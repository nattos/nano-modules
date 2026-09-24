// debug.compute_probe case 2 — read the formats back:
//   R = the RGBA32F texel kept 70000 exactly (1 or 0)
//   G = the RGBA8_SRGB render target cleared to linear 0.5, read back linear
//   B = the CPU-side format checks (defaultTextureFormat, textureFormat)
Texture2D<float4> big  : register(t0);
Texture2D<float4> srgb : register(t1);
cbuffer Flags : register(b2) {
  float cpu_ok;
  float _pad0;
  float _pad1;
  float _pad2;
};
RWTexture2D<float4> outTex : register(u3);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float f32_ok = big.Load(int3(0, 0, 0)).r == 70000.0 ? 1.0 : 0.0;
  float s = srgb.Load(int3(0, 0, 0)).r;
  outTex[gid.xy] = float4(f32_ok, s, cpu_ok, 1.0);
}
