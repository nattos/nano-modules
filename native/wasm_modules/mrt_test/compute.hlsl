// debug.mrt_test combine — read both MRT scratch textures, write a
// "both-channels-merged" pixel into the visible output.

Texture2D<float4>   scratchA  : register(t0);
Texture2D<float4>   scratchB  : register(t1);
RWTexture2D<float4> outputTex : register(u2);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float r = scratchA[gid.xy].r;
  float g = scratchB[gid.xy].g;
  outputTex[gid.xy] = float4(r, g, 0.0, 1.0);
}
