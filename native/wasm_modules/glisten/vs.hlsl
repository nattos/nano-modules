// filter.legacy.glisten — instanced sparkle vertex shader.
//
// One triangle (3 verts) per instance. Instances tile blades × levels: the
// blade index sweeps the angle around the anchor, the level index picks a
// scale/alpha layer (dense bright core → sparse long blades). Each blade is a
// thin spike from the anchor centre out to a tip; tips aligned with the local
// image gradient are elongated. Colour is gradient-shaded from the anchor.

StructuredBuffer<float> anchor : register(t0);

cbuffer U : register(b1) {
  float aspect_x, aspect_y;   // isotropic-uv → true-uv
  float blades, levels;

  float size, shape, spin, sweep;

  float stretch_grad, stretch_squash, blade_falloff, intensity;

  float color_grad_power, value_gain, tint_r, tint_g;
  float tint_b, _p0, _p1, _p2;
};

struct VsOut {
  float4 pos    : SV_Position;
  float  radial : TEXCOORD0;          // 0 apex → 1 tip
  float4 color  : TEXCOORD1;          // rgb + alpha (interpolated for grad shimmer)
};

[shader("vertex")]
VsOut main(uint vid : SV_VertexID, uint iid : SV_InstanceID) {
  VsOut o;

  float2 pos   = float2(anchor[0], anchor[1]);
  float2 dir   = float2(anchor[2], anchor[3]);
  float2 grad  = float2(anchor[4], anchor[5]);
  float3 col   = float3(anchor[6], anchor[7], anchor[8]);
  float3 cgx   = float3(anchor[9], anchor[10], anchor[11]);
  float3 cgy   = float3(anchor[12], anchor[13], anchor[14]);
  float  vAvg  = anchor[15];

  int nBlades = max((int)blades, 1);
  int nLevels = max((int)levels, 1);
  uint blade = iid % (uint)nBlades;
  uint level = iid / (uint)nBlades;

  float sh = max(shape, 0.01);
  float fLevel = (float)level;
  float scale = (nLevels * sh) / (fLevel + nLevels * sh) * size;
  // Alpha ramp: inner (small-scale) layers carry more weight → bright core.
  float levelAlpha = (1.0 + fLevel) / ((float)nLevels * ((float)nLevels + 1.0));

  // Blade angle. sweep is the swept fraction of a full turn (1 = full star).
  float fullSweep = sweep * 2.0 * 3.14159265358979;
  float step = fullSweep / (float)nBlades;
  float a0 = (float)blade * step + spin;
  float a1 = a0 + step * 0.5;        // tip apex at the slice mid-angle

  // Stretch tips along the image gradient direction.
  float stretchPow = atan(length(grad) * stretch_squash);
  float k = (stretch_grad - 1.0) * stretchPow;

  // Triangle: vid 0 = centre apex, 1 & 2 = the two base corners near the tip.
  float2 local;
  float radial;
  if (vid == 0u) {
    local = float2(0.0, 0.0);
    radial = 0.0;
  } else {
    float ang = (vid == 1u) ? a0 : (a0 + step);
    float2 d = float2(cos(ang), sin(ang));
    local = d * scale;
    local += dot(local, dir) * k * dir;
    radial = 1.0;
  }

  float2 offset = float2(local.x * aspect_x, local.y * aspect_y);
  float2 world = pos + offset;
  o.pos = float4(world * 2.0 - 1.0, 0.0, 1.0);
  o.radial = radial;

  // Gradient-shaded colour, tinted; intensity gated by anchor brightness.
  float3 shaded = col + (local.x * cgx + local.y * cgy) * color_grad_power;
  shaded *= float3(tint_r, tint_g, tint_b);
  float gate = saturate(vAvg * value_gain);
  float alpha = levelAlpha * intensity * gate;
  o.color = float4(max(shaded, 0.0), alpha);
  return o;
}
