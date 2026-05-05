// debug.motion_rect — motion pass.
//
// Writes the per-pixel velocity for the moving rectangle into an
// rgba16float storage texture. .xy is velocity in uv space (current
// frame's pos minus previous frame's pos). Pixels outside the rect
// receive (0, 0, 0, 0). Convention: motion vectors describe how a
// pixel's color content moved over the last frame, so consumers can
// gather backwards along -velocity to reconstruct the trail.

RWTexture2D<float4> motionTex : register(u0);

cbuffer Uniforms : register(b1) {
  float cx;
  float cy;
  float cx_prev;
  float cy_prev;
  float half_w;
  float half_h;
  float _pad_r;
  float _pad_g;
  float _pad_b;
  float _pad0;
  float _pad1;
  float _pad2;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  motionTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  bool inside = (uv.x >= cx - half_w) && (uv.x <= cx + half_w)
             && (uv.y >= cy - half_h) && (uv.y <= cy + half_h);
  float2 vel = inside ? float2(cx - cx_prev, cy - cy_prev) : float2(0, 0);
  motionTex[gid.xy] = float4(vel.x, vel.y, 0.0, 0.0);
}
