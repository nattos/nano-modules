// source.particles.sweep_chamber — tracer ("line") pass. One thread per tracer.
//
// Rework of double_chamber's L block. Each tracer holds a persistent seed
// (pos, life, angle) PLUS ballistic state (velocity, grip, curvature κ) and
// re-traces a streamline through the seed every frame — re-tracing (rather
// than advecting persistent polylines) is what makes lines conform instantly
// to the moving sweep window. What changed vs dc:
//
//   · Cost: each trace step is 2 bilinear taps at FIELD_RES (field_a +
//     field_b), not 4-5 full-res luma taps. ~18K coarse taps/frame total.
//   · NO stop conditions. value_stop / grad_stop / time_stop_decay are gone:
//     lines don't die in black — they keep propagating through free space on
//     a deterministic constant-curvature ARC (per-tracer signed κ), while a
//     GRIP weight ∈[0,1] (attack/decay EMA of the trace-mean ridge strength
//     L'max) carries what death used to signal: how strongly this line
//     attracts particle spawns (and, optionally, its alpha).
//   · Trapping gates on field_a's L'max (the ridge detector), NEVER on |∇L'|
//     — the gradient vanishes exactly ON a ridge crest, so any gradient-
//     magnitude gate (dc's grad_stop) kills lines precisely where they belong.
//   · Sub-cell ridge lock: field_a's bilinear peak-offset field is applied
//     PERPENDICULAR to the travel direction only — it pulls the line onto the
//     ridge without sliding/bunching vertices along it.
//   · Fling: when grip collapses (the sweep releases the band this line was
//     trapped in), the seed velocity gets an impulse of l_fling_boost × the
//     grip DROP — summed over the release that's a framerate-independent
//     total kick of boost·Δgrip — and the line arcs away ballistically.
//
// Directions live in ISO space (round on screen); positions in uv.

#include "common.hlsl"
#include "nano_sanitize.hlsl"

RWStructuredBuffer<TracerState> tracers  : register(u0);
RWStructuredBuffer<Seg>         segs     : register(u1);
Texture2D<float4>               fieldA   : register(t2);
Texture2D<float4>               fieldB   : register(t3);
SamplerState                    lin      : register(s4);
Texture2D<float4>               inputTex : register(t6);

cbuffer Uniforms : register(b5) {
  uint  count;
  uint  max_seg;
  uint  frame_index;
  float dt;

  float aspect_x;
  float aspect_y;
  float field_res;
  float to_image;

  float to_image_curl;
  float step_len;          // trace step length (iso units)
  float length01;          // steps fraction of max_seg/2 per direction
  float momentum;          // direction inertia during tracing

  float gradient_descent;  // 0 = level curves (trapped), 1 = down/up gradient
  float snap;              // peak-offset corrector strength (sub-cell ridge lock)
  float arc;               // free-space curvature scale: κ = signed·arc·20 rad/iso
  float adv;               // seed field-chase rate gain (× grip × 8/s)

  float grip_attack;       // grip EMA time constants (s)
  float grip_decay;
  float grip_alpha;        // how much grip modulates line alpha
  float fling_boost;       // seed impulse per unit grip drop (uv/s)

  float time_decay;        // seed life bleed per second
  float reseed_spread;     // reseed disc radius (s-space)
  float color_contrib;     // 0 = white lines, 1 = input color at the segment
  float l_opacity;

  float tint_r;
  float tint_g;
  float tint_b;
  float seed_rng;          // decorrelates instances
}

// Ridge-trap gate from field_a's L'max.
float swc_trap(float lmax) { return smoothstep(0.03, 0.25, lmax); }

// Rotate an iso-space vector by `ang` radians.
float2 swc_rot(float2 v, float ang) {
  float c = cos(ang), s = sin(ang);
  return float2(v.x * c - v.y * s, v.x * s + v.y * c);
}

// normalize() that can't emit NaN: two near-opposite unit vectors lerped
// together can vanish, and normalize(0) would poison the whole trace.
float2 swc_safe_norm(float2 v, float2 fallback) {
  float l = length(v);
  return (l > 1e-5) ? v / l : fallback;
}

