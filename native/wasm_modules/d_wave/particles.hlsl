// warp.legacy.d_wave — wave-particle pool update (one thread per particle).
//
// Each particle is float4(angle, radius, sizeJitter, speedJitter):
//   angle ∈ [0,1)  — position around the circle
//   radius         — distance from the centre; drifts OUTWARD over time
//   sizeJitter     — [0,1) per-spawn random for strength jitter (read by blob_vs)
//   speedJitter    — [0,1) per-spawn random for per-particle speed (stagger)
//
// Forward time integration (style guide §2.1): radius += speed·dt, never from
// absolute time. Staggered phases come from the initial seed spreading radius
// across [0,1) and from per-particle speed variation; when a particle passes the
// rim it loops back to the centre and respawns with a fresh angle + jitters.

RWStructuredBuffer<float4> particles : register(u0);

cbuffer Uniforms : register(b1) {
  uint  count;   // live particle count
  uint  frame;   // frame index → respawn entropy
  uint  seed;    // 1 on the first frame → initialise the whole pool (staggered)
  uint  pulse;   // 1 the frame a trigger fires → snap all to the centre

  float dt;
  float speed;   // base outward speed (wave_speed · SPEED_SCALE)
  float spread;  // [0,1] per-particle speed variation
  float _p;
}

uint dw_hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float dw_unit(uint h) { return (h >> 8) * (1.0 / 16777216.0); }

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= 4096u) return;                       // MAX_PARTICLES

  // Seed: spread the whole pool across radius [0,1) so phases are staggered from
  // the first frame (no synchronised "all born at the centre" startup).
  if (seed != 0u) {
    uint b = dw_hash(i * 2654435761u + 12345u);
    float ang = dw_unit(b);
    float rad = dw_unit(dw_hash(b ^ 0xA17Fu));
    float sj  = dw_unit(dw_hash(b ^ 0xB2C3u));
    float spj = dw_unit(dw_hash(b ^ 0xC3D4u));
    particles[i] = float4(ang, rad, sj, spj);
    return;
  }

  if (i >= count) return;                       // idle slots

  float4 p = particles[i];
  float ang = p.x, r = p.y, sj = p.z, spj = p.w;

  // Trigger: snap to the centre (tiny stagger) for a synchronised shock wave.
  if (pulse != 0u) r = 0.02 * dw_unit(dw_hash(i * 7919u ^ frame * 131u));

  // Forward-integrate outward; per-particle speed gives the temporal break-up.
  float ps = speed * lerp(1.0, 0.25 + 1.5 * spj, spread);
  r += ps * dt;

  // Loop back: respawn at a fresh angle + jitters when past the rim.
  if (r > 1.05) {
    uint hr = dw_hash(i * 40503u ^ frame * 2246822519u);
    ang = dw_unit(hr);
    sj  = dw_unit(dw_hash(hr ^ 0x77u));
    spj = dw_unit(dw_hash(hr ^ 0x99u));
    r   = 0.0;
  }

  particles[i] = float4(ang, r, sj, spj);
}
