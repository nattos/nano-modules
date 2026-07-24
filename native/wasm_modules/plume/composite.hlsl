// source.sdf.plume — final composite (fog pipeline only).
//
// Full-res: body from the scene buffer (rgb, .a = hit distance), fog from
// the half-res fog buffer (rgb = in-scatter, .a = transmittance, bilinear
// upsample — fog is soft), over the input, faded by the global opacity.

Texture2D<float4>   sceneTex   : register(t0);
Texture2D<float4>   fogTex     : register(t1);
Texture2D<float4>   bgTex      : register(t2);
SamplerState        linearSamp : register(s3);
RWTexture2D<float4> outTex     : register(u4);

cbuffer CompUniforms : register(b5) {
  float opacity;
  float has_bg;
  float _p0, _p1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float4 bg = has_bg > 0.5 ? bgTex.Load(int3(int(gid.x), int(gid.y), 0))
                           : float4(0.0, 0.0, 0.0, 0.0);
  float4 scene = sceneTex.Load(int3(int(gid.x), int(gid.y), 0));
  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);
  // 4-tap tent upsample of the half-res fog: averages out the march's IGN
  // jitter dither (a single bilinear tap leaves a faint 2-px diamond
  // lattice in high-banding regions, e.g. backlit fog shadows). Fog is
  // soft by construction, so the extra half-texel of blur costs nothing.
  uint FW, FH;
  fogTex.GetDimensions(FW, FH);
  float2 ft = 0.5 / float2(FW, FH);
  float4 fog = (fogTex.SampleLevel(linearSamp, uv + float2( ft.x,  ft.y), 0)
              + fogTex.SampleLevel(linearSamp, uv + float2(-ft.x,  ft.y), 0)
              + fogTex.SampleLevel(linearSamp, uv + float2( ft.x, -ft.y), 0)
              + fogTex.SampleLevel(linearSamp, uv + float2(-ft.x, -ft.y), 0))
             * 0.25;

  // Miss sentinel is 6e4 — the largest sentinel that survives the RGBA16F
  // scene buffer (f16 tops out at 65504; anything bigger reads back NaN).
  bool hit = scene.a < 1.0e4;
  float3 c = hit ? scene.rgb : bg.rgb;
  float cover = hit ? 1.0 : 0.0;

  // Fog integrates in front of the body (the march stopped at its depth).
  c = fog.rgb + c * fog.a;
  cover = max(cover, 1.0 - fog.a);

  float3 outc = lerp(bg.rgb, c, opacity);
  outTex[gid.xy] = float4(outc, max(bg.a, cover * opacity));
}
