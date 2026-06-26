// source.legacy.double_chamber — P field-particle update. One thread per slot.
//
// Force sum (PetriDish): polynomial field + Big-attractor pull (+curl) + sink +
// jitter + soft circular boundary + optional image gradient (+curl). Velocity
// blends the old velocity by momentum; position integrates dt-scaled. Dead
// particles respawn near centre and capture the input colour. All timing is
// dt-accumulated (style guide §2.1).

#include "common.hlsl"

RWStructuredBuffer<Particle> particles    : register(u0);
StructuredBuffer<Particle>   bigs          : register(t1);  // Big attractors
Texture2D<float4>            inputTex      : register(t2);
SamplerState                 samp          : register(s3);

cbuffer Uniforms : register(b4) {
  uint  count;
  uint  big_count;
  uint  frame_index;
  float dt;

  float motion_rate;     // master speed
  float momentum;        // 0 = velocity = force, →1 = inertia
  float momentum_decay;  // retained-velocity scale
  float field_speed;     // polynomial advection strength

  float field_scale;
  float field_skew;
  float field_squash;
  float jitter;

  float to_big;          // attraction to Big particles
  float to_big_curl;
  float curl_dir;        // ±1 handedness
  float sink;            // radial (outward +, inward -)

  float boundary;        // soft-boundary strength
  float boundary_size;   // radius (uv)
  float boundary_stiffness;
  float boundary_speed;

  float to_image;        // image-gradient coupling
  float to_image_curl;
  float undertow_skew;
  float undertow_squash; // z-phase → curl-factor scale

  float ttl;             // lifetime slider (→ ttl*8 s)
  float spawn_size;      // respawn spread around centre
  float aspect_x;        // min/W (for round image-gradient taps)
  float aspect_y;        // min/H
}

float dc_lum(float3 c) { return max(c.r, max(c.g, c.b)); }

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= count) return;

  Particle p = particles[i];
  float2 uv          = p.a.xy;
  float  life_remain = p.a.z;
  float  life_total  = p.a.w;
  float2 vel         = p.b.xy;
  float  size_cur    = p.b.z;
  uint   packed      = asuint(p.b.w);

  if (life_remain > 0.0) {
    float2 c = uv - 0.5;                       // centred coords
    float  z = dc_unpack_z(packed);
    float  curl_factor = (z - undertow_skew) * undertow_squash;

    float2 force = float2(0.0, 0.0);

    // Polynomial field.
    force += dc_field(c * field_scale, field_skew, field_squash) * field_speed;

    // Big-attractor pull + curl.
    if (to_big != 0.0 || to_big_curl != 0.0) {
      for (uint b = 0u; b < big_count; b++) {
        float2 bp = bigs[b].a.xy;
        if (bigs[b].a.z <= 0.0) continue;
        float2 d = bp - uv;
        force += d * to_big;
        force += dc_perp(d) * to_big_curl * curl_dir * curl_factor;
      }
    }

    // Radial sink (outward when positive).
    float r = max(length(c), 1e-4);
    float2 rad = c / r;
    force += rad * sink;

    // Jitter.
    if (jitter > 1e-6) {
      uint h = dc_hash3(i + 0x9E3779B1u, frame_index, 0x1234u);
      force += float2(dc_signed(dc_hash(h)), dc_signed(dc_hash(h ^ 0x68BC21EBu))) * jitter;
    }

    // Soft circular boundary (inward restoring force outside boundary_size).
    if (boundary > 1e-6) {
      float over = max((r - boundary_size) * boundary_stiffness, 0.0);
      force += -rad * atan(over) * boundary_speed * boundary;
    }

    // Image gradient (+curl), sampled in round pixel steps.
    if (to_image != 0.0 || to_image_curl != 0.0) {
      float e = 0.004;
      float ex = e * aspect_x, ey = e * aspect_y;
      float vl = dc_lum(inputTex.SampleLevel(samp, saturate(uv - float2(ex, 0)), 0).rgb);
      float vr = dc_lum(inputTex.SampleLevel(samp, saturate(uv + float2(ex, 0)), 0).rgb);
      float vd = dc_lum(inputTex.SampleLevel(samp, saturate(uv - float2(0, ey)), 0).rgb);
      float vu = dc_lum(inputTex.SampleLevel(samp, saturate(uv + float2(0, ey)), 0).rgb);
      float2 g = float2(vr - vl, vu - vd);
      force += g * to_image;
      force += dc_perp(g) * to_image_curl * curl_dir * curl_factor;
    }

    // Velocity update + integrate.
    vel = lerp(force, vel * momentum_decay, saturate(momentum));
    uv += vel * dt * motion_rate;
    life_remain -= dt;
  } else {
    // Respawn near centre, capture colour.
    uint h = dc_hash3(i + 0x85EBCA77u, frame_index, 0x55u);
    float2 nuv = 0.5 + float2(dc_signed(dc_hash(h)), dc_signed(dc_hash(h ^ 0xA17Fu)))
                       * 0.5 * spawn_size;
    nuv = saturate(nuv);
    float4 capt = inputTex.SampleLevel(samp, nuv, 0);
    float zr = dc_unit(dc_hash2(i + 0x27D4EB2Fu, frame_index));
    packed = dc_pack_rgbz(capt.rgb, zr);
    float lj = dc_signed(dc_hash2(i + 0xC2B2AE3Du, frame_index));
    life_remain = max(ttl * 8.0 * (1.0 + 0.3 * lj), 0.05);
    life_total  = life_remain;
    uv = nuv;
    vel = float2(0.0, 0.0);
    size_cur = max(size_cur, 1e-4);
  }

  p.a = float4(uv, life_remain, life_total);
  p.b = float4(vel, size_cur, asfloat(packed));
  particles[i] = p;
}
