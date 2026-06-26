// source.legacy.double_chamber — "Big" attractor update. One thread per Big.
//
// A small population of large slow particles the P field-particles are pulled
// toward / curled around. They ride the image gradient (when coupled), feel a
// gentle orbital drift around centre, a radial sink, and the same soft circular
// boundary as P. Persistent, with occasional spread-respawn for variety.

#include "common.hlsl"

RWStructuredBuffer<Particle> bigs     : register(u0);
Texture2D<float4>            inputTex : register(t1);
SamplerState                 samp     : register(s2);

cbuffer Uniforms : register(b3) {
  uint  count;
  uint  frame_index;
  float dt;
  float motion_rate;

  float big_speed;
  float big_momentum;
  float big_momentum_decay;
  float drift;            // orbital swirl around centre

  float repel;            // image-gradient ride strength
  float direction;        // ±1 sign on the image term
  float curl;             // image-gradient curl
  float curl_dir;

  float sink;
  float boundary;
  float boundary_size;
  float boundary_stiffness;

  float boundary_speed;
  float spread;           // respawn radius
  float ttl;              // lifetime slider (→ ttl*20 s)
  float aspect_x;

  float aspect_y;
  float _p0, _p1, _p2;
}

float dc_lum(float3 c) { return max(c.r, max(c.g, c.b)); }

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= count) return;

  Particle p = bigs[i];
  float2 uv          = p.a.xy;
  float  life_remain = p.a.z;
  float  life_total  = p.a.w;
  float2 vel         = p.b.xy;

  if (life_remain > 0.0) {
    float2 c = uv - 0.5;
    float  r = max(length(c), 1e-4);
    float2 rad = c / r;
    float2 force = float2(0.0, 0.0);

    // Orbital drift (perp to radius) — keeps attractors moving without an image.
    force += dc_perp(c) * drift;

    // Image-gradient ride + curl.
    if (repel != 0.0 || curl != 0.0) {
      float e = 0.006;
      float ex = e * aspect_x, ey = e * aspect_y;
      float vl = dc_lum(inputTex.SampleLevel(samp, saturate(uv - float2(ex, 0)), 0).rgb);
      float vr = dc_lum(inputTex.SampleLevel(samp, saturate(uv + float2(ex, 0)), 0).rgb);
      float vd = dc_lum(inputTex.SampleLevel(samp, saturate(uv - float2(0, ey)), 0).rgb);
      float vu = dc_lum(inputTex.SampleLevel(samp, saturate(uv + float2(0, ey)), 0).rgb);
      float2 g = float2(vr - vl, vu - vd);
      force += g * repel * direction;
      force += dc_perp(g) * curl * curl_dir;
    }

    force += rad * sink;

    if (boundary > 1e-6) {
      float over = max((r - boundary_size) * boundary_stiffness, 0.0);
      force += -rad * atan(over) * boundary_speed * boundary;
    }

    vel = lerp(force * big_speed, vel * big_momentum_decay, saturate(big_momentum));
    uv += vel * dt * motion_rate;
    life_remain -= dt;
  } else {
    // Respawn on a ring of `spread` around centre.
    uint h = dc_hash3(i + 0x68E31DA4u, frame_index, 0x9Au);
    float ang = dc_unit(dc_hash(h)) * 6.28318530718;
    float rad2 = spread * (0.4 + 0.6 * dc_unit(dc_hash(h ^ 0x1234u)));
    uv = saturate(0.5 + float2(cos(ang), sin(ang)) * rad2);
    float4 capt = inputTex.SampleLevel(samp, uv, 0);
    uint packed = dc_pack_rgbz(capt.rgb, dc_unit(h));
    p.b.w = asfloat(packed);
    float lj = dc_signed(dc_hash2(i, frame_index));
    life_remain = max(ttl * 20.0 * (1.0 + 0.3 * lj), 0.1);
    life_total  = life_remain;
    vel = float2(0.0, 0.0);
  }

  p.a = float4(uv, life_remain, life_total);
  p.b.xy = vel;
  bigs[i] = p;
}
