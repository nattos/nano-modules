// Per-pixel kernel for video.brightness_contrast. See pixel.hlsl
// convention in EFFECTS_STYLE_GUIDE.md §0.1.

struct FuseUniforms {
  float brightness;   // 0-1, 0.5 = neutral
  float contrast;     // 0-1, 0.5 = identity (1x)
  float _pad0;
  float _pad1;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 rgb = c.rgb;
  rgb += (u_fuse.brightness - 0.5) * 2.0;  // shift RGB by [-1, +1]
  rgb *= u_fuse.contrast * 2.0;            // scale from black
  return float4(saturate(rgb), c.a);
}
