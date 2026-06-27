// source.legacy.double_chamber — P field-particle update. One thread per slot.
//
// The simulation runs in aspect-corrected "s-space": s = (uv - 0.5) / aspect,
// so a circle in s is a circle on screen (the field/boundary are isotropic on
// any viewport). Velocity is stored in s-space; the position is kept in uv for
// rendering + image sampling.
//
// Force sum (PetriDish): polynomial field + Big-attractor pull (+curl) + sink +
// jitter + soft circular boundary + optional image gradient (+curl). Forces and
// velocity are clamped so the cubic field term can't blow particles up. Dead /
// escaped particles respawn near centre and capture the input colour. All
// timing is dt-accumulated (style guide §2.1).

#include "common.hlsl"

RWStructuredBuffer<Particle> particles    : register(u0);
StructuredBuffer<Particle>   bigs          : register(t1);
Texture2D<float4>            inputTex      : register(t2);
SamplerState                 samp          : register(s3);
StructuredBuffer<Seg>        segs          : register(t5);   // tracer segments (spawn-on-line)

cbuffer Uniforms : register(b4) {
  uint  count;
  uint  big_count;
  uint  frame_index;
  float dt;

  float motion_rate;
  float momentum;
  float momentum_decay;
  float field_speed;

  float field_scale;
  float field_skew;
  float field_squash;
  float jitter;

  float to_big;
  float to_big_curl;
  float curl_dir;
  float sink;

  float boundary;
  float boundary_size;
  float boundary_stiffness;
  float boundary_speed;

  float to_image;
  float to_image_curl;
  float undertow_skew;
  float undertow_squash;

  float ttl;
  float spawn_size;
  float aspect_x;        // min/W
  float aspect_y;        // min/H

  float to_big_range;    // s-space radius of Big influence (0 → effectively global)
  float image_smoothing; // matches the blur radius → scales the gradient step
  float to_line_rate;    // P(respawn onto a tracer line vertex)
  float seg_total;       // number of tracer segment slots (l_count * max_seg)

  float boundary_mode;   // 0 Recycle · 1 Contain (soft force) · 2 Wrap
  float _bp0, _bp1, _bp2;
}

static const float DC_FORCE_MAX = 6.0;
static const float DC_VEL_MAX    = 6.0;
static const float DC_IMG_GAIN   = 6.0;   // image gradients are small; amplify
static const float DC_ESCAPE_R   = 1.3;   // s-radius past which a particle dies

