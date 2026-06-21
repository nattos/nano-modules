// filter.glitch.twitch_mask — apply a roaming "twitch" vignette to the input.
//
// The CPU (fx::TwitchMask) picks a per-frame random anchor + strength; this
// pass multiplies the image by nano_twitch_mask() so a roaming oval region is
// suppressed (bipolar `shape`: + blacks the rim, - blacks the centre).

#include "nano_coords.hlsl"
#include "nano_twitch.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer U : register(b2) {
  float shape;    float radius;   float softness;  float strength;
  float anchor_x; float anchor_y; float aspect_x;  float aspect_y;
  float vp_w;     float vp_h;     float _pad0;      float _pad1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(vp_w, vp_h),
                                          float2(aspect_x, aspect_y));
  float m = nano_twitch_mask(sq, float2(anchor_x, anchor_y), radius, softness,
                             shape, strength);
  float4 c = inputTex[gid.xy];
  outputTex[gid.xy] = float4(c.rgb * m, c.a);
}
