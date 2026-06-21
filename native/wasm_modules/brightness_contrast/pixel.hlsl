// Per-pixel kernel for color.tone.brightness_contrast. See pixel.hlsl
// convention in EFFECTS_STYLE_GUIDE.md §0.1.

struct FuseUniforms {
  float brightness;   // signed [-1, +1], 0 = neutral
  float contrast;     // signed [-1, +1], 0 = identity (1x)
  float _pad0;
  float _pad1;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 rgb = c.rgb;
  rgb += u_fuse.brightness;          // signed shift, [-1, +1]
  rgb *= u_fuse.contrast + 1.0;      // scale from black, [0, 2] (1x at 0)
  return float4(saturate(rgb), c.a);
}
