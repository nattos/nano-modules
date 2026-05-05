// video.motion_blur — Per-pixel motion blur driven by a velocity texture.
//
// Reads the per-pixel velocity from `motionTex` (in uv space, .xy) and
// samples `inputTex` along the trail [-velocity * strength, 0] in pixel
// space, averaging the taps. The host runs a separate copy fallback
// when no motion texture is bound, so this shader assumes the binding
// is valid.

Texture2D<float4>   inputTex  : register(t0);
Texture2D<float4>   motionTex : register(t1);
RWTexture2D<float4> outputTex : register(u2);

cbuffer Uniforms : register(b3) {
  float strength;
  int   samples;
  float _pad0;
  float _pad1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 vel_uv = motionTex[gid.xy].xy * strength;
  float2 vel_px = vel_uv * float2((float)w, (float)h);

  int N = max(1, samples);
  float4 sum = float4(0, 0, 0, 0);
  // i=0 → no offset (the current pixel); i=N-1 → backwards by full
  // velocity. Range matches "blur the trail behind where the content
  // came from" semantics.
  for (int i = 0; i < N; i++) {
    float t = (N == 1) ? 0.0 : (float(i) / float(N - 1));
    float2 p = float2(gid.xy) - vel_px * t;
    int2 pi = int2(clamp(p, float2(0.0, 0.0), float2((float)w - 1.0, (float)h - 1.0)));
    sum += inputTex[uint2(pi)];
  }
  outputTex[gid.xy] = sum / float(N);
}
