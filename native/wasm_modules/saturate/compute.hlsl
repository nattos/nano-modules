// video.saturate — Per-channel tanh soft-clip with linear deadzone.
//
// The signal flow per channel:
//   1. y = x * prescale                       — scales from black; the
//                                                only multiplier on the
//                                                input. prescale=0 →
//                                                output is pure black.
//   2. Linear deadzone in y ∈ [0, dz] passes through unchanged.
//   3. Above the deadzone, the excess y − dz is tanh-squashed into the
//      remaining headroom (1 − dz):
//        z = dz + (1 − dz) · tanh((y − dz) / (1 − dz) · steepness)
//   4. asymm shapes that tanh shoulder. steepness = 2^asymm:
//        asymm =  0 → standard tanh
//        asymm  > 0 → sharper rolloff (harder limit toward 1)
//        asymm  < 0 → gentler rolloff (more linear past the deadzone)
//
// Alpha is untouched.

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float prescale;
  float asymm;
  float linear_deadzone;
  float _pad;
};

float saturate_channel(float x) {
  float y = max(0.0, x) * prescale;
  float dz = saturate(linear_deadzone);
  float rolloff_range = max(1.0 - dz, 1e-6);
  float excess = max(0.0, y - dz);

  // 2^asymm — steepness multiplier inside the tanh argument.
  float steepness = exp2(asymm);

  float z_outside = dz + rolloff_range * tanh(excess / rolloff_range * steepness);
  // step(y, dz) is 1 when y <= dz (still inside the deadzone); pass
  // y straight through there. lerp keeps the path branch-free.
  return lerp(z_outside, y, step(y, dz));
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 c = inputTex[gid.xy];
  float3 r = float3(saturate_channel(c.r),
                    saturate_channel(c.g),
                    saturate_channel(c.b));
  outputTex[gid.xy] = float4(r, c.a);
}
