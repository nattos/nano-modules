// source.particles.sweep_chamber — particle update. One thread per slot.
//
// flow_swarm's substepped integrator driving double_chamber's aesthetic:
// the velocity field is ONE bilinear tap into field_b (curl-noise background
// + swept-image gradient), composed per particle so each keeps its own
// z-phase curl factor. Two acceleration modes (Velocity chase / Force on a
// mass), exponential settle, forward-spray jitter, drag.
//
// Containment is double_chamber's soft circular boundary (an inward
// velocity impulse past boundary_size) rather than flow_swarm's edge-cull:
// the sweep-release "fling" must arc past the frame edge and curve back,
// not get truncated at uv 1.05. Runaways past the escape radius respawn.
//
// Respawn is dc's uniform-area central disc in s-space (unclamped uv — an
// oversized disc places particles at their true off-screen position), with
// input color captured at the spawn point. All timing dt-accumulated.
//
// Register map (final; later passes add t5 density, t6 segs, t7 tracers,
// t8 response — reserved):
//   u0 particles · t1 field_b · t2 input · s3 sampler · b4 uniforms

#include "common.hlsl"

RWStructuredBuffer<Particle> particles    : register(u0);
Texture2D<float4>            fieldTexB    : register(t1);
Texture2D<float4>            inputTex     : register(t2);
SamplerState                 linearSampler : register(s3);
StructuredBuffer<Seg>        segs          : register(t6);   // tracer segments (spawn-on-line)
StructuredBuffer<TracerState> tracers      : register(t7);   // per-tracer grip (spawn weighting)

cbuffer Uniforms : register(b4) {
  uint  count;
  uint  frame_index;
  float dt;
  float speed;           // multiplier on the composed field velocity

  float momentum;        // velocity mode: 0 = snap to field, →1 = heavy inertia
  float jitter;          // forward spray: ±wobble on speed + slight direction
  float drag;            // velocity decay per second
  float life;            // base lifetime (s)

  float life_jitter;     // ±fraction on lifetime
  float size;            // base particle size (isotropic uv, curved C++-side)
  float size_jitter;     // ±fraction on size
  uint  seed;            // decorrelates instances

  uint  mode;            // 0 = Velocity, 1 = Force
  float weight;          // force mode: particle mass (accel = force / weight)
  float pull;            // settle: pull velocity back toward the field flow [0,1]
  float to_image;        // image-gradient coupling (composed here, not baked)

  float to_image_curl;   // perp-gradient coupling (× per-particle curl factor)
  float undertow_skew;   // curl factor = (z - skew) · squash  (dc parity)
  float undertow_squash;
  float aspect_x;        // min(W,H)/W

  float aspect_y;        // min(W,H)/H
  uint  substeps;        // integration substeps per frame
  float boundary;        // soft circular containment strength [0,1]
  float boundary_size;   // s-space radius of the free zone

  float boundary_stiffness;
  float boundary_death;  // P(die+respawn) past the boundary, ∝ overshoot
  float spawn_size;      // respawn disc radius (s-space)
  float to_line_rate;    // P(respawn onto a tracer line), pre-grip

  float l_count_f;       // tracer count
  float seg_stride;      // segment slots per tracer (its private block size)
  float seg_live;        // slots per tracer actually written (rest zeroed)
  float _pad0;
}

// Max settle rate (1/s) at pull = 1 (flow_swarm parity).
static const float SWC_PULL_RATE      = 20.0;
static const float SWC_NOISE_CIRC     = 0.2;   // slight isotropic part of jitter
static const float SWC_BOUNDARY_ACCEL = 3.0;   // boundary impulse scale (uv/s²·rad)
static const float SWC_ESCAPE_R       = 1.5;   // s-radius past which a particle dies
// s-space overshoot at which boundary-death probability saturates (dc parity).
static const float SWC_BDEATH_REF     = 0.25;

