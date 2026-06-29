// filter.legacy.subtle_blur — chromatic-offset pass.
//
// Reads the (already blurred) image and resamples each colour channel at a
// slightly different UV offset, producing a soft RGB fringe. The three
// channel offsets are equal-magnitude unit vectors spaced 120° apart around a
// base angle, so the split is prismatic and even rather than biased to one
// axis. The base angle slowly DRIFTS over time (the accumulator lives in
// main.cpp's tick()), which gives the "slowly shifting bloom" the original
// Wire "Subtle Blur" got from a Saw-driven blue offset + randomized R/G/B
// directions. v2 re-architecture: a single rotating 120°-separated basis
// instead of three independently-randomized direction vectors (flagged in
// main.cpp).
//
// Offsets are scaled by `aspect` = (min(W,H)/W, min(W,H)/H) so a given
// magnitude is the same fraction of the SHORT viewport axis on both axes —
// the fringe stays isotropic on any aspect ratio (style guide §1.4).

Texture2D<float4>   inputTex      : register(t0);
SamplerState        linearSampler : register(s1);
RWTexture2D<float4> outputTex     : register(u2);

cbuffer Uniforms : register(b3) {
  float aspect_x;     // min(W,H)/W
  float aspect_y;     // min(W,H)/H
  float mag;          // channel offset magnitude (uv, short-axis fraction)
  float base_angle;   // hue bias + drift phase (radians)
};

static const float TAU      = 6.28318530717958647692;
static const float THIRD    = 2.09439510239319549231; // TAU / 3

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 uv  = (float2(gid.xy) + 0.5) / float2(W, H);
  float2 asp = float2(aspect_x, aspect_y);

  float aR = base_angle;
  float aG = base_angle + THIRD;
  float aB = base_angle + 2.0 * THIRD;

  float2 oR = float2(cos(aR), sin(aR)) * mag * asp;
  float2 oG = float2(cos(aG), sin(aG)) * mag * asp;
  float2 oB = float2(cos(aB), sin(aB)) * mag * asp;

  float r = inputTex.SampleLevel(linearSampler, uv + oR, 0.0).r;
  float g = inputTex.SampleLevel(linearSampler, uv + oG, 0.0).g;
  float b = inputTex.SampleLevel(linearSampler, uv + oB, 0.0).b;
  float a = inputTex.SampleLevel(linearSampler, uv,      0.0).a;

  outputTex[gid.xy] = float4(r, g, b, a);
}
