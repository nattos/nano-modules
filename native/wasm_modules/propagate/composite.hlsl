// filter.sim.propagate — Pass 2: threshold crests → clean lines over input.
//
// Reads the full-res input and the (upscaled) wave field, and turns the wave
// crests into anti-aliased contour lines composited over the dimmable input.
// A line is drawn where the wave amplitude |u| equals `level` — that isoline
// expands OUTWARD as the ripple travels, so a growing change paints an
// expanding ring. `line_count` stacks concentric contours at multiples of the
// level. As a ripple damps, its amplitude drops below the contour and the line
// simply fades out — no explicit lifetime needed.
//
// AA is a fixed smoothstep band (house style — no fwidth anywhere in the tree).

Texture2D<float4>   inputTex  : register(t0);
Texture2D<float4>   fieldTex  : register(t1);   // .r = u (displacement)
SamplerState        samp      : register(s2);   // Linear + ClampToEdge
RWTexture2D<float4> outputTex : register(u3);   // rgba8 storage write

cbuffer Uniforms : register(b4) {
  float level, thickness, aa, input_mix;
  float line_r, line_g, line_b, field_gain;
  uint  line_count, debug_show_field, _p0, _p1;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float2 uv  = (float2(gid.xy) + 0.5) / float2(W, H);
  float3 inp = inputTex.SampleLevel(samp, uv, 0).rgb;
  float  u   = fieldTex.SampleLevel(samp, uv, 0).r;

  // Debug: raw signed wave field (red = crest, blue = trough).
  if (debug_show_field != 0u) {
    float s = clamp(u * field_gain, -1.0, 1.0);
    float3 col = (s >= 0.0)
      ? lerp(float3(0,0,0), float3(1.0, 0.30, 0.10),  s)
      : lerp(float3(0,0,0), float3(0.10, 0.40, 1.0), -s);
    outputTex[gid.xy] = float4(col, 1.0);
    return;
  }

  float a = abs(u) * field_gain;

  // Concentric contour bands at n*level, half-width `thickness`, AA edges.
  float band = 0.0;
  [loop] for (uint n = 1u; n <= line_count; n++) {
    float lv = level * float(n);
    float lo = max(lv - thickness, 1e-3);   // never include the calm field (a≈0)
    float hi = lv + thickness;
    float inner = smoothstep(lo - aa, lo, a);
    float outer = smoothstep(hi, hi + aa, a);
    band = max(band, saturate(inner - outer));
  }

  float3 base = inp * input_mix;
  float3 col  = lerp(base, float3(line_r, line_g, line_b), band);
  outputTex[gid.xy] = float4(col, 1.0);
}
