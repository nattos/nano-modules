// debug.lut3d_test — pass 2: nearest-cell 3D-LUT lookup.
//
// For each output pixel, sample the input rgb, round to the closest LUT cell
// (no sampler — Texture3D.Load), and write the LUT color (keeping input alpha).
// An identity LUT round-trips the input within 1-bin quantization. The lut is a
// SAMPLED Texture3D (binding 1); the only storage texture is outputTex
// (rgba8unorm), so the single registerShaderSPV format applies cleanly.
Texture2D<float4>   inputTex  : register(t0);
Texture3D<float4>   lut       : register(t1);
RWTexture2D<float4> outputTex : register(u2);

// LUT side length (matches init.hlsl). Querying a 3D texture's dimensions
// isn't portable across SPIRV-Cross/Metal, so it's a compile-time constant.
static const uint LUT_N = 16u;

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint ow, oh;
  outputTex.GetDimensions(ow, oh);   // 2D storage GetDimensions is portable
  if (gid.x >= ow || gid.y >= oh) return;
  int2 p = int2(gid.xy);
  float4 c = inputTex.Load(int3(p, 0));

  // Nearest-neighbour lookup: round to the closest LUT cell.
  float maxIdx = float(LUT_N - 1u);
  int lx = int(clamp(c.r * maxIdx + 0.5, 0.0, maxIdx));
  int ly = int(clamp(c.g * maxIdx + 0.5, 0.0, maxIdx));
  int lz = int(clamp(c.b * maxIdx + 0.5, 0.0, maxIdx));
  float4 s = lut.Load(int4(lx, ly, lz, 0));

  outputTex[uint2(gid.xy)] = float4(s.rgb, c.a);
}
