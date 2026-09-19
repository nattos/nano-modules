// sidechannel_blit.hlsl — the executor's nearest-scaling sidechannel blit.
//
// One authored source, translated per backend at PSO-build time (see
// output_blit.hlsl's header for why). The float read/write path also absorbs a
// BGRA↔RGBA channel-order difference a raw byte copy would swap — which is why
// host_sidechannel_blit.h's copy fast path is gated on format EQUALITY.
//
// Registers are the host's binding slots: t0 src, u1 out, b2 uniform.

Texture2D<float4>   src_tex : register(t0);
RWTexture2D<float4> out_tex : register(u1);

cbuffer U : register(b2) {
  uint dw;
  uint dh;
  uint sw;
  uint sh;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= dw || gid.y >= dh) return;
  uint2 sp = uint2(gid.x * sw / dw, gid.y * sh / dh);
  out_tex[gid.xy] = src_tex.Load(int3(int2(sp), 0));
}
