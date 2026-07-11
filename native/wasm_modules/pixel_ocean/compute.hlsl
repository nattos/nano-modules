// pixel_ocean/compute.hlsl — pixel-art ocean generator, single compute pass.
//
// Fully procedural and stateless per pixel: the ocean is a rotated coarse grid
// of "grid pixels", partitioned into S×S spawn cells. Each cell hosts at most
// one tiny wave sprite (dot-line / omega / unrolling wind-curl) at a hashed
// jittered position — a stratified-jittered distribution, so coverage is very
// uniform with no clumping. Everything about a wave (existence, type, position,
// timing offsets) is a pure function of integer hashes + two global step
// clocks, so no particle pool and no cross-frame GPU state.
//
// Drift uses a CO-MOVING LATTICE: the spawn-cell lattice itself translates
// with the global drift step counter (one lattice per travel direction), so in
// the co-moving frame every wave is static and the candidate-cell loop is a
// small fixed neighborhood regardless of drift speed or wave lifetime.
//
// Hard on/off pixels only — no AA, no alpha fades (pixel-art aesthetic).

#include "nano_coords.hlsl"
#include "nano_hash.hlsl"

Texture2D<float4>   inputTex  : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float2 u_aspect;                    // cover-square aspect (fx::coverSquare)
  float  u_cos;                       // cos/sin of the grid rotation
  float  u_sin;
  float4 u_ocean;                     // ocean (background) color
  float4 u_wave;                      // wave sprite color
  float4 u_bg;                        // Custom composite backdrop
  float  u_cell_px;                   // cover-square units per grid pixel
  uint   u_spawn;                     // S: grid pixels per spawn cell (>= 8)
  uint   u_composite;                 // 0 ocean / 1 transparent / 2 custom / 3 input
  uint   u_seed;
  uint   u_anim_steps;                // floor of the shape-animation step clock
  float  u_anim_frac;                 // its fractional part
  uint   u_drift_steps;               // floor of the X-axis drift step clock
  float  u_drift_frac;                // its fractional part
  float  u_anim_jitter;               // 0 = lock-step, 1 = fully staggered
  float  u_drift_jitter;              // X-drift stagger: 0 lock-step … 1 scattered
  float  u_density;                   // per-(cell,cycle) activation probability
  float  u_backwards;                 // probability a wave travels backward (−X,−Y)
  uint   u_debug;                     // overlay spawn-cell grid
  uint   u_forward_steps;             // floor of the Y-axis "forward" step clock
  float  u_forward_frac;              // its fractional part
  float  u_forward_jitter;            // Y-forward stagger: 0 lock-step … 1 scattered
};

// ---------------------------------------------------------------------------
// Wave life cycle + sprites.
//
// All types share one CYCLE_LEN-step life slot: active for the first
// ACT_LEN[type] steps, blank for the rest (the rest gap keeps the sea sparse
// and gives every respawn a clean start at step 0). Dot/omega loop two frames;
// the spiral plays its 8 frames once per cycle (unroll → release).
//
// Sprites live in an 8-wide × 4-tall grid-pixel box, one uint bitmask per
// frame, bit index = y*8 + x (x=0 left, y=0 top; anchor = top-left corner).
// Placeholder art — hand-tune these constants in the IDE.
// ---------------------------------------------------------------------------

#define PO_CYCLE_LEN 16u

static const uint PO_ACT_LEN[3]    = { 12u, 12u, 8u };  // dot, omega, spiral
static const uint PO_FRAME_BASE[3] = { 0u, 2u, 4u };