// Composed field velocity (uv/s) for the tracer (curl factor 1).
float2 swc_trace_field_vel(float4 fb) {
  float2 iso = fb.zw * to_image + swc_perp(fb.zw) * to_image_curl;
  return fb.xy + iso * float2(aspect_x, aspect_y);
}

[numthreads(64, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint i = gid.x;
  if (i >= count) return;

  float2 aspect = float2(aspect_x, aspect_y);
  TracerState t = tracers[i];

  // Persistent state — sanitize on load (a NaN otherwise sticks forever).
  float2 pos  = float2(nano_sanitize(t.a.x, 0.5, -1.0, 2.0),
                       nano_sanitize(t.a.y, 0.5, -1.0, 2.0));
  float  time = nano_sanitize(t.a.z, 0.0, 0.0, 2.0);
  float  ang  = nano_sanitize(t.a.w, 0.0, -7.0, 7.0);
  float2 vel  = float2(nano_sanitize(t.b.x, 0.0, -4.0, 4.0),
                       nano_sanitize(t.b.y, 0.0, -4.0, 4.0));
  float  grip = nano_sanitize(t.b.z, 0.0, 0.0, 1.0);
  float  kap  = nano_sanitize(t.b.w, 0.0, -40.0, 40.0);

  if (time <= 0.0) {
    // Reseed on a uniform-area disc (s-space), staggered life (dc parity).
    uint h = swc_hash3(i + 0x1234u, frame_index, asuint(seed_rng) + 0x99u);
    float a2 = swc_unit(swc_hash(h)) * 6.28318530718;
    float rr = reseed_spread * sqrt(swc_unit(swc_hash(h ^ 0xABCu)));
    float2 sp = float2(cos(a2), sin(a2)) * rr;
    pos  = 0.5 + sp * aspect;
    ang  = swc_unit(swc_hash(h ^ 0x55u)) * 6.28318530718;
    time = lerp(0.15, 1.0, swc_unit(swc_hash(h ^ 0x0033u)));
    kap  = swc_signed(swc_hash(h ^ 0x7A7Au)) * arc * 20.0;
    grip = 0.0;
    vel  = swc_trace_field_vel(fieldB.SampleLevel(lin, saturate(pos), 0));
  } else {
    // --- Seed dynamics: gripped → chase the field; free → ballistic arc ---
    float4 fbS = fieldB.SampleLevel(lin, saturate(pos), 0);
    float4 faS = fieldA.SampleLevel(lin, saturate(pos), 0);
    float2 vf  = swc_trace_field_vel(fbS);
    float  k   = 1.0 - exp(-dt * 8.0 * grip * adv);
    vel += (vf - vel) * k;
    // Constant-curvature bend (always on; negligible when the field-chase
    // dominates). The turn angle scales with the ISO path length so the arc
    // shape is speed- and framerate-independent.
    float2 vel_iso = vel / max(aspect, 1e-4);
    float turn = kap * length(vel_iso) * dt;
    vel = swc_rot(vel_iso, turn) * aspect;
    // Sub-cell ridge snap for the seed itself (fractional, dt-scaled).
    float trapS = swc_trap(faS.a);
    float2 D_uv = faS.gb / max(field_res, 1.0);
    pos += D_uv * (1.0 - exp(-dt * 10.0 * trapS * snap));

    pos += vel * dt;
    time -= time_decay * dt;
  }

  // --- Trace a streamline forward + reverse through the seed ---
  uint base = i * max_seg;
  uint half = max_seg / 2u;
  int steps = max(2, (int)(saturate(length01) * (float)half));
  float3 tint = float3(tint_r, tint_g, tint_b);
  float alpha_grip = lerp(1.0, grip, saturate(grip_alpha));
  uint segIdx = 0u;
  float Lacc = 0.0;
  int totalSteps = 0;

  // Initial direction: level-curve tangent where trapped, own motion where
  // free; the persistent seed angle breaks the tangent's sign ambiguity.
  float4 fb0 = fieldB.SampleLevel(lin, saturate(pos), 0);
  float4 fa0 = fieldA.SampleLevel(lin, saturate(pos), 0);
  float trap0 = swc_trap(fa0.a);
  float2 gs0 = fb0.zw / (length(fb0.zw) + 0.02);
  float2 t0 = swc_perp(gs0);
  float2 aim = float2(cos(ang), sin(ang));
  if (dot(t0, aim) < 0.0) t0 = -t0;
  float2 vel_iso0 = vel / max(aspect, 1e-4);
  float2 own = swc_safe_norm(vel_iso0, aim);
  float2 dir0 = swc_safe_norm(lerp(own, t0, trap0), aim);

  [unroll(1)]
  for (int pass = 0; pass < 2; ++pass) {
    float2 p = pos;
    float2 dir = dir0 * (pass == 0 ? 1.0 : -1.0);
    for (int k2 = 0; k2 < steps; ++k2) {
      float4 fb = fieldB.SampleLevel(lin, saturate(p), 0);
      float2 gs = fb.zw / (length(fb.zw) + 0.02);
      float2 tangent = swc_perp(gs);
      if (dot(tangent, dir) < 0.0) tangent = -tangent;
      float2 ridge = swc_safe_norm(lerp(tangent, gs, saturate(gradient_descent)), dir);
      float2 arcd  = swc_rot(dir, kap * step_len);          // free-space bend
      float4 faP = fieldA.SampleLevel(lin, saturate(p), 0);
      float trap = swc_trap(faP.a);
      float2 target = swc_safe_norm(lerp(arcd, ridge, trap), dir);
      dir = swc_safe_norm(lerp(target, dir, saturate(momentum)), dir);

      float2 nextP = p + dir * aspect * step_len;
      // Peak-offset corrector: bilinear per-texel "delta to peak" ≈ a smooth
      // delta field. Perpendicular-only so it centres the line on the ridge
      // without bunching vertices along it.
      float4 fa2 = fieldA.SampleLevel(lin, saturate(nextP), 0);
      float trap2 = swc_trap(fa2.a);
      float2 D_iso = (fa2.gb / max(field_res, 1.0)) / max(aspect, 1e-4);
      D_iso -= dir * dot(D_iso, dir);
      nextP += D_iso * aspect * (snap * trap2 * 0.5);
      Lacc += fa2.a;
      totalSteps++;

      if (segIdx < max_seg) {
        float a = (1.0 - (float)k2 / (float)steps) * l_opacity
                * saturate(time) * alpha_grip;
        float3 col = lerp(float3(1.0, 1.0, 1.0),
                          inputTex.SampleLevel(lin, saturate(p), 0).rgb,
                          saturate(color_contrib)) * tint;
        segs[base + segIdx].a = float4(p, nextP);
        segs[base + segIdx].b = float4(max(col, 0.0), max(a, 0.0));
        segIdx++;
      }
      p = nextP;
    }
  }

  for (uint z = segIdx; z < max_seg; ++z) {
    segs[base + z].a = float4(0.0, 0.0, 0.0, 0.0);
    segs[base + z].b = float4(0.0, 0.0, 0.0, 0.0);
  }

  // --- Grip update + fling on release ---
  // The fling impulse is boost × the grip EMA's actual DROP this frame, so
  // its sum over a release event is boost × Δgrip (framerate-independent).
  float traceL = (totalSteps > 0) ? saturate(Lacc / (float)totalSteps) : 0.0;
  float rate = (traceL > grip) ? (1.0 / max(grip_attack, 1e-3))
                               : (1.0 / max(grip_decay, 1e-3));
  float grip_new = grip + (traceL - grip) * (1.0 - exp(-dt * rate));
  float release = max(grip - grip_new, 0.0);
  if (release > 0.0 && fling_boost > 0.0) {
    float2 fdir = vel / (length(vel) + 0.05);
    vel += fdir * fling_boost * release;
  }
  grip = grip_new;

  t.a = float4(pos, time, ang);
  t.b = float4(vel, grip, kap);
  tracers[i] = t;
}
