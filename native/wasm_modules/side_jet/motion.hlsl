// gen.side_jet — motion-vector pass.
//
// Same per-jet cone test as the color pass. Each in-cone pixel gets a
// motion vector (dir / transit_seconds, 0) — canvas-uv per second —
// weighted by the radial+axial envelope so motion intensity tracks
// visible intensity. Multiple jets are blended via gaussian-weighted
// average over upstream motion.

Texture2D<float4>   upstreamTex : register(t0);
RWTexture2D<float4> motionTex   : register(u1);

cbuffer Uniforms : register(b2) {
  float intensity;
  float head_width;
  float cone_tan;
  float trail_length;

  float axial_decay_curve;
  float radial_sharpness;
  float diamond_amp;        // unused in motion pass
  float diamond_period;     // unused in motion pass

  float shimmer_phase;      // unused in motion pass
  float turb_amp;           // unused
  float turb_scale;         // unused
  float turb_phase;         // unused

  float core_r;   float core_g;   float core_b;   float _pad0;
  float edge_r;   float edge_g;   float edge_b;   float _pad1;

  uint  active_count;
  uint  debug_show_axis;
  uint  _pad2;
  uint  _pad3;
};

struct GpuJet {
  float head_x;
  float dir;
  float centerline_y;
  float transit_seconds;
  float color_seed;
  float _pp0; float _pp1; float _pp2;
};
StructuredBuffer<GpuJet> jets : register(t3);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  motionTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 uv = (float2(gid.xy) + 0.5) / float2(w, h);
  float4 upstream = upstreamTex[gid.xy];

  float2 v_accum = float2(0.0, 0.0);
  float w_accum = 0.0;

  uint N = active_count;
  if (N > 16u) N = 16u;
  for (uint i = 0u; i < N; i++) {
    GpuJet j = jets[i];
    float dx = (j.head_x - uv.x) * j.dir;
    if (dx < 0.0 || dx > trail_length) continue;
    float dy = uv.y - j.centerline_y;
    float cone_hw = head_width + cone_tan * dx;
    if (abs(dy) > cone_hw) continue;

    float rn = dy / max(cone_hw, 1e-5);
    float radial = exp(-rn * rn * radial_sharpness);
    float axial_lin = saturate(1.0 - dx / max(trail_length, 1e-5));
    float axial = pow(max(axial_lin, 1e-5), max(axial_decay_curve, 0.01));
    float weight = radial * axial;
    if (weight <= 0.0) continue;

    float vx = j.dir / max(j.transit_seconds, 1e-3);
    v_accum += float2(vx, 0.0) * weight;
    w_accum += weight;
  }

  float mask = saturate(w_accum);
  float2 local = (w_accum > 1e-5) ? (v_accum / w_accum) : float2(0.0, 0.0);
  float2 mixed = lerp(upstream.xy, local, mask);
  motionTex[gid.xy] = float4(mixed, 0.0, 0.0);
}
