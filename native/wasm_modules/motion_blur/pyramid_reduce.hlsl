// motion.blur — Velocity pyramid construction.
//
// Reduces a 2x2 region of the source motion texture to a single
// pixel that holds the max-magnitude velocity. Dispatched once per
// pyramid level: level 0 reads the full-resolution motion texture,
// each subsequent level reads the previous level's mip via a
// single-mip-view binding (host calls setTextureMip).
//
// Why max-magnitude instead of average? Motion blur reconstructs
// trails by gathering along the dominant velocity. Averaging at
// boundaries would dilute sparse fast-moving features into the
// surrounding still pixels and erase trails entirely. Max preserves
// the "fastest pixel in this region" which is what the gather wants.

Texture2D<float4>   srcTex : register(t0);
RWTexture2D<float4> dstTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint dw, dh;
  dstTex.GetDimensions(dw, dh);
  if (gid.x >= dw || gid.y >= dh) return;

  uint sw, sh;
  srcTex.GetDimensions(sw, sh);

  // 2x2 child positions clamped to the source bounds — the bottom
  // and right edges may have an odd source size.
  uint2 base = gid.xy * 2;
  uint2 c00 = base;
  uint2 c10 = uint2(min(base.x + 1, sw - 1), base.y);
  uint2 c01 = uint2(base.x, min(base.y + 1, sh - 1));
  uint2 c11 = uint2(min(base.x + 1, sw - 1), min(base.y + 1, sh - 1));

  float2 v00 = srcTex[c00].xy;
  float2 v10 = srcTex[c10].xy;
  float2 v01 = srcTex[c01].xy;
  float2 v11 = srcTex[c11].xy;

  float2 best = v00;
  float bestl2 = dot(v00, v00);
  float l;
  l = dot(v10, v10); if (l > bestl2) { bestl2 = l; best = v10; }
  l = dot(v01, v01); if (l > bestl2) { bestl2 = l; best = v01; }
  l = dot(v11, v11); if (l > bestl2) { bestl2 = l; best = v11; }

  dstTex[gid.xy] = float4(best, 0.0, 0.0);
}
