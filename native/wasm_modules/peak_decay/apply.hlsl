// motion.peak_decay — pass 2: apply. Luma gain from the pixel's age.
//
// Gain holds at 1 through `hold`, then falls along a smoothstep sigmoid over
// `fall` seconds, down by `amount`. Chroma direction is untouched — the pixel
// dims toward black like a peak-meter bar falling. Alpha passes through.

Texture2D<float4>   inTex    : register(t0);
Texture2D<float4>   stateTex : register(t1);   // this frame's meter output
RWTexture2D<float4> outTex   : register(u2);

cbuffer Uniforms : register(b3) {
  float dt;
  float amount;
  float hold;
  float fall;
  float threshold;
  float reset;
  float _p0, _p1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float4 c = inTex[gid.xy];
  float age = stateTex[gid.xy].a;
  // fall = 0 is a hard cliff right after the hold (epsilon keeps the
  // smoothstep edges ordered).
  float g = 1.0 - amount * smoothstep(hold, hold + max(fall, 0.001), age);
  outTex[gid.xy] = float4(c.rgb * g, c.a);
}
