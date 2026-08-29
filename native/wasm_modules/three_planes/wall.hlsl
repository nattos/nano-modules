// three_planes' IMPACT LIGHT — what the stack throws onto the walls beside it.
//
// The stack sits inside a hollow room and this is one of its side walls, flat
// on, from outside: horizontal is depth through the room, vertical is height.
// Two dispatches, one per wall, differing only in which side of the room they
// stand on.
//
// It is a LIGHT MODEL, not a picture of the stack. Nothing here draws a quad;
// what it draws is the pool each glowing ring lays on a wall a little way off,
// the way a muzzle flash lights a corridor. Deliberately approximate — the
// orbit is ignored entirely, because a square turned about its own axis
// presents the same silhouette to both walls anyway and nothing in the light
// would change.
//
// WHY IT DOES NOT LOOK LIKE A GRADIENT. The shape is not authored, it falls out
// of the geometry, and the geometry is what makes light on a wall look like
// light on a wall:
//
//   * The emitter is a RING with width, so its pool is FLAT-TOPPED across the
//     ring and only falls off past the ends — a bar of light, not a blob.
//   * The wall is a fixed distance away, so the nearest the light can ever get
//     is that gap, and the falloff is inverse square from there — times the
//     GRAZING term, because what a surface catches is not how much light
//     reaches it but how squarely. cos = gap/d, so the two together go as
//     1/d^3, and that extra power is most of why this reads as light landing
//     on something rather than a glow drawn over it.
//   * Under all of it, one wide dim wash: the light that has bounced rather
//     than arrived. A room without it is a black void with lamps in it.
//
// Each ring carries its OWN gap, which is what makes a throw land. The release
// flings the rings outward, so they close on the wall as they go: the pool
// tightens and burns at the same moment it widens, and by the end the ring is
// nearly against the wall and the whole thing flares. Holding the gap fixed
// for everything made a throw read as a slightly brighter version of resting,
// which is not what a throw is.
//
// The stacked-exponential halo the TUBES use was the obvious thing to reach
// for here and it is wrong for a wall: its widest octave barely falls off
// across a whole room, so every floor lays down the same flat pedestal and the
// three pools melt into one bright rectangle. Inverse square has a long tail
// and no pedestal, which is the difference.

#include "nano_glint.hlsl"

RWTexture2D<float4> outputTex : register(u0);

/// How much of the wall the texture shows, in the stack's own units — fixed, so
/// moving the wall changes the LIGHT and never the framing. The stack is about
/// 0.4 of this tall by default, which leaves it room to throw.
static const float kWallSpan = 1.0;


cbuffer WallUniforms : register(b1) {
  float4 layer[3];     // rgb = colour, w = level
  float4 layer_g[3];   // x = height, y = ring half-size, z = gap to this wall
  // The release throw, as light. Same rows again for the ghosts: in Grow they
  // have flown outward and up, in Strobe they sit exactly on the quads — the
  // host has already resolved which, so from here it is one path.
  float4 ghost[3];
  float4 ghost_g[3];
  float4 wall;   // wash reach, wash weight, gain, -
  float4 look;   // warmth, which wall (-1 left, +1 right), -, zoom
  float4 glim;   // travel direction through the room: x across, y along
  float4 glints[8];
};

