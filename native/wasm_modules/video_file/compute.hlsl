// source.video.file — copies the host-injected decoded frame to the output.
// The frame texture is pre-scaled to the render size by the host blit, so this
// is a straight 1:1 copy.

Texture2D<float4>   inputTex  : register(t0);   // host-injected "frame"
RWTexture2D<float4> outputTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  outputTex[gid.xy] = inputTex[gid.xy];
}
