// Per-pixel kernel for video.posterize — snap RGB (and optionally alpha)
// to N evenly-spaced levels.

struct FuseUniforms {
  float levels;
  float quantize_alpha;
  float _pad0;
  float _pad1;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float quantize_channel(float x, float n) {
  float steps = max(n - 1.0, 1.0);
  return round(saturate(x) * steps) / steps;
}

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 rgb = float3(
    quantize_channel(c.r, u_fuse.levels),
    quantize_channel(c.g, u_fuse.levels),
    quantize_channel(c.b, u_fuse.levels)
  );
  float a = lerp(c.a, quantize_channel(c.a, u_fuse.levels), u_fuse.quantize_alpha);
  return float4(rgb, a);
}