/// The pool of light one horizontal ring lays on a side wall.
///
/// `w` is the point on the wall (depth, height), `y_i` the ring's height and
/// `s` its half-size, all in the stack's own units. `gap` is how far the wall
/// stands off the ring, `reach` and `bounce` the wide wash under it.
float wall_pool(float2 w, float y_i, float s, float gap, float reach,
                float bounce) {
  // Flat across the ring and falling off only past its ends: the emitter has
  // width, so its pool does too. This is the whole reason it reads as a bar
  // thrown by an object rather than as a blob centred on a point.
  float dz = max(abs(w.x) - s, 0.0);
  float dy = w.y - y_i;
  float q = dz * dz + dy * dy;

  // Inverse square TIMES the grazing cosine, normalised so straight opposite
  // the ring reads 1 — the gap shapes the pool, it does not dim it. Both terms
  // are gap/d, so the pair is (gap^2/(gap^2+q))^1.5 and needs no angle worked
  // out: half brightness lands about two thirds of a gap out.
  float g2 = gap * gap;
  float k = g2 / (g2 + q);
  float core = k * sqrt(k);

  // The ring's corners were once a term of their own here — two tubes meet at
  // each, and the two edges running away from the wall present their near ends
  // there, so in principle the bar should brighten toward its ends. In
  // practice an edge is a LINE source and a corner is a POINT one, so the
  // point falls off in two dimensions where the line falls off in one, and
  // whatever weight makes the corner visible makes it a hot dot. The bar came
  // out a dumbbell — two lamps with a strip between them, which is precisely
  // the look this is trying not to have. The edge alone ends softly enough.

  // The bounce keeps the plain inverse square, with no grazing term: it is
  // light that has been around the room and arrives from everywhere, so there
  // is no angle for a surface to be square to.
  float r2 = reach * reach;
  return core + bounce * (r2 / (r2 + q));
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  float reach  = max(wall.x, 1e-3);
  float bounce = wall.y;
  float gain   = wall.z;

  float2 vp = float2(float(W), float(H));
  float2 uv = (float2(gid.xy) + 0.5) / vp;
  // The wall, flat on. Depth follows the output's aspect, so the units stay
  // square and a wider output shows more wall rather than a stretched one.
  float wy = (0.5 - uv.y) * 2.0 * kWallSpan;
  float wz = (uv.x - 0.5) * 2.0 * kWallSpan * (vp.x / vp.y);

  // The glints, sweeping THROUGH the room rather than across a picture. Their
  // travel angle is read as a heading on the floor, so a glint crossing the
  // stack lights this wall and the far one at different moments — which is the
  // only thing that makes the two outputs different pictures, and it is the
  // right thing: it is the same sweep, arriving twice.
  float axis = (look.y * kWallSpan * glim.x + wz * glim.y) * look.w;
  float m = 0.0;
  [unroll]
  for (int gi = 0; gi < 8; gi++) m += nano_glint_at(axis, glints[gi]);
  float glint = max(0.0, 1.0 + m);

  float3 c = float3(0.0, 0.0, 0.0);
  [unroll]
  for (int i = 0; i < 3; i++) {
    float2 p = float2(wz, wy);
    c += layer[i].rgb * (layer[i].w * glint *
         wall_pool(p, layer_g[i].x, layer_g[i].y, layer_g[i].z, reach, bounce));
    c += ghost[i].rgb * (ghost[i].w * glint *
         wall_pool(p, ghost_g[i].x, ghost_g[i].y, ghost_g[i].z, reach, bounce));
  }
  c *= gain;

  // --- Tone -----------------------------------------------------------------
  // A soft knee on the BRIGHTEST CHANNEL, with every channel scaled by the same
  // factor. Per-channel compression is what mutes a coloured light — the strong
  // channel is squashed hardest and the hue crawls toward white on its own — and
  // this instrument's whole palette is saturated. Scaling together keeps the
  // colour exactly and only takes the level.
  float e = max(c.r, max(c.g, c.b));
  if (e > 1.0) {
    float over = e - 1.0;
    c *= (1.0 + over / (1.0 + over)) / e;
  }

  // ...and then the core goes WARM, which is the part that makes it read as
  // light rather than as a coloured shape. Real light blows its centre out
  // toward white and takes a little warmth with it as it does; the surround
  // keeps its hue outright, so nothing is washed out to get there.
  float hot = saturate((e - 0.7) * 1.4);
  float3 warm = float3(1.0, 0.92, 0.82) * max(c.r, max(c.g, c.b));
  c = lerp(c, warm, hot * saturate(look.x));

  // A dither well under one code value. The pools are wide and smooth, and
  // this is going on a wall several metres across where 8-bit banding would be
  // the most artificial thing in the picture. Integer hash, so both backends
  // land on the same noise.
  uint h = gid.x * 1973u + gid.y * 9277u + 26699u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  c += (float(h & 0xFFFFu) / 65535.0 - 0.5) * (1.5 / 255.0);

  // Opaque: black here is a projector showing nothing, not a hole.
  outputTex[gid.xy] = float4(saturate(c), 1.0);
}
