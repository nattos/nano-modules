// source.mesh.monolith — bloom highlight extract.
//
// Pulls the >1.0 HDR overflow out of composite + rays, range-compressed
// by 1/4 so it survives FastBlur's SketchDefault (possibly 8-bit)
// scratch; the final combine re-expands it. Threshold at 1.0 means LDR
// input passthrough pixels can never generate bloom.

Texture2D<float4>   compTex : register(t0);
Texture2D<float4>   raysTex : register(t1);   // 1x1 zero when rays skipped
RWTexture2D<float4> dstTex  : register(u2);

cbuffer Uniforms : register(b3) {
  float4 p;   // x = inv_range (0.25), y = has_rays
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  dstTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  int3 ip = int3(int(gid.x), int(gid.y), 0);
  float3 hdr = compTex.Load(ip).rgb + raysTex.Load(ip).rgb * p.y;
  float3 e = saturate(max(hdr - 1.0, 0.0) * p.x);
  dstTex[gid.xy] = float4(e, 1.0);
}
