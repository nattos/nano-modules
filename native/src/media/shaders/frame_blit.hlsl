// frame_blit.hlsl — place a decoded frame on the clip's canvas (fit / cover /
// stretch / none, then rotate, flip, anchor, scale — frame_blitter.cpp's
// placeGeom computes `place`).
//
// The twin of frame-blitter.ts's BLIT_SHADER. Web runs it as a full-screen-
// triangle fragment pass; this is a compute kernel, which lands on the same
// pixel centres: the fragment's interpolated uv at pixel p is (p + 0.5)/size,
// and `gid` addresses the same top-left-origin grid.
//
// Registers are the host's binding slots (SPIR-V has ONE binding namespace):
// t0 src, s1 linear/clamp sampler, u2 dst, b3 place.

Texture2D<float4>   src_tex : register(t0);
SamplerState        samp    : register(s1);
RWTexture2D<float4> dst_tex : register(u2);

cbuffer Place : register(b3) {
  float4 rect;      // xy origin, zw size — in dst uv
  float4 rotFlip;   // x quarter turns CW, y flipH, z flipV
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  dst_tex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  const float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  const float2 r = (uv - rect.xy) / rect.zw;   // rect-local [0,1]
  const int rot = int(rotFlip.x + 0.5);
  float2 s;
  if (rot == 1)      s = float2(r.y, 1.0 - r.x);         // 90 CW
  else if (rot == 2) s = float2(1.0 - r.x, 1.0 - r.y);
  else if (rot == 3) s = float2(1.0 - r.y, r.x);         // 270 CW
  else               s = r;
  if (rotFlip.y > 0.5) s.x = 1.0 - s.x;
  if (rotFlip.z > 0.5) s.y = 1.0 - s.y;
  // Sample unconditionally, then mask outside-source pixels to transparent.
  const float inside = (s.x >= 0.0 && s.x <= 1.0 && s.y >= 0.0 && s.y <= 1.0) ? 1.0 : 0.0;
  dst_tex[gid.xy] = src_tex.SampleLevel(samp, clamp(s, 0.0, 1.0), 0.0) * inside;
}
