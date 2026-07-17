// motion.peak_decay — pass 1: the meter. Per-pixel staleness tracking.
//
// State ping-pong (RGBA16F): rgb = the HELD reference colour (what the pixel
// is compared against), a = age in seconds since it last moved. A pixel
// "moves" when it differs from the held reference — not from last frame — so
// a slow drift still accumulates and eventually trips the threshold. On a
// trip the reference re-latches and the age snaps to 0 (instant peak-meter
// attack; the gain is applied in pass 2).

Texture2D<float4>   inTex     : register(t0);
Texture2D<float4>   statePrev : register(t1);
// Write-only rgba16f (format from the registerShaderSPV "rgba16float","write"
// hint; a [[vk::image_format]] pin would force read_write, forbidden for
// rgba16f — and the hint is per-shader, which is why tex_out lives in pass 2).
RWTexture2D<float4> stateNext : register(u2);

cbuffer Uniforms : register(b3) {
  float dt;         // seconds this frame (CPU-clamped against hitches)
  float amount;     // pass 2
  float hold;       // seconds a pixel may sit still before the fall starts
  float fall;       // pass 2 (the cap below tracks it)
  float threshold;  // change needed to count as motion (luma-weighted)
  float reset;      // 1 = seed the state from the input (first frame / resize)
  float _p0, _p1;
};

float lum(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  stateNext.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float3 c = inTex[gid.xy].rgb;
  if (reset > 0.5) {
    stateNext[gid.xy] = float4(c, 0.0);
    return;
  }

  float4 st = statePrev[gid.xy];
  // Change metric: full-RGB metering weighted toward luma — a luma step
  // counts at face value; a pure chroma swap must be twice as large.
  float dl = abs(lum(c) - lum(st.rgb));
  float3 dv = abs(c - st.rgb);
  float d = max(dl, 0.5 * max(dv.x, max(dv.y, dv.z)));

  if (d > threshold) {
    stateNext[gid.xy] = float4(c, 0.0);   // re-latch + instant snap back
  } else {
    // Cap just past the end of the fall: half precision stays sharp (dt
    // never stalls against the ulp) and the cap tracks the knobs, so
    // raising hold/fall live revives fully-decayed pixels — performable.
    float cap = hold + fall + 0.25;
    stateNext[gid.xy] = float4(st.rgb, min(st.a + dt, cap));
  }
}
