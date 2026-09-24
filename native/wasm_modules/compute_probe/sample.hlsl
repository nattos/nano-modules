// debug.compute_probe case 1 — sample the ramp OUTSIDE 0..1 through three
// samplers: the output's thirds are Repeat | Mirror | ClampToEdge.
//
// u = 1 + 4.5/16 lands on a texel centre after wrapping, so nearest filtering
// is exact:  Repeat → texel 4 (4/15)   Mirror → texel 11 (11/15)   Clamp → 1.
Texture2D<float4> ramp : register(t0);
SamplerState sRepeat : register(s1);
SamplerState sMirror : register(s2);
SamplerState sClamp  : register(s3);
RWTexture2D<float4> outTex : register(u4);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float2 uv = float2(1.0 + 4.5 / 16.0, 0.5);
  uint band = (gid.x * 3u) / w;
  float v;
  if (band == 0u)      v = ramp.SampleLevel(sRepeat, uv, 0.0).r;
  else if (band == 1u) v = ramp.SampleLevel(sMirror, uv, 0.0).r;
  else                 v = ramp.SampleLevel(sClamp,  uv, 0.0).r;
  outTex[gid.xy] = float4(v, 0.0, 0.0, 1.0);
}
