// debug.motion_swarm — motion pass.
//
// Writes the per-pixel velocity for whichever rect contains the
// pixel. Last rect wins on overlap (matches the color pass's blend
// stacking order, so the visible color and the motion vector at any
// pixel describe the SAME rect). Pixels outside every rect get
// (0, 0, 0, 0).
//
// `opacity` from the rect data is intentionally ignored here — a
// fully-transparent rect still drives motion, so callers can use
// motion_swarm to feed motion vectors over an arbitrary background
// texture without staining the colors.

RWTexture2D<float4> motionTex : register(u0);

struct RectInst {
  float4 pos;    // .xy current, .zw previous
  float4 size;
  float4 color;
};
StructuredBuffer<RectInst> rects : register(t1);

cbuffer Uniforms : register(b2) {
  int rect_count;
  int _pad_a;
  int _pad_b;
  int _pad_c;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  motionTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float2 vel = float2(0.0, 0.0);

  for (int i = 0; i < rect_count; i++) {
    RectInst r = rects[i];
    bool inside = (uv.x >= r.pos.x - r.size.x) && (uv.x <= r.pos.x + r.size.x)
               && (uv.y >= r.pos.y - r.size.y) && (uv.y <= r.pos.y + r.size.y);
    if (inside) {
      vel = float2(r.pos.x - r.pos.z, r.pos.y - r.pos.w);
    }
  }
  motionTex[gid.xy] = float4(vel.x, vel.y, 0.0, 0.0);
}
