// debug.compute_probe case 1 — a 16x1 ramp, texel i = i/15.
RWTexture2D<float4> ramp : register(u0);

[numthreads(16, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float v = float(gid.x) / 15.0;
  ramp[uint2(gid.x, 0)] = float4(v, v, v, 1.0);
}
