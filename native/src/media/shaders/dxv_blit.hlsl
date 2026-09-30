// dxv_blit.hlsl — a DXV frame's BC1 staging texture → RGBA8.
//
// SAMPLES (nearest, at texel centres) rather than loading: Metal defines no
// read() on a block-compressed texture, so the portable way through is the
// sampler, and the hardware BC1 unit decompresses on the way out.
//
// Registers: t0 BC1 src, s1 nearest/clamp sampler, u2 dst.

Texture2D<float4>   src_tex : register(t0);
SamplerState        samp    : register(s1);
RWTexture2D<float4> dst_tex : register(u2);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  dst_tex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  dst_tex[gid.xy] = src_tex.SampleLevel(samp, (float2(gid.xy) + 0.5) / float2(w, h), 0.0);
}
