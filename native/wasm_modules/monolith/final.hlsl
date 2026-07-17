// source.mesh.monolith — final combine + tonemap.
//
// hdr = composite + rays + bloom, shoulder tonemap (identity below 1.0,
// C1 shoulder above), written to tex_out. Pixels with no shape coverage
// AND no ray/bloom contribution copy the input VERBATIM — the
// passthrough guarantee. Rays/bloom slots are bound to a 1x1 zero
// texture when their passes are skipped (OOB Loads return zero).

Texture2D<float4>   compTex  : register(t0);
Texture2D<float4>   raysTex  : register(t1);
Texture2D<float4>   bloomTex : register(t2);
Texture2D<float4>   inTex    : register(t3);
RWTexture2D<float4> outTex   : register(u4);

cbuffer Uniforms : register(b5) {
  float4 p;   // x = bloom gain (range-expanded), y = has_rays, z = has_bloom
};

float shoulder(float x) {
  return x <= 1.0 ? x : 2.0 - 1.0 / x;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  int3 ip = int3(int(gid.x), int(gid.y), 0);

  float4 c = compTex.Load(ip);
  float3 add = raysTex.Load(ip).rgb * p.y + bloomTex.Load(ip).rgb * p.x * p.z;
  float4 inp = inTex.Load(ip);
  if (c.a <= 0.0 && (add.x + add.y + add.z) < 1e-5) {
    outTex[gid.xy] = inp;   // bit-exact passthrough
    return;
  }

  float3 hdr = clamp(c.rgb + add, 0.0, 64.0);
  float3 tm = float3(shoulder(hdr.x), shoulder(hdr.y), shoulder(hdr.z));
  outTex[gid.xy] = float4(tm, max(inp.a, saturate(c.a)));
}
