// debug.motion_rect — motion pass.
//
// Writes the per-pixel velocity for the moving rectangle into an
// rgba16float storage texture. Pixels inside the rect get the rect's
// per-frame velocity; pixels outside inherit `upstreamMotion` (the
// previous stage's render_outputs/motion when our render_outputs_in
// input is connected, or zero when nothing is upstream — bound as a
// 1x1 zero fallback by the host in that case).
//
// Convention: motion vectors describe how a pixel's color content moved
// over the last frame, so consumers can gather backwards along
// -velocity to reconstruct the trail.
//
// `opacity` (used by the color pass) does NOT affect the motion
// vectors. A mostly-transparent rect still emits full-strength velocity
// so consumers can see how the underlying background texture would be
// motion-blurred — separating "what's in motion" from "how visible the
// moving feature is."

RWTexture2D<float4> motionTex      : register(u0);
Texture2D<float4>   upstreamMotion : register(t2);

cbuffer Uniforms : register(b1) {
  float cx;
  float cy;
  float cx_prev;
  float cy_prev;
  float half_w;
  float half_h;
  float _pad0;
  float _pad1;
  float _pad_color_r;
  float _pad_color_g;
  float _pad_color_b;
  float _pad_opacity;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  motionTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  bool inside = (uv.x >= cx - half_w) && (uv.x <= cx + half_w)
             && (uv.y >= cy - half_h) && (uv.y <= cy + half_h);
  float2 local = inside ? float2(cx - cx_prev, cy - cy_prev) : float2(0, 0);

  // Out-of-bounds loads on the 1x1 zero fallback texture return zero
  // per WebGPU spec, so this is a safe unconditional read whether or
  // not an upstream motion writer is wired in.
  float2 upstream = upstreamMotion[gid.xy].xy;

  // Binary mix: where this stage emits motion, override; where it
  // doesn't, pass upstream through. A length test on `local` would be
  // overly conservative — the rect's per-frame delta can legitimately
  // round to zero when stationary, in which case "outside-or-stationary
  // → upstream" is exactly what we want.
  float2 vel = inside ? local : upstream;
  motionTex[gid.xy] = float4(vel.x, vel.y, 0.0, 0.0);
}
