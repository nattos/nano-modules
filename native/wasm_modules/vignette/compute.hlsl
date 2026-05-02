// video.vignette — Radial darken/lighten around a cover-square anchor.
//
// Distance is measured in cover-square units so the vignette stays
// circular regardless of viewport aspect ratio. `shape` morphs the
// metric toward the viewport's actual aspect ratio for a rectangular
// look.

Texture2D<float4> inputTex : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float amount;
  float radius;
  float softness;
  float shape;
  float center_x;
  float center_y;
  float aspect_x;   // cover-square half-extent in uv-x
  float aspect_y;   // cover-square half-extent in uv-y
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  // Convert the dispatch's pixel coords to cover-square units.
  // uv ∈ [0, 1] → square coord = (uv - 0.5) / aspect, so uv=0.5 → 0
  // and the screen edge maps to ±aspect / aspect = ±1 along the long axis.
  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float2 sq = (uv - 0.5) / float2(aspect_x, aspect_y);
  float2 d  = sq - float2(center_x, center_y);

  // shape = 0: pure cover-square distance (circular in screen-space when 1:1).
  // shape = 1: stretch the metric to viewport pixels so the vignette becomes
  //            an ellipse matching the viewport's aspect.
  float2 metric = lerp(float2(1.0, 1.0), float2(aspect_x, aspect_y) * 2.0, shape);
  float dist = length(d * metric);

  // Soft falloff between (radius) and (radius + softness). The smoothstep
  // gives a perceptually pleasant edge.
  float t = smoothstep(radius, radius + max(softness, 1e-4), dist);

  // amount > 0 → lighten edges; amount < 0 → darken edges.
  float gain = 1.0 + amount * t;

  float4 c = inputTex[gid.xy];
  outputTex[gid.xy] = float4(saturate(c.rgb * gain), c.a);
}
