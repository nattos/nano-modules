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
//   - Highlight colour recovery (`recover` > 0): bright regions that rolled off
//     toward white have lost their chroma. The wide low-pass around such a peak
//     still carries the surrounding hue (the halo), so we push that hue back
//     into the blown, desaturated highlights — recovering the "rolled-off
//     saturated colour" look local contrast otherwise greys out. Costs only a
//     handful of ALU in this same pass (the low-pass is already in hand).

Texture2D<float4>   inputTex  : register(t0);   // original, full-res
Texture2D<float4>   lowTex    : register(t1);   // wide low-pass of the original
RWTexture2D<float4> outputTex : register(u2);

cbuffer Uniforms : register(b3) {
  float amount_gain;   // perceptual gain (amount -> gain)
  float protect_k;     // midtone-protection exponent (high = boost everywhere)
  int   mode;          // 0 = luma-preserving clarity, 1 = per-channel RGB
  float recover;       // highlight colour recovery strength (0 = off)
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

  // Highlight colour recovery: re-tint blown, desaturated peaks with the halo
  // hue carried by the low-pass. `recol` is this pixel's luminance wearing the
  // low-pass's hue; lerping toward it pulls the off-channels down (creating
  // saturation) only where the pixel is both bright and grey.
  if (recover > 0.0) {
    float  Lo   = nano_luminance(outrgb);
    float  Lp   = nano_luminance(lp);
    float3 hue  = lp / max(Lp, 1e-4);          // halo hue at unit luma
    float3 recol = Lo * hue;
    float  bright = smoothstep(0.6, 1.0, Lo);  // only peaks
    float  maxc = max(max(outrgb.r, outrgb.g), outrgb.b);
    float  minc = min(min(outrgb.r, outrgb.g), outrgb.b);
    float  grey = 1.0 - (maxc - minc) / max(maxc, 1e-4);   // only desaturated
    outrgb = lerp(outrgb, recol, saturate(recover * bright * grey));
  }

  outputTex[gid.xy] = float4(saturate(outrgb), c.a);
}
