// Video Blend — an A/B CROSSFADER with a blend-mode transition flavor
// (Resolume-crossfader semantics, NOT a layer compositor):
//   opacity 0 → A as-is;  opacity 1 → B as-is (alpha included);
//   in between, A and B each fade by their shaped curve weight and the blend
//   math rides the OVERLAP where both curves are up:
//     C    = blended-over-A at full coverage   (the "blend state")
//     out  = A·(1-w_b) + C·(w_a+w_b-1) + B·(1-w_a)     (premultiplied fold)
// w_a/w_b come CPU-SIDE from main.cpp (sketch/xfade_shape.h): at shape 0 the
// curves don't overlap → a pure linear crossfade (the mode is inert); at
// shape 0.5 (the default) an equal-power fade with the blend flavor in the
// middle; at shape 1 the full three-anchor transition A → blend(A,B) → B.
// The executor's per-effect wet/dry pass (host_blend.h) intentionally KEEPS
// layer-compositor semantics — the two diverged when this node became a
// crossfader. Modes mirror the BlendMode enum in main.cpp (keep in lock-step).

Texture2D<float4> inputA : register(t0);   // base
Texture2D<float4> inputB : register(t1);   // blend
RWTexture2D<float4> outputTex : register(u2);

cbuffer Uniforms : register(b3) {
  float w_a;     // A-side fade weight: xfade::weightA(opacity, shape)
  float w_b;     // B-side fade weight: xfade::weightB(opacity, shape)
  int mode;
  float _pad1;
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
  float4 a = inputA[gid.xy];   // side A
  float4 b = inputB[gid.xy];   // side B
  float3 blended = saturate(blendMode(mode, a.rgb, b.rgb));
  // The full-coverage blend state C: blended over A by B's alpha (straight
  // alpha in/out) — what the crossfade middle shows at shape 1.
  float ca = b.a + a.a * (1.0 - b.a);
  float3 crgb = (ca > 1e-5)
      ? (blended * b.a + a.rgb * a.a * (1.0 - b.a)) / ca
      : float3(0.0, 0.0, 0.0);
  // Three-way transition fold (premultiplied, then unpremultiply). The family
  // guarantees w_a + w_b >= 1, so all three weights are >= 0 and sum to 1.
  float aw = 1.0 - w_b;
  float bw = 1.0 - w_a;
  float cw = w_a + w_b - 1.0;
  float outA = a.a * aw + ca * cw + b.a * bw;
  float3 outc = (outA > 1e-5)
      ? (a.rgb * a.a * aw + crgb * ca * cw + b.rgb * b.a * bw) / outA
      : float3(0.0, 0.0, 0.0);
  outputTex[gid.xy] = float4(outc, outA);
}
