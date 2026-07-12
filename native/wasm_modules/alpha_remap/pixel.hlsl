// Per-pixel kernel for color.alpha.remap.
//
// Runs the ALPHA channel through the same range-remapper the wire "remap" option
// and mod.shaper.remap use. This is a hand-port of tap_mod::applyTapMod
// (native/src/sketch/tap_mod.h) with hasRemap always on — a shader can't include
// the C++ header, so the two must be kept in step by hand. The curve ordinals
// below ARE tap_mod::Curve's, and the pipeline order is identical:
//   normalize over [in_min,in_max] -> (foldback | saturate) -> curve_in ->
//   curve_out -> [out_min,out_max] -> * scale   (scale applied last)
// The final clamp to [0,1] is ours: alpha is a coverage value, and an RGBA16F
// sketch would happily carry an out-of-range one downstream.

struct FuseUniforms {
  float in_min;
  float in_max;
  float out_min;
  float out_max;
  float curve_in;      // tap_mod::Curve ordinal (0 lin, 1 quad, 2 circ, 3 pow, 4 fold)
  float curve_out;
  float exponent;      // Power curve only
  float do_saturate;   // 0/1 — hard-clip out-of-window input
  float scale;
  float _pad0;
  float _pad1;
  float _pad2;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

// Reflect x into [0,1] — period-2 triangle wave (tap_mod::fold01).
float ar_fold01(float x) {
  float m = fmod(x, 2.0);
  if (m < 0.0) m += 2.0;
  return m <= 1.0 ? m : 2.0 - m;
}

// Ease-in shaping curve (tap_mod::baseCurve).
float ar_base_curve(float t, int curve, float e) {
  if (curve == 1) return t * t;
  if (curve == 2) { float s = 1.0 - t * t; return 1.0 - sqrt(max(s, 0.0)); }
  if (curve == 3) return t >= 0.0 ? pow(t, e) : -pow(-t, e);
  if (curve == 4) return ar_fold01(t);
  return t;
}

// Ease-out is the mirror of the ease-in curve; foldback is symmetric.
float ar_shape_out(float t, int curve, float e) {
  if (curve == 4) return ar_fold01(t);
  return 1.0 - ar_base_curve(1.0 - t, curve, e);
}

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  int cin  = (int)u_fuse.curve_in;
  int cout = (int)u_fuse.curve_out;

  float denom = u_fuse.in_max - u_fuse.in_min;
  float t = denom != 0.0 ? (c.a - u_fuse.in_min) / denom : 0.0;

  if (cin == 4 || cout == 4)            t = ar_fold01(t);
  else if (u_fuse.do_saturate >= 0.5)   t = saturate(t);

  t = ar_base_curve(t, cin, u_fuse.exponent);
  t = ar_shape_out(t, cout, u_fuse.exponent);

  float a = u_fuse.out_min + t * (u_fuse.out_max - u_fuse.out_min);
  a *= u_fuse.scale;

  // Straight alpha throughout the chain, so RGB is untouched.
  return float4(c.rgb, saturate(a));
}
