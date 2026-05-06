// debug.motion_swarm — color pass.
//
// Iterates over a storage-buffer array of moving rectangles. For each
// pixel, alpha-blends every containing rectangle's color over the
// running output (last rect wins on overlap, stacked by index). Rects
// with opacity=0 are invisible — but the motion pass still emits
// their velocity, so consumers can observe motion blur on the
// underlying background texture independently of how visible the
// driving rects are.
//
// The per-pixel inner loop is O(N_rects). At MAX_RECTS=64 and
// 1080p that's ~130M comparisons per frame — fine for a debug
// producer; would need a spatial accel if we ever ship something
// like this to production.

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

struct RectInst {
  float4 pos;    // .xy current center (uv), .zw previous center (uv)
  float4 size;   // .xy half-size (uv), .zw padding
  float4 color;  // .rgb color, .a per-rect opacity (multiplied with global)
};
StructuredBuffer<RectInst> rects : register(t2);

cbuffer Uniforms : register(b3) {
  int rect_count;
  int _pad_a;
  int _pad_b;
  int _pad_c;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float4 base = inputTex[gid.xy];
  float3 rgb = base.rgb;

  for (int i = 0; i < rect_count; i++) {
    RectInst r = rects[i];
    bool inside = (uv.x >= r.pos.x - r.size.x) && (uv.x <= r.pos.x + r.size.x)
               && (uv.y >= r.pos.y - r.size.y) && (uv.y <= r.pos.y + r.size.y);
    if (inside) {
      rgb = lerp(rgb, r.color.rgb, saturate(r.color.a));
    }
  }
  outputTex[gid.xy] = float4(rgb, base.a);
}
