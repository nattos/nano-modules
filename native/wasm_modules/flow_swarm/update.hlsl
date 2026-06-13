// video.flow_swarm — update pass. One thread per particle slot.
//
// Alive + in-bounds: sample the flow field at the particle's uv, derive the
// "effective" flow (undertow may re-aim / re-scale it for some depths), then
// advance velocity by the chosen ACCELERATION MODE:
//   Velocity — velocity chases the field (momentum blends the old velocity;
//              momentum 0 = a clean sim of the field).
//   Force    — the field is a FORCE (acceleration); velocity integrates it,
//              divided by the particle's weight (mass). The field becomes a
//              hint and inertia/overshoot emerge.
// Dead / out-of-bounds: respawn at a fresh random uv, capture input color +
// roll a depth, reset lifetime/size, seed velocity from the field.
//
// All timing is dt-accumulated (style guide §2.1) — no time*rate.

#include "common.hlsl"

RWStructuredBuffer<Particle> particles    : register(u0);
Texture2D<float4>            flowTex       : register(t1);  // flow_field velocity (uv/s)
Texture2D<float4>            inputTex      : register(t2);  // color capture at spawn
SamplerState                 linearSampler : register(s3);
Texture2D<float4>            densityTex    : register(t5);  // last frame's crowding (.r)

cbuffer Uniforms : register(b4) {
  uint  count;
  uint  frame_index;
  float dt;
  float speed;          // multiplier on the sampled field

  float momentum;       // velocity mode: 0 = snap to field, →1 = heavy inertia
  float jitter;         // per-frame random velocity kick (uv/s)
  float drag;           // velocity decay per second
  float life;           // base lifetime (s)

  float life_jitter;    // ±fraction on lifetime
  float size;           // base particle size (isotropic uv, already curved C++-side)
  float size_jitter;    // ±fraction on size
  uint  seed;           // decorrelates instances

  uint  mode;           // 0 = Velocity, 1 = Force
  float weight;         // force mode: particle mass (accel = force / weight)
  float undertow_split; // 0 = no depths undertow, 1 = all particles undertow
  float undertow_polarity; // 1 = normal dir, -1 = reverse, 2 = 2× speed, …

  float undertow_curl;  // -1 = turn 90° left, 0 = unchanged, +1 = turn 90° right
  float pull;           // settle: pull velocity back toward the field flow [0,1]
  uint  interactions;   // 0 = off (skip density read), 1 = on
  float density_threshold; // crowding (≈ neighbour count) above which death kicks in

  float density_death;  // death-rate scale when over threshold (soft knee)
  float avoid;          // avoid/curl strength away from neighbours
  float avoid_curl;     // -1/+1 rotate the avoidance ±90° (swirl)
  float density_res;    // density buffer resolution (texels per axis)

  float avoid_noise;    // random jitter on the avoidance (breaks flat clumps)
  float _pad_n0;
  float _pad_n1;
  float _pad_n2;
};

