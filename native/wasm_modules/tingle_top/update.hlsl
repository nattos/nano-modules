// gen.tingle_top — update pass. One thread per particle slot.
//
// Lifecycle mirrors flash_particles, but spawn is UNIFORM within a dynamic
// region (no mask seeking): x across the target bar's slice, y in
// [0, region_y_max] (top of canvas = 0). region_y_max is the CPU envelope:
// it snaps to top_band_height while gated and ramps to 1.0 on release, so
// the sparkle cloud "drains" downward. Particles optionally drift by a
// captured per-particle velocity.

#include "common.hlsl"

RWStructuredBuffer<Particle> parts : register(u0);

cbuffer Uniforms : register(b1) {
  uint  count; uint pool_max; uint frame_index; uint do_reset;
  float dt; float region_y_max; float top_band_height; float life_s;
  float respawn_delay_s; float life_jitter; float size; float size_jitter;
  float vel_x; float vel_y; float vel_x_jitter; float vel_y_jitter;
  float hue_jitter; uint bar_all; uint bar_target; uint respect_bounds;
  uint  seed; float _pad0; float _pad1; float _pad2;
};

// Spawn: uniform within the target bar slice × [0, region_y_max].
void respawn(inout Particle p, uint i) {
  uint bar = (bar_all != 0u) ? (i & 3u) : min(bar_target, 3u);
  float rx = tt_unit(tt_pcg3(i + 0xA17F2B91u, frame_index, 0x11u + seed));
  float ry = tt_unit(tt_pcg3(i + 0x9E3779B1u, frame_index, 0x22u + seed));
  float px = (float(bar) + rx) * 0.25;
  float py = ry * max(region_y_max, 0.0);

  float sj = tt_signed(tt_pcg2(i + 0xC2B2AE3Du, frame_index));
  float sz = max(size * (1.0 + size_jitter * sj), 1e-5);
  float lj = tt_signed(tt_pcg2(i + 0x85EBCA77u, frame_index));
  float lt = max(life_s * (1.0 + life_jitter * lj), 1e-3);
  float rj = tt_signed(tt_pcg2(i + 0x27D4EB2Fu, frame_index));
  float rs = max(respawn_delay_s * (1.0 + life_jitter * rj), 0.0);
  float ho = tt_signed(tt_pcg2(i + 0x165667B1u, frame_index)) * hue_jitter;
  float vx = vel_x * (1.0 + vel_x_jitter * tt_signed(tt_pcg2(i + 0x6D2B79F5u, frame_index)));
  float vy = vel_y * (1.0 + vel_y_jitter * tt_signed(tt_pcg2(i + 0x1B873593u, frame_index)));

  p.a = float4(px, py, sz, lt);
  p.b = float4(lt, rs, ho, vx);
  p.c = float4(vy, float(bar), 0.0, 0.0);
}

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= pool_max) return;

  if (do_reset != 0u) {
    // Seed dead with a staggered respawn phase so the pool fades in.
    float phase = tt_unit(tt_pcg2(i + 0x51EDu, seed));
    Particle p;
    p.a = float4(0.5, 0.5, size, 0.0);
    p.b = float4(1.0, phase * max(respawn_delay_s, 1e-3), 0.0, 0.0);
    p.c = float4(0.0, float(i & 3u), 0.0, 0.0);
    parts[i] = p;
    return;
  }
  if (i >= count) return;

  Particle p = parts[i];
  float life_remain = p.a.w;

  if (life_remain > 0.0) {
    // Integrate drift, then age.
    float vx = p.b.w, vy = p.c.x;
    p.a.x += vx * dt;
    p.a.y += vy * dt;
    p.a.w = life_remain - dt;
    if (respect_bounds != 0u) {
      float bar = p.c.y;
      float bl = bar * 0.25, br = bl + 0.25;
      if (p.a.x < bl || p.a.x > br || p.a.y < 0.0 || p.a.y > 1.0) p.a.w = -1.0; // kill
    }
    parts[i] = p;
    return;
  }
  if (p.b.y > 0.0) {              // respawn delay
    p.b.y -= dt;
    parts[i] = p;
    return;
  }
  respawn(p, i);
  parts[i] = p;
}
