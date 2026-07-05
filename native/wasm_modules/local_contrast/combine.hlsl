// filter.local_contrast — "Local Contrast" (clarity) combine pass.
//
// The host runs a WIDE low-pass (fx::FastBlur) of tex_in into `lowTex`, then
// this pass recombines the original with that local average as a large-radius
// unsharp mask:  out = in + amount * (in - local_average).  Because the blur
// radius is broad, this boosts mid-scale STRUCTURE ("pop"/clarity) rather than
// the fine 1px edges that filter.sharpen targets.
//
// Two refinements over a naive unsharp:
//   - Luma-preserving (mode 0): the boost is computed on luminance and RGB is
//     scaled to match, so hue/saturation are untouched and edges don't grow a
//     coloured fringe. mode 1 does a plain per-channel boost (grittier).
//   - Midtone protection: `protect_k` attenuates the boost near black/white so
//     highlights don't blow out and shadows don't crush.

Texture2D<float4>   inputTex  : register(t0);   // original, full-res
Texture2D<float4>   lowTex    : register(t1);   // wide low-pass of the original
RWTexture2D<float4> outputTex : register(u2);

cbuffer Uniforms : register(b3) {
  float amount_gain;   // perceptual gain (amount -> gain)
  float protect_k;     // midtone-protection exponent (high = boost everywhere)
  int   mode;          // 0 = luma-preserving clarity, 1 = per-channel RGB
  float _pad;
};

#include "nano_color.hlsl"   // nano_luminance

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 c  = inputTex[gid.xy];
  float3 lp = lowTex[gid.xy].rgb;

  float L = nano_luminance(c.rgb);

  // Bell over the tonal range: 1 at midtones, → 0 toward black/white. A large
  // protect_k flattens the bell (boost everywhere); a small one narrows it to
  // the midtones only (photographic highlight/shadow protection).
  float protect = 1.0 - pow(saturate(abs(2.0 * L - 1.0)), protect_k);

  float3 outrgb;
  if (mode == 0) {
    // Luma-preserving: boost local luminance contrast, scale RGB to match.
    float Ll   = nano_luminance(lp);
    float Lnew = L + amount_gain * (L - Ll) * protect;
    float scale = (L > 1e-4) ? (Lnew / L) : 1.0;
    outrgb = c.rgb * scale;
  } else {
    // Per-channel unsharp.
    outrgb = c.rgb + amount_gain * (c.rgb - lp) * protect;
  }

  outputTex[gid.xy] = float4(saturate(outrgb), c.a);
}