// Max settle rate (1/s) at pull = 1, used for a framerate-independent approach.
static const float FSW_PULL_RATE  = 20.0;
// Tuning scales for the interaction forces / death.
static const float FSW_DEATH_RATE = 4.0;   // MAX death rate (1/s) at density_death=1
static const float FSW_AVOID_VEL  = 1.5;   // avoidance velocity scale (× speed)

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= count) return;

  Particle p = particles[i];
  float2 pos = p.a.xy;
  float life_remain = p.a.z;
  float life_total  = p.a.w;
  float2 vel = p.b.xy;

  // Interaction 1 — density-gated probabilistic death. Where local crowding
  // (≈ neighbour count, from last frame's splat) exceeds the threshold, give a
  // per-frame death chance that grows with the excess (soft knee). Killed
  // particles respawn elsewhere, so the swarm self-levels toward uniform
  // density. life_remain = 0 falls through to the respawn branch below.
  if (interactions != 0u && life_remain > 0.0 && density_death > 1e-5) {
    float dens = densityTex.SampleLevel(linearSampler, saturate(pos), 0).r;
    float others = max(dens - 1.0, 0.0);          // subtract own halo peak (~1)
    // SATURATING soft knee: 0 below the threshold, ramping smoothly to 1 by
    // threshold+knee. Bounded so dense regions can't insta-kill the whole
    // swarm — density_death scales the MAX rate, the knee its onset.
    float knee = max(density_threshold * 0.5, 1.0);
    float factor = smoothstep(0.0, knee, others - density_threshold);
    float lambda = density_death * FSW_DEATH_RATE * factor;   // 1/s
    float pdie = 1.0 - exp(-lambda * dt);                     // dt-weighted
    float rr = fsw_unit(fsw_hash3(i + 0xDEAD0001u, frame_index, seed));
    if (rr < pdie) life_remain = 0.0;
  }

  bool oob = pos.x < -0.05 || pos.x > 1.05 || pos.y < -0.05 || pos.y > 1.05;

  if (life_remain > 0.0 && !oob) {
    float depth = fsw_unpack_depth(asuint(p.b.w));
    float u = fsw_undertow(depth, undertow_split);

    // Field, with undertow re-aim (curl rotates) + re-scale (polarity) for the
    // members. lerp by membership so partial members partially undertow.
    float2 fv = flowTex.SampleLevel(linearSampler, saturate(pos), 0).xy;
    float ang = undertow_curl * 1.5707963;           // ±90° at ±1
    float ca = cos(ang), sa = sin(ang);
    float2 rotv = float2(fv.x * ca - fv.y * sa, fv.x * sa + fv.y * ca);
    float2 under = rotv * undertow_polarity;
    float2 eff = lerp(fv, under, u) * speed;

    // Interaction 2 — avoid / curl away from neighbours. The density gradient
    // points toward higher crowding; push down it (curl rotates the push for a
    // swirling avoidance). Folded into eff so both modes and `pull` cooperate.
    if (interactions != 0u && avoid > 1e-5) {
      float e = 2.0 / max(density_res, 1.0);
      float dl = densityTex.SampleLevel(linearSampler, saturate(pos - float2(e, 0.0)), 0).r;
      float dr = densityTex.SampleLevel(linearSampler, saturate(pos + float2(e, 0.0)), 0).r;
      float dd = densityTex.SampleLevel(linearSampler, saturate(pos - float2(0.0, e)), 0).r;
      float du = densityTex.SampleLevel(linearSampler, saturate(pos + float2(0.0, e)), 0).r;
      float2 away = -float2(dr - dl, du - dd);            // away from crowding
      float2 awayhat = away / (length(away) + 0.5);       // soft-normalised
      float ang2 = avoid_curl * 1.5707963;
      float ca2 = cos(ang2), sa2 = sin(ang2);
      float2 av = float2(awayhat.x * ca2 - awayhat.y * sa2,
                         awayhat.x * sa2 + awayhat.y * ca2);
      eff += av * avoid * FSW_AVOID_VEL * speed;

      // Avoidance noise: a random kick so particles still scatter where the
      // density gradient goes flat (the centre of a symmetric clump, where the
      // avoidance push alone vanishes and they'd otherwise stay stuck).
      if (avoid_noise > 1e-6) {
        uint nh = fsw_hash3(i + 0x51ED2701u, frame_index, seed);
        float2 nv = float2(fsw_signed(nh), fsw_signed(fsw_hash(nh ^ 0x9E3779B1u)));
        eff += nv * avoid_noise * FSW_AVOID_VEL * speed;
      }
    }

    // Acceleration mode.
    if (mode == 1u) {
      // Force: eff is an acceleration; integrate / mass.
      vel += eff * dt / max(weight, 1e-3);
    } else {
      // Velocity: chase eff with momentum (0 = clean field follow).
      vel = eff * (1.0 - momentum) + vel * momentum;
    }

    // Settle ("pull"): bleed the particle's velocity back toward the field's
    // prescribed flow (eff) — deviation → 0. The field's streamlines spiral
    // into the limit cycle, so this keeps particles in the stable zone and
    // damps force-mode overshoot. Framerate-independent exponential approach;
    // vanishes once a particle already matches the flow. Works in both modes.
    if (pull > 1e-5) {
      float a = 1.0 - exp(-pull * FSW_PULL_RATE * dt);
      vel = lerp(vel, eff, a);
    }

    // Per-frame jitter kick (hash-based; not low-passed by the chase).
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

  // --- Respawn: fresh random uv, capture input color, roll depth/size/life ---
  uint hp = fsw_hash3(i + 0x85EBCA77u, frame_index, seed);
  float ux = float(hp & 0xFFFFu) * (1.0 / 65536.0);
  float uy = float((hp >> 16u) & 0xFFFFu) * (1.0 / 65536.0);
  float2 nuv = float2(ux, uy);

  float4 capt = inputTex.SampleLevel(linearSampler, nuv, 0);
  float depth = fsw_unit(fsw_hash2(i + 0x9E3779B9u, frame_index + seed));
  uint packed = fsw_pack_rgbd(capt.rgb, depth);

  float lj = fsw_signed(fsw_hash2(i + 0xC2B2AE3Du, frame_index + seed));
  float new_life = max(life * (1.0 + life_jitter * lj), 1e-3);
  float sj = fsw_signed(fsw_hash2(i + 0x27D4EB2Fu, frame_index + seed));
  float new_size = max(size * (1.0 + size_jitter * sj), 1e-6);

  float2 field0 = flowTex.SampleLevel(linearSampler, nuv, 0).xy;

  p.a = float4(nuv, new_life, new_life);
  p.b = float4(field0 * speed, new_size, asfloat(packed));
  particles[i] = p;
}