static const uint PO_SPRITES[12] = {
  // type 0 — dot line: a two-pixel fleck that laps one pixel forward and back.
  //   f0: ..##....      f1: ...##...
  0x00000C00u, 0x00001800u,
  // type 1 — omega wave: a two-hump crest drawn as one connected 1px line,
  // shimmying one pixel per step.
  //   f0: .##.##..      f1: ..##.##.
  //       #..#..#.          .#..#..#
  0x00004936u, 0x0000926Cu,
  // type 2 — spiral / wind curl. A closed loop coils up on the leading (right)
  // side and unrolls a tail to the left, then the curl releases and flattens
  // toward a wavy line as the tail shortens away (tail trails the travel dir).
  //   f0 ........   f1 .....#..   f2 ....##..   f3 ....##..
  //      .....##.      ....#.#.      ...#..#.      ...#..#.
  //      ....#...      ....#.#.      ..##..#.      ####..#.
  //      .....#..      .....#..      ....##..      ....##..
  0x20106000u, 0x20505020u, 0x304C4830u, 0x304F4830u,
  //   f4 ...###..   f5 ..####..   f6 .#####..   f7 ..####..
  //      ..#...#.      .#....#.      #.....#.      .#....#.
  //      ###...#.      ###...#.      ##....#.      ......#.
  //      ....##..      .....#..      ........      ........
  0x30474438u, 0x2047423Cu, 0x0043413Eu, 0x0040423Cu,
};

// Hash streams. Effective stream id = base*2 + dir_bit, so the forward and
// backward lattices are fully decorrelated. ANIM/DRIFT are per-CELL (cycle
// passed as 0 — the offset defines the cycle boundary, so it cannot depend on
// the cycle); GATE/TYPE/POSX/POSY are per-(cell, cycle) so every respawn
// re-rolls activity, type, and position.
#define PO_S_GATE  0u
#define PO_S_TYPE  1u
#define PO_S_POSX  2u
#define PO_S_POSY  3u
#define PO_S_ANIM  4u
#define PO_S_DRIFT 5u   // X-axis sub-step stagger
#define PO_S_FWD   6u   // Y-axis sub-step stagger

uint po_hash(int cx, int cy, uint cycle, uint stream) {
  uint h = nano_uhash(u_seed ^ (stream * 0x9E3779B9u));
  h = nano_uhash(h + asuint(cx));   // asuint: exact + deterministic for negatives
  h = nano_uhash(h + asuint(cy));
  h = nano_uhash(h + cycle);
  return h;
}

float po_hash01(int cx, int cy, uint cycle, uint stream) {
  return float(po_hash(cx, cy, cycle, stream)) * (1.0 / 4294967296.0);
}

// Floor division (HLSL `/` truncates toward zero; grid coords go negative).
int po_div_floor(int a, int b) {
  int q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
  return q;
}

// The anim step clock local to a cell: global steps plus this cell's stagger
// offset. The offset is continuous in [0, jitter*CYCLE_LEN) — its integer part
// shifts whole steps, its fractional part staggers the step INSTANT (folded in
// with the global clock's fractional part), so jitter=1 fully decorrelates
// both the phase and the moment cells tick over.
uint po_local_anim_steps(int cx, int cy, uint dir) {
  float off = po_hash01(cx, cy, 0u, PO_S_ANIM * 2u + dir)
            * u_anim_jitter * float(PO_CYCLE_LEN);
  return u_anim_steps + uint(floor(u_anim_frac + off));
}

