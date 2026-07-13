// filter.legacy.glisten — separable weighted blur with per-pass gain.
//
// Port of the NanoGraph "Blur" subgraph: taps span ±half_width (uv units, so
// the extent is aspect-relative like the original), weighted 41^(-x²) over
// x ∈ [-1, 1], normalized by the actual weight sum, then multiplied by a gain.
// The gain is where the flicker lives — the sparkle layer's blur passes pulse
// (contrast+1)·mix(env^curve, 1, sustain) per pass. Jitter displaces each tap
// by a 2D random offset (the original jittered its offset array per frame).
//
// Used twice on the 64² search grid (width 1−input_chaos, gain 1) and twice
// on the half-res sparkle layer (width from smoothing, flicker gain).

Texture2D<float4>   inputTex : register(t0);
SamplerState        samp     : register(s1);
RWTexture2D<float4> outTex   : register(u2);

cbuffer U : register(b3) {
  float dir_x, dir_y;        // pass axis (1,0) or (0,1)
  float half_width;          // tap extent in uv
  float gain;                // per-pass output multiplier
  float taps;                // kernel length (odd; 1 = passthrough)
  float jitter;              // 0..1 — random 2D tap displacement × half_width
  float seed, _p0;
};

float2 hash2(float2 p) {
  float3 q = frac(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return frac((q.xx + q.yz) * q.zy);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);

  int n = (int)taps;
  if (n <= 1) {
    outTex[gid.xy] = inputTex.SampleLevel(samp, uv, 0) * gain;
    return;
  }

  float2 dir = float2(dir_x, dir_y);
  float4 acc = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < n; ++i) {
    float x = (float(i) / float(n - 1)) * 2.0 - 1.0;    // -1..1
    float wt = pow(41.0, -x * x);
    float2 off = dir * (x * half_width);
    if (jitter > 0.0) {
      off += (hash2(float2(float(i) * 0.731, seed)) - 0.5) * half_width * jitter;
    }
    acc += inputTex.SampleLevel(samp, uv + off, 0) * wt;
    wsum += wt;
  }
  outTex[gid.xy] = (acc / max(wsum, 1e-6)) * gain;
}