// Compose the field velocity (uv/s) at one field_b sample for a particle
// with curl factor `cf` (see the channel contract in common.hlsl).
float2 swc_field_vel(float4 fb, float cf) {
  float2 iso = fb.zw * to_image + swc_perp(fb.zw) * (to_image_curl * cf);
  return fb.xy + iso * float2(aspect_x, aspect_y);
}

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= count) return;

  float2 aspect = float2(aspect_x, aspect_y);
  Particle p = particles[i];
  float2 pos         = p.a.xy;
  float  life_remain = p.a.z;
  float  life_total  = p.a.w;
  float2 vel         = p.b.xy;
  float  size_cur    = p.b.z;
  uint   packed      = asuint(p.b.w);

  float cf = (swc_unpack_z(packed) - undertow_skew) * undertow_squash;

  // Substepping (flow_swarm parity): dt-scaled everywhere, noise variance
  // preserved by 1/√nsub, momentum as a per-substep blend. nsub=1 reproduces
  // the single-step path exactly.
  uint  nsub        = max(substeps, 1u);
  float dt_sub      = dt / float(nsub);
  float noise_scale = rsqrt(float(nsub));
  float msub        = (momentum < 1e-6) ? 0.0 : pow(momentum, 1.0 / float(nsub));

  bool respawn = (life_remain <= 0.0);

  if (!respawn) {
    for (uint sub = 0u; sub < nsub; sub++) {
      uint fi = frame_index + sub * 0x9E3779B9u;

      // Field velocity, re-sampled every substep (one bilinear tap).
      float4 fb = fieldTexB.SampleLevel(linearSampler, saturate(pos), 0);
      float2 eff = swc_field_vel(fb, cf) * speed;

      // Acceleration mode.
      if (mode == 1u) {
        vel += eff * dt_sub / max(weight, 1e-3);          // force / mass
      } else {
        vel = eff * (1.0 - msub) + vel * msub;            // velocity chase
      }

      // Settle ("pull"): exponential approach toward the field flow.
      if (pull > 1e-5) {
        float a = 1.0 - exp(-pull * SWC_PULL_RATE * dt_sub);
        vel = lerp(vel, eff, a);
      }

      // Soft circular boundary: inward impulse past boundary_size. A force
      // (not dc's velocity overwrite) so a flung particle ARCS back instead
      // of stopping dead at the wall.
      float2 s = (pos - 0.5) / max(aspect, 1e-4);
      float r = max(length(s), 1e-4);
      if (boundary > 1e-6) {
        float over = max((r - boundary_size) * boundary_stiffness, 0.0);
        if (over > 0.0) {
          float2 rad = s / r;
          vel += (-rad * atan(over) * boundary * SWC_BOUNDARY_ACCEL) * aspect * dt_sub;
        }
      }

      // Forward-spray jitter (flow_swarm parity).
      if (jitter > 1e-6) {
        float vmag = length(vel);
        float2 fwd = vel / (vmag + 1e-4);
        uint h = swc_hash3(i + 0x9E3779B1u, fi, seed);
        float mag  = swc_signed(swc_hash(h));
        float2 cir = float2(swc_signed(swc_hash(h ^ 0x68BC21EBu)),
                            swc_signed(swc_hash(h ^ 0xA17F2B91u)));
        float2 kick = fwd * mag + cir * SWC_NOISE_CIRC;
        vel += kick * jitter * vmag * noise_scale;
      }

      // Drag, then integrate.
      vel *= max(1.0 - drag * dt_sub, 0.0);
      pos += vel * dt_sub;
      life_remain -= dt_sub;
    }

    // Post-integration kills (once per frame, dt-scaled).
    float2 s_end = (pos - 0.5) / max(aspect, 1e-4);
    float r_end = length(s_end);
    if (r_end > SWC_ESCAPE_R) respawn = true;   // runaway: recycle now
    if (!respawn && boundary_death > 0.0) {
      float over_b = r_end - boundary_size;
      if (over_b > 0.0) {
        float ov = saturate(over_b / SWC_BDEATH_REF);
        float prob = saturate(boundary_death * ov * dt * 60.0);
        uint hd = swc_hash3(i + 0x5151BEEFu, frame_index, 0xD1u);
        if (swc_unit(swc_hash(hd)) < prob) respawn = true;
      }
    }
    if (life_remain <= 0.0) respawn = true;
  }

  if (respawn) {
    // Uniform-area disc about centre in s-space (dc parity: equal density per
    // unit area, round on screen, concentric with the boundary). NO clamp —
    // an oversized disc must place particles at their true position.
    uint h = swc_hash3(i + 0x85EBCA77u, frame_index, seed + 0x55u);
    float rad = spawn_size * sqrt(swc_unit(swc_hash(h)));
    float theta = 6.28318530718 * swc_unit(swc_hash(h ^ 0xA17Fu));
    float2 sp = rad * float2(cos(theta), sin(theta));
    float2 nuv = 0.5 + sp * aspect;

    // Spawn-on-line, GRIP-WEIGHTED: with prob to_line_rate pick a random
    // tracer, accept it with probability = its grip (how hard the image
    // currently holds it), then land at a UNIFORM point along a random live
    // segment of its block (vertex-snapping would quantize the cloud into
    // hard rails — dc parity). The single-trial rejection keeps O(1) cost and
    // makes the net line-attraction scale with mean grip: as the sweep
    // releases, lines keep drawing (arcing away) but stop pulling particles —
    // the direct replacement for dc's death-based bunching control.
    uint lc   = (uint)l_count_f;
    uint live = (uint)seg_live;
    if (to_line_rate > 0.0 && lc > 0u && live > 0u
        && swc_unit(swc_hash(h ^ 0x0777u)) < to_line_rate) {
      uint li = min(lc - 1u, (uint)(swc_unit(swc_hash(h ^ 0x0999u)) * (float)lc));
      float grip_w = saturate(tracers[li].b.z);
      if (swc_unit(swc_hash(h ^ 0x0F31u)) < grip_w) {
        uint sk = min(live - 1u, (uint)(swc_unit(swc_hash(h ^ 0x0BB5u)) * (float)live));
        Seg sg = segs[li * (uint)seg_stride + sk];
        if (sg.b.w > 0.0) nuv = lerp(sg.a.xy, sg.a.zw, swc_unit(swc_hash(h ^ 0x0CCDu)));
      }
    }

    // Capture the input color at the spawn point (ClampToEdge tolerates
    // out-of-range uv) + roll a fresh z phase / life / size.
    float4 capt = inputTex.SampleLevel(linearSampler, nuv, 0);
    float zr = swc_unit(swc_hash2(i + 0x27D4EB2Fu, frame_index));
    packed = swc_pack_rgbz(capt.rgb, zr);

    float lj = swc_signed(swc_hash2(i + 0xC2B2AE3Du, frame_index));
    life_remain = max(life * (1.0 + life_jitter * lj), 1e-3);
    life_total  = life_remain;
    float sj = swc_signed(swc_hash2(i + 0x1B873593u, frame_index));
    size_cur = max(size * (1.0 + size_jitter * sj), 1e-6);

    pos = nuv;
    // Newborns stream along the field immediately.
    float4 fb0 = fieldTexB.SampleLevel(linearSampler, saturate(nuv), 0);
    float cf0 = (zr - undertow_skew) * undertow_squash;
    vel = swc_field_vel(fb0, cf0) * speed;
  }

  p.a = float4(pos, life_remain, life_total);
  p.b = float4(vel, size_cur, asfloat(packed));
  particles[i] = p;
}
