// blend.hlsl — the executor's wet/dry opacity blend + per-effect blend modes.
//
// ONE authored source for all three backends: DXC bakes it to SPIR-V at build
// time (build_shaders.sh) and the host translates it to MSL / HLSL / WGSL at
// PSO-build time, exactly as effect shaders already do. The semantics — the two
// blend regimes, the crossfade shape morph, why mode 0 stays a straight lerp —
// are documented in host_blend.h; only the math lives here.
//
// The blend_mode() switch stays in LOCK-STEP with video_blend/compute.hlsl
// (which is a crossfader, not a layer compositor — see host_blend.h).
//
// Register numbers ARE the host's binding slots: t0 dry, t1 fx, u2 out,
// b3 uniform. Textures first, uniform after (WebGPU auto-layout shares one
// @binding namespace per group).

Texture2D<float4>   dry_tex : register(t0);
Texture2D<float4>   fx_tex  : register(t1);
RWTexture2D<float4> out_tex : register(u2);

cbuffer U : register(b3) {
  uint  gw;       // canvas width  (out-of-range gate)
  uint  gh;       // canvas height
  float opacity;
  uint  mode;     // BlendMode enum: 0 = Normal crossfade, 1..15 = blend math
  float wA;       // fade weights, CPU-computed via xfade_shape.h
  float wB;
  float shape;    // 0 = legacy linear fade
  float pad;
};

float3 b_screen(float3 a, float3 b)    { return 1.0 - (1.0 - a) * (1.0 - b); }
float3 b_overlay(float3 a, float3 b)   { return lerp(2.0*a*b, 1.0 - 2.0*(1.0-a)*(1.0-b), step(float3(0.5, 0.5, 0.5), a)); }
float3 b_dodge(float3 a, float3 b)     { return min(float3(1.0, 1.0, 1.0), a / max(1.0 - b, float3(1e-4, 1e-4, 1e-4))); }
float3 b_burn(float3 a, float3 b)      { return 1.0 - min(float3(1.0, 1.0, 1.0), (1.0 - a) / max(b, float3(1e-4, 1e-4, 1e-4))); }
float3 b_softlight(float3 a, float3 b) { return (1.0 - 2.0*b) * a * a + 2.0 * b * a; }
float3 b_divide(float3 a, float3 b)    { return min(float3(1.0, 1.0, 1.0), a / max(b, float3(1e-4, 1e-4, 1e-4))); }

float3 blend_mode(uint m, float3 a, float3 b) {
  switch (m) {
    case 1:  return min(a + b, float3(1.0, 1.0, 1.0));      // Add (linear dodge)
    case 2:  return a * b;                                  // Multiply
    case 3:  return b_screen(a, b);                         // Screen
    case 4:  return b_overlay(a, b);                        // Overlay
    case 5:  return min(a, b);                              // Darken
    case 6:  return max(a, b);                              // Lighten
    case 7:  return b_dodge(a, b);                          // Color Dodge
    case 8:  return b_burn(a, b);                           // Color Burn
    case 9:  return b_overlay(b, a);                        // Hard Light (overlay, swapped)
    case 10: return b_softlight(a, b);                      // Soft Light
    case 11: return abs(a - b);                             // Difference
    case 12: return a + b - 2.0*a*b;                        // Exclusion
    case 13: return max(a - b, float3(0.0, 0.0, 0.0));      // Subtract
    case 14: return b_divide(a, b);                         // Divide
    case 15: return max(a + b - 1.0, float3(0.0, 0.0, 0.0)); // Linear Burn
    default: return b;                                      // 0: Normal
  }
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x >= gw || gid.y >= gh) return;
  int3 p = int3(int2(gid.xy), 0);
  float4 a = dry_tex.Load(p);
  float4 b = fx_tex.Load(p);
  if (mode == 0) {
    float4 m = lerp(a, b, opacity);
    if (shape <= 0.0) {          // legacy lerp, bit-exact (incl. copyToOutput)
      out_tex[gid.xy] = m;
      return;
    }
    // Weighted straight-alpha over: b(alpha*wB) over a(alpha*wA), morphed in
    // by shape (see host_blend.h).
    float topA0 = saturate(b.a * wB);
    float baseA = a.a * wA;
    float overA = topA0 + baseA * (1.0 - topA0);
    float3 overc = float3(0.0, 0.0, 0.0);
    if (overA > 1e-5) {
      overc = (b.rgb * topA0 + a.rgb * baseA * (1.0 - topA0)) / overA;
    }
    out_tex[gid.xy] = lerp(m, float4(overc, overA), shape);
    return;
  }
  float3 blended = saturate(blend_mode(mode, a.rgb, b.rgb));
  float topA = saturate(b.a * wB);
  float outA = topA + a.a * (1.0 - topA);
  float3 outc = float3(0.0, 0.0, 0.0);
  if (outA > 1e-5) {
    outc = (blended * topA + a.rgb * a.a * (1.0 - topA)) / outA;
  }
  out_tex[gid.xy] = float4(outc, outA);
}
