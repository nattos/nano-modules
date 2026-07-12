// Per-pixel kernel for color.colorize — tint the image toward one colour.
//
// Three ways to apply the tint, all of them a plain function of the pixel's
// Rec.709 luma and the target colour:
//   Luma     tinted = colour * luma        (classic colorize: chroma replaced,
//                                           brightness kept — white → the colour)
//   Multiply tinted = rgb * colour         (a gel over the lens: darkens, keeps chroma)
//   Screen   tinted = 1 - (1-rgb)(1-colour) (a wash of light: lifts, never darkens)
// `amount` then cross-fades the original against it.

struct FuseUniforms {
  float r, g, b;
  float amount;
  float mode;     // 0 = luma, 1 = multiply, 2 = screen
  float _pad0, _pad1, _pad2;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  float3 col = float3(u_fuse.r, u_fuse.g, u_fuse.b);
  float3 rgb = c.rgb;

  float luma = dot(rgb, float3(0.2126, 0.7152, 0.0722));
  float3 tinted = col * luma;
  if (u_fuse.mode > 1.5)      tinted = 1.0 - (1.0 - rgb) * (1.0 - col);
  else if (u_fuse.mode > 0.5) tinted = rgb * col;

  return float4(saturate(lerp(rgb, tinted, saturate(u_fuse.amount))), c.a);
}
