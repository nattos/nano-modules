// filter.sim.propagate — Pass 1: seed → advect outward → diffuse → decay.
//
// NOT a physical wave equation (that is CFL-capped to ~1 cell/frame — far too
// slow, and it keeps high-frequency detail that thresholds into mud). Instead
// this is an OUTWARD-ADVECTION feedback field that retains the input's rough
// structure while its features blur out as they travel:
//
//   1. SEED from the input's STRUCTURE (its luma), not random noise. A
//      frame-difference seeds where the image changes; "flicker" re-injects the
//      whole input each pulse (flickering the image) so a STATIC image radiates.
//   2. ADVECT the field outward along its own smoothed gradient: every pixel
//      samples the field from the toward-a-brighter-core side, so bright features
//      spread AWAY from themselves — a ring dilates into an expanding ring. The
//      step is a free parameter (no CFL limit), so max speed crosses the screen
//      in a few frames.
//   3. DIFFUSE (blend toward the local average) so features soften as they
//      propagate — the "blurs out as it travels" look.
//   4. DECAY so trailing fronts fade; re-seeding each frame keeps a train of
//      expanding echoes alive.
//
// The field (RGBA16F) packs .r = F (intensity), .b = luma (this frame's input
// luma → next frame's frame-diff). Boundary: out-of-range Loads read 0.

#include "nano_color.hlsl"

Texture2D<float4>   prevField : register(t0);   // Load (gradient) + Sample (advect)
Texture2D<float4>   inputTex  : register(t1);   // input structure to seed from
SamplerState        samp      : register(s2);   // Linear + ClampToEdge
RWTexture2D<float4> curField  : register(u3);   // RGBA16F storage write

cbuffer Uniforms : register(b4) {
  float dt, step, decay, diffuse;                        // propagate (step in cells)
  float change_threshold, change_soft, change_gain, flicker_seed;  // seed
  float feed, f_clamp, _p0, _p1;
  uint  have_history, frame, _u0, _u1;
};

static const int GRAD = 2;   // gradient tap radius (cells) — smooths the field

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  curField.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  int2  p  = int2(gid.xy);
  float2 uv = (float2(gid.xy) + 0.5) / float2(W, H);

  float lumaOld = prevField.Load(int3(p, 0)).b;

  // Smoothed gradient (points toward a brighter core). An 8-tap Sobel keeps the
  // advection direction isotropic (a 4-tap axis gradient makes octagonal rings);
  // the wide taps low-pass the field so the direction follows the gross
  // structure, not noise.
  float fL  = prevField.Load(int3(p + int2(-GRAD,     0), 0)).r;
  float fR  = prevField.Load(int3(p + int2( GRAD,     0), 0)).r;
  float fU  = prevField.Load(int3(p + int2(    0, -GRAD), 0)).r;
  float fD  = prevField.Load(int3(p + int2(    0,  GRAD), 0)).r;
  float fTL = prevField.Load(int3(p + int2(-GRAD, -GRAD), 0)).r;
  float fTR = prevField.Load(int3(p + int2( GRAD, -GRAD), 0)).r;
  float fBL = prevField.Load(int3(p + int2(-GRAD,  GRAD), 0)).r;
  float fBR = prevField.Load(int3(p + int2( GRAD,  GRAD), 0)).r;
  float2 grad = float2((fR - fL) + 0.5 * ((fTR + fBR) - (fTL + fBL)),
                       (fD - fU) + 0.5 * ((fBL + fBR) - (fTL + fTR)));
  float  glen = length(grad);
  float2 dir  = (glen > 1e-5) ? grad / glen : float2(0.0, 0.0);

  // Advect OUTWARD: sample the previous field from the toward-core side, so the
  // core's brightness lands here (content moves away from the core). step is in
  // cells → convert to uv. ClampToEdge handles off-texture reads.
  float2 apos = uv + dir * (step / float2(W, H));
  float  adv  = prevField.SampleLevel(samp, apos, 0).r;

  // Diffuse — soften as it propagates (blend toward the 8-neighbour average).
  float avg  = (fL + fR + fU + fD + fTL + fTR + fBL + fBR) * 0.125;
  float prop = lerp(adv, avg, diffuse) * decay;

  // Seed from the input's STRUCTURE (its luma).
  float lumaNow = nano_luminance(inputTex.SampleLevel(samp, uv, 0).rgb);
  float seed = feed * lumaNow;                       // optional continuous feed
  if (have_history != 0u) {                          // frame-difference
    float d = abs(lumaNow - lumaOld);
    seed += smoothstep(change_threshold, change_threshold + change_soft, d) * change_gain;
  }
  seed += flicker_seed * lumaNow;                    // flicker re-injects structure

  float F = prop + seed;
  F = (F != F) ? 0.0 : clamp(F, 0.0, f_clamp);
  curField[gid.xy] = float4(F, 0.0, lumaNow, 0.0);
}