float dc_lum(float3 c) { return max(c.r, max(c.g, c.b)); }
float2 dc_clamp_mag(float2 v, float m) {
  float l = length(v);
  return (l > m) ? v * (m / l) : v;
}

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= count) return;

  float2 aspect = float2(aspect_x, aspect_y);
  Particle p = particles[i];
  float2 uv          = p.a.xy;
  float  life_remain = p.a.z;
  float  life_total  = p.a.w;
  float2 vel         = p.b.xy;          // s-space velocity
  float  size_cur    = p.b.z;
  uint   packed      = asuint(p.b.w);

  if (life_remain > 0.0) {
    float2 s = (uv - 0.5) / max(aspect, 1e-4);   // aspect-corrected centred coord
    float  zc = dc_unpack_z(packed);
    float  curl_factor = (zc - undertow_skew) * undertow_squash;

    float2 force = float2(0.0, 0.0);

    // Polynomial field (clamp the input so the cubic term stays finite).
    float2 fx = clamp(s * field_scale, -3.0, 3.0);
    force += dc_field(fx, field_skew, field_squash) * field_speed;

    // Big-attractor pull + curl (Big positions converted to s-space). The pull
    // is a spring with a smooth distance cutoff at to_big_range so it's a LOCAL
    // attractor, not a global tilt; range <= 0 disables the cutoff (global).
    if (to_big != 0.0 || to_big_curl != 0.0) {
      float rng = to_big_range;
      for (uint b = 0u; b < big_count; b++) {
        if (bigs[b].a.z <= 0.0) continue;
        float2 bs = (bigs[b].a.xy - 0.5) / max(aspect, 1e-4);
        float2 d = bs - s;
        float fall = (rng > 1e-4) ? (1.0 - smoothstep(rng * 0.6, rng, length(d))) : 1.0;
        force += d * to_big * fall;
        force += dc_perp(d) * to_big_curl * curl_dir * curl_factor * fall;
      }
    }

    // Radial sink (outward when positive).
    float r = max(length(s), 1e-4);
    float2 rad = s / r;
    force += rad * sink;

    // Jitter.
    if (jitter > 1e-6) {
      uint h = dc_hash3(i + 0x9E3779B1u, frame_index, 0x1234u);
      force += float2(dc_signed(dc_hash(h)), dc_signed(dc_hash(h ^ 0x68BC21EBu))) * jitter;
    }

    // Contain mode: soft circular boundary (inward force outside boundary_size).
    // (Recycle / Wrap handle the boundary AFTER integration, below.)
    if (boundary > 1e-6 && boundary_mode > 0.5 && boundary_mode < 1.5) {
      float over = max((r - boundary_size) * boundary_stiffness, 0.0);
      force += -rad * atan(over) * boundary_speed * boundary;
    }

    // Image gradient (+curl), sampled over equal pixel steps → s-space gradient.
    // The step widens with image_smoothing so it reads the broad (blurred)
    // gradient instead of a near-flat local difference.
    if (to_image != 0.0 || to_image_curl != 0.0) {
      float e = lerp(0.004, 0.04, saturate(image_smoothing));
      float2 du = e * aspect;
      float vl = dc_lum(inputTex.SampleLevel(samp, saturate(uv - float2(du.x, 0)), 0).rgb);
      float vr = dc_lum(inputTex.SampleLevel(samp, saturate(uv + float2(du.x, 0)), 0).rgb);
      float vd = dc_lum(inputTex.SampleLevel(samp, saturate(uv - float2(0, du.y)), 0).rgb);
      float vu = dc_lum(inputTex.SampleLevel(samp, saturate(uv + float2(0, du.y)), 0).rgb);
      float2 g = float2(vr - vl, vu - vd) * DC_IMG_GAIN;
      // Taper the image force to zero at the frame edge: ClampToEdge sampling
      // makes the gradient vanish past the border, which would otherwise trap
      // particles in a pile right at the viewport edge.
      float2 ed = min(uv, 1.0 - uv);
      float edgeFade = smoothstep(0.0, 0.05, min(ed.x, ed.y));
      force += g * to_image * edgeFade;
      force += dc_perp(g) * to_image_curl * curl_dir * curl_factor * edgeFade;
    }

    // Clamp force + velocity so the field can't fling particles to infinity.
    force = dc_clamp_mag(force, DC_FORCE_MAX);
    vel = lerp(force, vel * momentum_decay, saturate(momentum));
    vel = dc_clamp_mag(vel, DC_VEL_MAX);

    s += vel * dt * motion_rate;

    // Boundary handling for the non-force modes.
    float rs = length(s);
    if (boundary_mode < 0.5) {
      // Recycle: cross the boundary → respawn (fountain; no pile-up band).
      if (rs > boundary_size) life_remain = -1.0;
    } else if (boundary_mode > 1.5) {
      // Wrap: teleport to the opposite side at the boundary (toroidal flow).
      if (rs > boundary_size && rs > 1e-4) s = -s * (boundary_size * 0.98 / rs);
    }

    uv = 0.5 + s * aspect;
    life_remain -= dt;
    if (length(s) > DC_ESCAPE_R) life_remain = 0.0;   // safety kill for runaways
  } else {
    // Respawn on a uniform-area disc about centre (the original's spawn shape:
    // radius = spawn_size·sqrt(rand) gives equal density per unit area; full-
    // circle angle, no directional bias). Disc lives in s-space → round on
    // screen, concentric with the boundary circle.
    uint h = dc_hash3(i + 0x85EBCA77u, frame_index, 0x55u);
    // In Recycle/Wrap keep the spawn disc inside the boundary so fresh particles
    // don't immediately cross it; Contain may spawn out to the full spawn_size.
    float maxr = (boundary_mode > 0.5 && boundary_mode < 1.5)
                 ? spawn_size : min(spawn_size, boundary_size * 0.9);
    float rad = maxr * sqrt(dc_unit(dc_hash(h)));
    float theta = 6.28318530718 * dc_unit(dc_hash(h ^ 0xA17Fu));
    float2 sp = rad * float2(cos(theta), sin(theta));
    // NO saturate: a spawn disc larger than the frame must place particles at
    // their true (possibly off-screen) position, not clamp them onto the edge
    // (which would pile + simulate from the viewport border). Colour capture
    // below tolerates out-of-range uv via the ClampToEdge sampler.
    float2 nuv = 0.5 + sp * aspect;

    // Spawn-on-line: with prob to_line_rate, snap onto a tracer vertex instead
    // (biased toward the line end, like the original's ChamberSpawnSelect).
    uint segTotal = (uint)seg_total;
    if (to_line_rate > 0.0 && segTotal > 0u
        && dc_unit(dc_hash(h ^ 0x0777u)) < to_line_rate) {
      float rr = dc_unit(dc_hash(h ^ 0x0999u));
      float r2 = 1.0 - (1.0 - rr) * (1.0 - rr);          // bias toward end
      uint si = min(segTotal - 1u, (uint)(r2 * (float)segTotal));
      if (segs[si].b.w > 0.0) nuv = segs[si].a.xy;
    }

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
