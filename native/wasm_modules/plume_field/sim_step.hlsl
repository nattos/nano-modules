// source.sdf.plume_field — tracer simulation, step pass.
//
// A population of tracers runs over the manifold of the displaced sphere
// (base sculpt + the accumulated overlay — so carved channels steer later
// tracers: the tracers interact THROUGH the surface they reshape). Each
// tracer:
//   - reads the local height + gradient of the composed field,
//   - accelerates downhill along the sphere tangent with inertia (the
//     inertia is what stretches paths into streamlines instead of jitter),
//   - carries sediment: it ERODES (digs) where it moves fast — deepening
//     the valleys it found — and DEPOSITS where it slows, building up
//     material; the carve/build balance is a knob,
//   - splats its height delta AND its traffic (flow) into a fixed-point
//     atomic deposit buffer; sim_resolve folds that into the persistent
//     overlay map next.
//
// Tracer state: 2 × float4 per tracer,
//   [2i]   = (dir.xyz  — unit position on S², sediment)
//   [2i+1] = (vel.xyz  — tangent velocity, age)
// A zeroed buffer self-initializes: |dir| < 0.5 triggers a respawn.
//
// Deposits: 2 × int per overlay texel, fixed point —
//   [2t]   = height delta   (world-normalized × 65536)
//   [2t+1] = flow / traffic (speed × 4096)

#include "../plume/common.hlsl"

Texture2D<float4>          shellCoarse : register(t0);  // base field, .r world units
Texture2D<float4>          overlayTex  : register(t1);  // .r h_norm, .g flow
SamplerState               linearSamp  : register(s2);
RWStructuredBuffer<float4> tracers     : register(u3);
RWStructuredBuffer<int>    deposit     : register(u4);

cbuffer SimUniforms : register(b5) {
  float dt;         // clamped frame delta, seconds
  float accel;      // downhill acceleration gain
  float vmax;       // tangent speed limit (rad/s-ish)
  float drag;       // velocity damping per second

  float ero_gain;   // erosion (dig) rate — carve knob, may be 0
  float dep_gain;   // deposition (build) rate — carve knob complement
  float cap_k;      // sediment carrying capacity per unit speed
  float ov_amp;     // overlay .r -> world units (for height sampling)

  float sim_res;    // overlay resolution
  float frame;      // frame counter (respawn hashing)
  float life;       // tracer lifetime, seconds
  float _pad0;
};

// --- Small deterministic hash (no frame-external randomness) ---
uint sim_hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}
float sim_hash01(uint x) { return float(sim_hash(x) & 0xFFFFFFu) / 16777216.0; }

// Composed height (world units) at a direction's oct uv.
float sim_height(float2 uv) {
  float hb = shellCoarse.SampleLevel(linearSamp, uv, 0).r;
  float ho = overlayTex.SampleLevel(linearSamp, uv, 0).r * ov_amp;
  return hb + ho;
}

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  float4 t0 = tracers[i * 2];
  float4 t1 = tracers[i * 2 + 1];
  float3 dir = t0.xyz;
  float sed = t0.w;
  float3 vel = t1.xyz;
  float age = t1.w;

  age += dt;
  bool respawn = dot(dir, dir) < 0.5 || age > life;
  if (respawn) {
    // Uniform point on S² from two hashes; stagger the new age so a whole
    // generation never dies (and respawns) on the same frame.
    uint seed = i * 2654435761u ^ (uint(frame) * 1013904223u);
    float z = sim_hash01(seed) * 2.0 - 1.0;
    float ph = sim_hash01(seed ^ 0x9e3779b9u) * 6.2831853;
    float rr = sqrt(max(1.0 - z * z, 0.0));
    dir = float3(rr * cos(ph), z, rr * sin(ph));
    vel = float3(0.0, 0.0, 0.0);
    sed = 0.0;
    age = sim_hash01(seed ^ 0x85ebca6bu) * life * 0.5;
    tracers[i * 2] = float4(dir, sed);
    tracers[i * 2 + 1] = float4(vel, age);
    return;  // no deposit on the spawn frame
  }

  // --- Local frame + composed-height gradient (finite difference in oct
  // uv, mapped to sphere tangents through the decode) ---
  float2 uv = nano_oct_encode(dir);
  float eps = 1.5 / sim_res;
  float2 eu = float2(eps, 0.0);
  float2 ev = float2(0.0, eps);
  // True slope: dh over the actual arc the ±eps taps span, so `grad` is
  // world-units-per-radian and the downhill acceleration has real teeth.
  float3 pu = nano_oct_decode(uv + eu), mu = nano_oct_decode(uv - eu);
  float3 pv = nano_oct_decode(uv + ev), mv = nano_oct_decode(uv - ev);
  float du_arc = max(length(pu - mu), 1e-4);
  float dv_arc = max(length(pv - mv), 1e-4);
  float dh_du = (sim_height(uv + eu) - sim_height(uv - eu)) / du_arc;
  float dh_dv = (sim_height(uv + ev) - sim_height(uv - ev)) / dv_arc;
  float3 tu = (pu - mu) / du_arc;
  float3 tv = (pv - mv) / dv_arc;
  float3 grad = tu * dh_du + tv * dh_dv;   // uphill, tangent-ish

  // --- Integrate: downhill + inertia, constrained to the tangent plane ---
  vel *= exp(-drag * dt);
  vel -= grad * (accel * dt);
  vel -= dir * dot(dir, vel);
  float spd = length(vel);
  if (spd > vmax) { vel *= vmax / spd; spd = vmax; }
  dir = normalize(dir + vel * dt);

  // --- Continuous path-carving + sediment transport. A moving tracer
  // ALWAYS digs in proportion to its speed (a steady stream keeps
  // deepening its channel — a capacity-gated model stalls the moment
  // sediment fills up), carries part of the spoil, and dumps the excess
  // where it decelerates (bars/deltas where streams slow and fan out). ---
  float dig = ero_gain * spd * 0.05 * dt;
  sed += dig * 0.6;
  float cap = cap_k * spd;
  float drop = max(sed - cap, 0.0) * dep_gain * dt;
  sed -= drop;
  float dh = drop - dig;

  // --- Splat: height delta + traffic, bilinear 2×2 tent (mass-conserving)
  // so channels are a few texels wide instead of single-texel scratches ---
  int r = int(sim_res);
  float2 pf = uv * sim_res - 0.5;
  int2 p0 = int2(floor(pf));
  float2 fw = pf - float2(p0);
  int ignored;
  [unroll] for (int oy = 0; oy < 2; oy++) {
    [unroll] for (int ox = 0; ox < 2; ox++) {
      float w = (ox == 0 ? 1.0 - fw.x : fw.x) *
                (oy == 0 ? 1.0 - fw.y : fw.y);
      int2 pc = clamp(p0 + int2(ox, oy), int2(0, 0), int2(r - 1, r - 1));
      int idx = (pc.y * r + pc.x) * 2;
      InterlockedAdd(deposit[idx], int(dh * w * 65536.0), ignored);
      InterlockedAdd(deposit[idx + 1], int(spd * w * 4096.0), ignored);
    }
  }

  tracers[i * 2] = float4(dir, sed);
  tracers[i * 2 + 1] = float4(vel, age);
}
