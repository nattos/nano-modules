// video.flow_swarm — update pass. One thread per particle slot.
//
// Alive + in-bounds: sample the flow field at the particle's uv, chase that
// velocity with momentum (inertia), add jitter + drag, integrate position,
// age. Dead (life expired) or out-of-bounds: respawn at a fresh random uv,
// capture the input color there, reset lifetime/size, seed velocity from the
// field. The CPU seeds the initial pool (staggered lifetimes); this shader
// runs every step after.
//
// All timing is dt-accumulated (style guide §2.1) — no time*rate.

#include "common.hlsl"

RWStructuredBuffer<Particle> particles    : register(u0);
Texture2D<float4>            flowTex       : register(t1);  // flow_field velocity (uv/s)
Texture2D<float4>            inputTex      : register(t2);  // color capture at spawn
SamplerState                 linearSampler : register(s3);

cbuffer Uniforms : register(b4) {
  uint  count;
  uint  frame_index;
  float dt;
  float speed;          // multiplier on the sampled field velocity

  float momentum;       // 0 = snap to field, →1 = heavy inertia
  float jitter;         // per-frame random velocity kick (uv/s)
  float drag;           // velocity decay per second
  float life;           // base lifetime (s)

  float life_jitter;    // ±fraction on lifetime
  float size;           // base particle size (isotropic uv)
  float size_jitter;    // ±fraction on size
  uint  seed;           // decorrelates instances
};

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= count) return;

  Particle p = particles[i];
  float2 pos = p.a.xy;
  float life_remain = p.a.z;
  float life_total  = p.a.w;
  float2 vel = p.b.xy;

  bool oob = pos.x < -0.05 || pos.x > 1.05 || pos.y < -0.05 || pos.y > 1.05;

  if (life_remain > 0.0 && !oob) {
    // --- Advect: chase the field velocity with momentum ---
    float4 field = flowTex.SampleLevel(linearSampler, saturate(pos), 0);
    float2 target = field.xy * speed;
    vel = vel * momentum + target * (1.0 - momentum);

    // Per-frame jitter kick (hash-based; not low-passed by the spring).
    if (jitter > 1e-6) {
      uint h = fsw_hash3(i + 0x9E3779B1u, frame_index, seed);
      float2 kick = float2(fsw_signed(h), fsw_signed(fsw_hash(h ^ 0x68BC21EBu)));
      vel += kick * jitter;
    }

    // Drag, then integrate.
    vel *= max(1.0 - drag * dt, 0.0);
    pos += vel * dt;

    p.a = float4(pos, life_remain - dt, life_total);
    p.b.xy = vel;
    particles[i] = p;
    return;
  }

  // --- Respawn: fresh random uv, capture input color, reset lifetime/size ---
  uint hp = fsw_hash3(i + 0x85EBCA77u, frame_index, seed);
  float ux = float(hp & 0xFFFFu) * (1.0 / 65536.0);
  float uy = float((hp >> 16u) & 0xFFFFu) * (1.0 / 65536.0);
  float2 nuv = float2(ux, uy);

  float4 capt = inputTex.SampleLevel(linearSampler, nuv, 0);
  uint packed = fsw_pack_rgb(capt.rgb);

  float lj = fsw_signed(fsw_hash2(i + 0xC2B2AE3Du, frame_index + seed));
  float new_life = max(life * (1.0 + life_jitter * lj), 1e-3);
  float sj = fsw_signed(fsw_hash2(i + 0x27D4EB2Fu, frame_index + seed));
  float new_size = max(size * (1.0 + size_jitter * sj), 1e-5);

  float4 field0 = flowTex.SampleLevel(linearSampler, nuv, 0);

  p.a = float4(nuv, new_life, new_life);
  p.b = float4(field0.xy * speed, new_size, asfloat(packed));
  particles[i] = p;
}
