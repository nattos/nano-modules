// filter.sim.propagate — Pass 2: threshold the field → clean lines over input.
//
// Reads the full-res input and the (upscaled) propagation field, and turns the
// field's fronts into anti-aliased contour lines composited over the dimmable
// input. A line is drawn where the field F equals `level` — that isoline
// expands OUTWARD as each front travels, so a growing echo paints an expanding
// line that keeps the input's rough shape. `line_count` stacks concentric
// contours at multiples of the level. As a front decays below the contour it
// simply fades out — no explicit lifetime needed.
//
// AA is a fixed smoothstep band (house style — no fwidth anywhere in the tree).

Texture2D<float4>   inputTex  : register(t0);
Texture2D<float4>   fieldTex  : register(t1);   // .r = F (intensity, ≥ 0)
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
  float  F   = fieldTex.SampleLevel(samp, uv, 0).r;
  // Tone-map the (unbounded, ≥0) field into [0,1) so the line `level` is
  // scale-robust — the contour placement doesn't depend on how hard the field
  // was seeded, only on its relative structure. `field_gain` sets the steepness.
  float  a   = 1.0 - exp(-F * field_gain);

  // Debug: the tone-mapped propagation field as grayscale intensity.
  if (debug_show_field != 0u) {
    outputTex[gid.xy] = float4(a, a, a, 1.0);
    return;
  }

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
