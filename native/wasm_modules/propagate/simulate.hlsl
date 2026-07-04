// filter.sim.propagate — Pass 1: diff → inject → wave integrate.
//
// The stateful heart of the effect. One compute pass per frame over a ping-pong
// RGBA16F field packed as .r=u (displacement), .g=v (velocity), .b=luma (this
// frame's input luma, read next frame to diff). We:
//   1. Diff the current input luma against the field's stored luma → a seed
//      wherever the image changed (guarded by have_history so frame 1 doesn't
//      emit a giant global ghost ripple).
//   2. Add a flicker impulse — a grainy, brightness-keyed global kick — so even
//      a static image radiates (the induced-change mechanism).
//   3. Integrate a damped 2D wave equation (velocity/displacement form): the
//      seed kicks velocity, ripples travel outward via the Laplacian, interfere,
//      and decay. dt is baked in (style guide §2.1) and the caller CFL-clamps the
//      speed; we NaN-sanitize + magnitude-clamp for stability (persistent-sim
//      gotcha).
//
// Boundary: neighbour Loads outside the grid return 0 → an absorbing edge (waves
// die at the border instead of reflecting the whole screen full).

#include "nano_color.hlsl"
#include "nano_hash.hlsl"

Texture2D<float4>   prevField : register(t0);   // read via Load (integer coords)
Texture2D<float4>   inputTex  : register(t1);   // sampled at sim-res
SamplerState        samp      : register(s2);   // Linear + ClampToEdge
RWTexture2D<float4> curField  : register(u3);   // RGBA16F storage write

cbuffer Uniforms : register(b4) {
  float dt, c2, damp, stiffness;                 // integrate
  float change_threshold, change_soft, seed_gain, _s0;   // frame-diff seed
  float flicker_pulse, flicker_detail, u_clamp, v_clamp; // flicker + stability
  uint  have_history, frame, _p0, _p1;
};

static const float FLICK_IMPULSE = 18.0;   // flicker kick (independent of change_gain)

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  curField.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;
  int2 p = int2(gid.xy);

  float4 cell    = prevField.Load(int3(p, 0));
  float  u       = cell.r;
  float  v       = cell.g;
  float  lumaOld = cell.b;

  // Laplacian (5-point). Out-of-range Loads return 0 → absorbing boundary.
  float uL = prevField.Load(int3(p + int2(-1,  0), 0)).r;
  float uR = prevField.Load(int3(p + int2( 1,  0), 0)).r;
  float uU = prevField.Load(int3(p + int2( 0, -1), 0)).r;
  float uD = prevField.Load(int3(p + int2( 0,  1), 0)).r;
  float lap = uL + uR + uU + uD - 4.0 * u;

  // Current input luma at this cell.
  float2 uv      = (float2(gid.xy) + 0.5) / float2(W, H);
  float  lumaNow = nano_luminance(inputTex.SampleLevel(samp, uv, 0).rgb);

  // --- Seed ---
  float seed = 0.0;

  // Frame-difference: waves are born on changing pixels.
  if (have_history != 0u) {
    float d   = abs(lumaNow - lumaOld);
    float chg = smoothstep(change_threshold, change_threshold + change_soft, d);
    seed += chg * seed_gain;
  }

  // Flicker inducement: a sparse grainy global impulse, keyed partly on
  // brightness, so a static image re-radiates. flicker_pulse (0..1) both scales
  // and thresholds the grain (fewer cells fire as the pulse decays).
  if (flicker_pulse > 0.0) {
    float g      = nano_hash31i(int3(p, int(frame)));   // stable per-cell grain
    float grain  = saturate(g - (1.0 - flicker_pulse)) / max(flicker_pulse, 1e-3);
    float bright = lerp(1.0, lumaNow, flicker_detail);
    seed += grain * bright * FLICK_IMPULSE;
  }

  // --- Integrate: damped wave, dt baked, then sanitize + clamp ---
  float vn = v + dt * (c2 * lap - stiffness * u - damp * v);
  vn += seed;                                        // impulse kicks velocity
  vn = (vn != vn) ? 0.0 : clamp(vn, -v_clamp, v_clamp);
  float un = u + dt * vn;
  un = (un != un) ? 0.0 : clamp(un, -u_clamp, u_clamp);

  curField[gid.xy] = float4(un, vn, lumaNow, 0.0);
}
