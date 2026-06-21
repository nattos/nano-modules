// color.saturate — Per-channel tanh soft-clip with linear deadzone.
//
// The per-pixel transform lives in pixel.hlsl (so the runtime fuser
// can splice it into a fused dispatch). This file is just the
// standalone compute wrapper. See pixel.hlsl for the math.

#include "pixel.hlsl"

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

// pixel.hlsl declares u_fuse at register(b2) — the same slot main.cpp's
// gpu::Bindings layout uses. Standalone path: textures at 0/1, uniform
// at 2. Fragment path: same WGSL/MSL emitted, runtime renumbers the
// uniform binding when composing a fused shader.

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 c = inputTex[gid.xy];
  outputTex[gid.xy] = fuse_transform(gid.xy, c);
}
