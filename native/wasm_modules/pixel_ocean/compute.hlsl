// pixel_ocean/compute.hlsl — pixel-art ocean generator, single compute pass.
//
// Fully procedural and stateless per pixel: the ocean is a rotated coarse grid
// of "grid pixels", partitioned into S×S spawn cells. Each cell hosts at most
// one tiny wave sprite (dot-line / omega / unrolling wind-curl) at a hashed
// jittered position — a stratified-jittered distribution, so coverage is very
// uniform with no clumping. Everything about a wave (existence, type, position)
// is a pure function of integer hashes + the global clocks, so no particle pool
// and no cross-frame GPU state.
//
// CAPTURE-ON-SPAWN: the animation clock is a per-cycle *phase* clock (u_cyc_*)
// advanced CPU-side at the rate captured when the current cycle began, so a live
// anim-rate change never speeds up or cuts off a wave already alive — it only
// takes hold at the next respawn. Existence/shape params (density, backwards,
// the drift/forward jitters) are likewise latched at cycle start: the CPU keeps
// the snapshot for the current cycle and the previous one (every visible wave is
// in one of those two), and the shader reads a wave's captured values from the
// snapshot for its cycle. Raising density can't pop a wave in mid-animation and
// lowering it can't cull one mid-animation — the change lands only at respawn.
//
// Drift uses a CO-MOVING LATTICE: the spawn-cell lattice itself translates with
// the global drift/forward step counters (one lattice per travel direction), so
// in the co-moving frame every wave is static and the candidate-cell loop is a
// small fixed neighborhood. Drift/forward *speed* stays live (all waves in a
// lattice share the rigid translation) — only per-wave shape/timing latches.
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
  uint   u_cyc_index;                 // integer part of the anim phase clock (cycles)
  float  u_cyc_frac;                  // its fractional part ∈ [0,1) — position in cycle
  uint   u_drift_steps;               // floor of the X-axis drift step clock (live)
  float  u_drift_frac;                // its fractional part
  uint   u_forward_steps;             // floor of the Y-axis "forward" step clock (live)
  float  u_forward_frac;              // its fractional part
  uint   u_debug;                     // overlay spawn-cell grid
  float  u_anim_jitter;               // phase spread: 0 = lock-step, 1 = fully staggered
  // Per-cycle captured snapshots — [0]=current cycle, [1]=previous cycle. Every
  // visible wave sits in one of these two cycles; it reads its latched values here.
  float  u_dens_cur,  u_dens_prev;    // density captured at that cycle's start
  float  u_back_cur,  u_back_prev;    // backwards
  float  u_djit_cur,  u_djit_prev;    // X-drift sub-step jitter
  float  u_fjit_cur,  u_fjit_prev;    // Y-forward sub-step jitter
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

// The cell's place in the phase clock. Each cell has a fixed phase offset
// φ ∈ [0,1) cycle (hashed, scaled by the anim jitter) that staggers when it
// ticks over. Subtracting φ from the global phase gives this cell's own cycle
// index + its fractional position in that cycle. Because φ < 1, a cell is always
// in either the current global cycle (u_cyc_index) or the previous one — which
// is exactly why two captured snapshots suffice.
void po_cell_cycle(int cx, int cy, uint dir, out uint cyc, out uint step) {
  float phi = po_hash01(cx, cy, 0u, PO_S_ANIM * 2u + dir) * u_anim_jitter;  // [0,1)
  float f;
  if (u_cyc_frac >= phi) { cyc = u_cyc_index;      f = u_cyc_frac - phi; }
  else                   { cyc = u_cyc_index - 1u; f = u_cyc_frac - phi + 1.0; }
  step = uint(f * float(PO_CYCLE_LEN));            // 0 … CYCLE_LEN-1
}

// Does the wave hosted by spawn cell (cx,cy) of the `dir` lattice cover the
// co-moving grid pixel (px, py)? Existence/shape params are the values latched
// when this cell's cycle began (current- vs previous-cycle snapshot).
bool po_cell_covers(int cx, int cy, int px, int py, uint dir, int S) {
  uint cycle, step;
  po_cell_cycle(cx, cy, dir, cycle, step);

  // Captured snapshot: current cycle uses [cur], the previous one uses [prev].
  bool cur = (cycle == u_cyc_index);
  float dens = cur ? u_dens_cur : u_dens_prev;
  float back = cur ? u_back_cur : u_back_prev;
  float djit = cur ? u_djit_cur : u_djit_prev;
  float fjit = cur ? u_fjit_cur : u_fjit_prev;

  // Existence gates per (cell, cycle) against the density/backwards CAPTURED at
  // this cell's cycle start — so a live density/backwards change only affects
  // cycles that begin after it, never a wave already animating.
  float p = (dir == 0u) ? dens * (1.0 - back) : dens * back;
  if (po_hash01(cx, cy, cycle, PO_S_GATE * 2u + dir) >= p) return false;

  float th = po_hash01(cx, cy, cycle, PO_S_TYPE * 2u + dir);
  uint type = th < 0.45 ? 0u : (th < 0.80 ? 1u : 2u);   // dot / omega / spiral
  if (step >= PO_ACT_LEN[type]) return false;           // rest gap

  // Anchor: stratified-jittered inside the cell (re-rolled each cycle), plus
  // this cell's per-axis sub-step drift stagger e ∈ {0,1} — the fraction of a
  // whole-pixel step this cell has already taken along its travel direction.
  int d  = (dir == 0u) ? 1 : -1;
  int ex = int(floor(u_drift_frac
                     + po_hash01(cx, cy, 0u, PO_S_DRIFT * 2u + dir) * djit));
  int ey = int(floor(u_forward_frac
                     + po_hash01(cx, cy, 0u, PO_S_FWD * 2u + dir) * fjit));
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
    // Coarse skip: no wave in this direction if BOTH captured cycles gate it out
    // (density 0 → skip everything; backwards 0 → skip the backward lattice).
    float pmax = (dir == 0u)
        ? max(u_dens_cur * (1.0 - u_back_cur), u_dens_prev * (1.0 - u_back_prev))
        : max(u_dens_cur * u_back_cur,         u_dens_prev * u_back_prev);
    if (pmax <= 0.0) continue;
    int d   = (dir == 0u) ? 1 : -1;
    int px  = gx - d * int(u_drift_steps);     // un-drift X into the co-moving frame
    int py  = gy - d * int(u_forward_steps);   // un-drift Y
    int cx0 = po_div_floor(px, S);
    int cy0 = po_div_floor(py, S);
    for (int ox = -1; ox <= 1 && !wave; ox++)
      for (int oy = -1; oy <= 1 && !wave; oy++)
        wave = po_cell_covers(cx0 + ox, cy0 + oy, px, py, dir, S);
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
      uint cycle, step;
      po_cell_cycle(cx, cy, 0u, cycle, step);
      bool curc = (cycle == u_cyc_index);
      float p = (curc ? u_dens_cur : u_dens_prev) * (1.0 - (curc ? u_back_cur : u_back_prev));
      if (po_hash01(cx, cy, cycle, PO_S_GATE * 2u) < p)
        acc.rgb = lerp(acc.rgb, float3(1.0, 1.0, 1.0), 0.10);
    }
  }

  outputTex[gid.xy] = acc;
}