// Does the wave hosted by spawn cell (cx,cy) of the `dir` lattice cover the
// co-moving grid pixel (px, py)? `p` is that lattice's activation probability.
bool po_cell_covers(int cx, int cy, int px, int py, uint dir, float p, int S) {
  uint localA = po_local_anim_steps(cx, cy, dir);
  uint cycle  = localA / PO_CYCLE_LEN;
  uint step   = localA % PO_CYCLE_LEN;

  // Density gates per (cell, cycle): raising density only lights up future
  // cycles, so every birth starts at step 0.
  if (po_hash01(cx, cy, cycle, PO_S_GATE * 2u + dir) >= p) return false;

  float th = po_hash01(cx, cy, cycle, PO_S_TYPE * 2u + dir);
  uint type = th < 0.45 ? 0u : (th < 0.80 ? 1u : 2u);   // dot / omega / spiral
  if (step >= PO_ACT_LEN[type]) return false;           // rest gap

  // Anchor: stratified-jittered inside the cell (re-rolled each cycle), plus
  // this cell's per-axis sub-step drift stagger e ∈ {0,1} — the fraction of a
  // whole-pixel step this cell has already taken along its travel direction.
  int d  = (dir == 0u) ? 1 : -1;
  int ex = int(floor(u_drift_frac
                     + po_hash01(cx, cy, 0u, PO_S_DRIFT * 2u + dir) * u_drift_jitter));
  int ey = int(floor(u_forward_frac
                     + po_hash01(cx, cy, 0u, PO_S_FWD * 2u + dir) * u_forward_jitter));
  int jx = int(po_hash01(cx, cy, cycle, PO_S_POSX * 2u + dir) * float(S));
  int jy = int(po_hash01(cx, cy, cycle, PO_S_POSY * 2u + dir) * float(S));
  int ax = cx * S + jx + d * ex;
  int ay = cy * S + jy + d * ey;

  int dx = px - ax;
  int dy = py - ay;
  if (dx < 0 || dx >= 8 || dy < 0 || dy >= 4) return false;

  uint bx = (dir == 0u) ? uint(dx) : uint(7 - dx);      // mirror when travelling backward
  uint frame = (type == 2u) ? step : (step & 1u);
  uint bits = PO_SPRITES[PO_FRAME_BASE[type] + frame];
  return ((bits >> (uint(dy) * 8u + bx)) & 1u) != 0u;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  // Backdrop per composite mode (shape_burst pattern).
  float4 acc;
  if      (u_composite == 0u) acc = float4(u_ocean.rgb, 1.0);        // ocean
  else if (u_composite == 1u) acc = float4(0.0, 0.0, 0.0, 0.0);      // transparent
  else if (u_composite == 2u) acc = u_bg;                            // custom
  else                        acc = inputTex.Load(int3(gid.xy, 0));  // input

  // Output pixel → cover-square → inverse-rotate → grid pixel (nearest).
  float2 sq = nano_pixel_to_cover_square(float2(gid.xy), float2(w, h), u_aspect);
  float2 g = float2( u_cos * sq.x + u_sin * sq.y,
                    -u_sin * sq.x + u_cos * sq.y) / u_cell_px;
  int gx = int(floor(g.x));
  int gy = int(floor(g.y));
  int S  = int(u_spawn);

  // Two co-moving lattices: forward (+X drift, +Y forward) and backward
  // (−X, −Y). Each lattice translates in 2D with its two step clocks, so in
  // the co-moving frame every wave is static.
  //
  // Candidate-cell bounds: a cell's anchor stays inside it (±1 px of sub-step
  // stagger per axis) and the sprite box is 8×4, so with S ≥ 8 a pixel can only
  // be covered by cells at ox ∈ [−1, +1], oy ∈ [−1, +1].
  bool wave = false;
  for (uint dir = 0u; dir < 2u && !wave; dir++) {
    float p = (dir == 0u) ? u_density * (1.0 - u_backwards)
                          : u_density * u_backwards;
    if (p <= 0.0) continue;
    int d   = (dir == 0u) ? 1 : -1;
    int px  = gx - d * int(u_drift_steps);     // un-drift X into the co-moving frame
    int py  = gy - d * int(u_forward_steps);   // un-drift Y
    int cx0 = po_div_floor(px, S);
    int cy0 = po_div_floor(py, S);
    for (int ox = -1; ox <= 1 && !wave; ox++)
      for (int oy = -1; oy <= 1 && !wave; oy++)
        wave = po_cell_covers(cx0 + ox, cy0 + oy, px, py, dir, p, S);
  }
  if (wave) acc = float4(u_wave.rgb, 1.0);

  // Debug overlay: forward-lattice cell borders + a faint tint on cells whose
  // current cycle is active.
  if (u_debug != 0u) {
    int px = gx - int(u_drift_steps);
    int py = gy - int(u_forward_steps);
    int cx = po_div_floor(px, S);
    int cy = po_div_floor(py, S);
    if (px - cx * S == 0 || py - cy * S == 0) {
      acc.rgb = lerp(acc.rgb, float3(1.0, 1.0, 1.0), 0.25);
    } else {
      uint cycle = po_local_anim_steps(cx, cy, 0u) / PO_CYCLE_LEN;
      float p = u_density * (1.0 - u_backwards);
      if (po_hash01(cx, cy, cycle, PO_S_GATE * 2u) < p)
        acc.rgb = lerp(acc.rgb, float3(1.0, 1.0, 1.0), 0.10);
    }
  }

  outputTex[gid.xy] = acc;
}
