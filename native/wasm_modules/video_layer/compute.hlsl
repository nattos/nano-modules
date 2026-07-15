// Layer Blend — a LAYER COMPOSITOR (the counterpart of composite.blend's
// crossfader): lays B over A with a selectable blend mode.
//   blended = mode(A.rgb, B.rgb)
//   output  = (blended) OVER A, using B's alpha × w_b  (Porter-Duff source-over)
// Opacity 1 shows the FULL-strength blend (Multiply-at-1 = A×B); alpha is
// PRESERVED, so a transparent B reveals A and the composite carries real
// transparency downstream. For opaque inputs this reduces to
// lerp(A, blended, w_b) with alpha 1.
// `w_b` comes CPU-SIDE from main.cpp (sketch/xfade_shape.h): opacity bent by
// the `shape` fade curve — shape 0 (default) is the plain linear ramp, so the
// arrangement's layer compositing (comp/sketch_build.h synthesizes THIS
// effect per layer) stays a straight wet/dry. Same coverage semantics as the
// executor's per-effect pass (host_blend.h). Modes mirror the BlendMode enum
// in main.cpp (keep in lock-step).

Texture2D<float4> inputA : register(t0);   // base
Texture2D<float4> inputB : register(t1);   // blend
RWTexture2D<float4> outputTex : register(u2);

cbuffer Uniforms : register(b3) {
  float w_b;     // top coverage weight: xfade::weightB(opacity, shape)
  int mode;
  float _pad1;
  float _pad2;
};

// --- per-channel blend primitives (componentwise on float3) ---
// The min/max clamps double as the divide-by-zero guards (dodge/burn/divide),
// so these stay branch-free.
float3 b_screen(float3 a, float3 b)    { return 1.0 - (1.0 - a) * (1.0 - b); }
float3 b_overlay(float3 a, float3 b)   { return lerp(2.0*a*b, 1.0 - 2.0*(1.0-a)*(1.0-b), step(0.5, a)); }
float3 b_dodge(float3 a, float3 b)     { return min(1.0, a / max(1.0 - b, 1e-4)); }
float3 b_burn(float3 a, float3 b)      { return 1.0 - min(1.0, (1.0 - a) / max(b, 1e-4)); }
// Pegtop soft light — smooth, branch-free, visually close to the Photoshop curve.
float3 b_softlight(float3 a, float3 b) { return (1.0 - 2.0*b) * a * a + 2.0 * b * a; }
float3 b_divide(float3 a, float3 b)    { return min(1.0, a / max(b, 1e-4)); }

float3 blendMode(int m, float3 a, float3 b) {
  switch (m) {
    case 1:  return min(a + b, 1.0);              // Add (linear dodge)
    case 2:  return a * b;                        // Multiply
    case 3:  return b_screen(a, b);               // Screen
    case 4:  return b_overlay(a, b);              // Overlay
    case 5:  return min(a, b);                    // Darken
    case 6:  return max(a, b);                    // Lighten
    case 7:  return b_dodge(a, b);                // Color Dodge
    case 8:  return b_burn(a, b);                 // Color Burn
    case 9:  return b_overlay(b, a);              // Hard Light (overlay, swapped)
    case 10: return b_softlight(a, b);            // Soft Light
    case 11: return abs(a - b);                   // Difference
    case 12: return a + b - 2.0*a*b;              // Exclusion
    case 13: return max(a - b, 0.0);              // Subtract
    case 14: return b_divide(a, b);               // Divide
    case 15: return max(a + b - 1.0, 0.0);        // Linear Burn
    default: return b;                            // 0: Normal
  }
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  float4 a = inputA[gid.xy];   // base (the layers below / accumulator)
  float4 b = inputB[gid.xy];   // top layer
  float3 blended = saturate(blendMode(mode, a.rgb, b.rgb));
  // Source-over: composite the blended top over the base by the top's coverage
  // (its alpha × the shaped fade weight). Straight-alpha in/out. Opaque inputs →
  // lerp(a, blended, w_b) with alpha 1; a transparent top reveals the base.
  float topA = saturate(b.a * w_b);
  float outA = topA + a.a * (1.0 - topA);
  float3 outc = (outA > 1e-5)
      ? (blended * topA + a.rgb * a.a * (1.0 - topA)) / outA
      : float3(0.0, 0.0, 0.0);
  outputTex[gid.xy] = float4(outc, outA);
}
