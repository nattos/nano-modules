// Video Blend — composites two input textures with a selectable blend mode.
//   blended = mode(A, B);  output = lerp(A, blended, opacity)
// Modes mirror the BlendMode enum in main.cpp (keep in lock-step).

Texture2D<float4> inputA : register(t0);   // base
Texture2D<float4> inputB : register(t1);   // blend
RWTexture2D<float4> outputTex : register(u2);

cbuffer Uniforms : register(b3) {
  float opacity;
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
  float4 a = inputA[gid.xy];
  float4 b = inputB[gid.xy];
  float3 blended = saturate(blendMode(mode, a.rgb, b.rgb));
  float3 outc = lerp(a.rgb, blended, opacity);
  outputTex[gid.xy] = float4(outc, 1.0);
}
