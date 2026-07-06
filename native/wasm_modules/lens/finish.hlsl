// filter.blur.lens — pass 8 (finish). STAGE 1: straight passthrough copy.
//
// The real finish (exposure → mechanical vignette → highlight desat → filmic
// tonemap → sRGB → grain; pipeline.pass_finish :503) lands in Stage 2. For the
// skeleton this is an identity copy so the chip registers and end-to-end wiring
// is validated.

#include "common.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  outputTex[gid.xy] = inputTex[gid.xy];
}
