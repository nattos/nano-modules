// video.motion_blur — Pass 3 of the McGuire reconstruction filter.
//
// For each output pixel X, fetches the dominant nearby velocity V_max
// from the NeighborMax texture and sums weighted contributions from N
// taps along the line X + t * V_max for t in (-0.5, +0.5). Each tap Y
// is weighted by McGuire's foreground/background cone tests:
//
//   foreground: does Y's swept-line path cover X this frame?
//                 cone(|X-Y|, |V_y|) — saturate(1 - dist / |V_y|).
//                 Y's content is moving; if X falls within Y's
//                 swept-line distance, Y "passes over" X.
//   background: does X's own swept-line path cover Y?
//                 cone(|X-Y|, |V_x|). Symmetric term so X's color
//                 also smears into Y's region.
//   cylinder:   tie-breaker for taps that share velocity direction.
//
// Without depth we blend foreground and background equally (50/50).
// The full filter uses depth to discriminate which side the camera
// sees; we don't have depth in this rail, so the soft blend produces
// plausible trails behind moving objects without hard popping.
//
// Per-pixel jitter (interleaved gradient noise) breaks up the regular
// sample positions and converts banding artifacts to monochrome noise
// that the eye reads as film grain.
//
// References:
//   McGuire et al., "A Reconstruction Filter for Plausible Motion
//   Blur", I3D 2012. Guertin et al., "A Fast and Stable Feature-Aware
//   Motion Blur Filter", HPG 2014 (the simplifications adopted here).

Texture2D<float4>   inputTex    : register(t0);
Texture2D<float4>   motionTex   : register(t1);
Texture2D<float4>   neighborTex : register(t2);
RWTexture2D<float4> outputTex   : register(u3);

cbuffer Uniforms : register(b4) {
  float strength;
  int   samples;
  float _pad0;
  float _pad1;
};

// Pipeline-creation-time overrides. The host fills these per-PSO via
// gpu::Constants when creating the reconstruction pipeline.
//
//   TILE_SIZE         — pixels per neighborhood-tex texel. For TileMax
//                       it's the explicit tile size; for Pyramid it's
//                       1 << NEIGHBOR_TEX_MIP (each mip texel covers a
//                       2^k × 2^k block of source pixels).
//   NEIGHBOR_TEX_MIP  — which mip of `neighborTex` to sample. 0 for
//                       TileMax (neighbor_tex has only one mip); the
//                       chosen pyramid level for Pyramid.
//   PYRAMID_NBR_RADIUS— in-shader 3×3 (or wider) sampling pattern at
//                       NEIGHBOR_TEX_MIP. 0 disables expansion (used
//                       by TileMax — its neighbor pass already
//                       expanded). 1 → 3×3, 2 → 5×5, etc.
[[vk::constant_id(0)]] const uint TILE_SIZE          = 20;
[[vk::constant_id(2)]] const uint NEIGHBOR_TEX_MIP   = 0;
[[vk::constant_id(3)]] const int  PYRAMID_NBR_RADIUS = 0;
// Below this many pixels of motion we treat the neighborhood as static
// and skip the gather entirely (just emits the input pixel as-is).
static const float HALF_VELOCITY_CUTOFF = 0.25;
// Soft transition width for the cylinder weight, in pixels.
static const float CYLINDER_SOFTNESS = 1.0;

float interleaved_gradient_noise(float2 p) {
  return frac(52.9829189 * frac(0.06711056 * p.x + 0.00583715 * p.y));
}

// Cone weight: saturate(1 - dist / |V|). Full weight when X is within
// |V|/2 of Y; zero by the time dist reaches |V|.
float cone(float dist, float v_len) {
  return saturate(1.0 - dist / max(v_len, 1e-3));
}

// Cylinder weight: 1 inside |V|, soft fall-off across CYLINDER_SOFTNESS
// pixels. Acts as a perpendicular distance test — taps whose swept
// line direction agrees with the gather direction get a small bonus.
float cylinder(float dist, float v_len) {
  return 1.0 - smoothstep(v_len - CYLINDER_SOFTNESS, v_len + CYLINDER_SOFTNESS, dist);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 X = float2(gid.xy);
  float2 vp = float2(float(w), float(h));

  // V_max is per-tile (in uv-space). Scalar per-axis divides because
  // a uint2 / spec-const division would have DXC synthesise a
  // uint2(TILE_SIZE, TILE_SIZE) which naga rejects ("Initializer must
  // be a const-expression") since the spec constant isn't const-
  // evaluable until pipeline creation time.
  uint tile_x = gid.x / TILE_SIZE;
  uint tile_y = gid.y / TILE_SIZE;
  int2 tile_coord = int2(int(tile_x), int(tile_y));

  // Pyramid path: sample multiple tile-pixels around tile_coord at
  // mip NEIGHBOR_TEX_MIP and pick the maximum-magnitude. For TileMax
  // (PYRAMID_NBR_RADIUS = 0) the loop collapses to a single tap on
  // the pre-expanded neighbor texture.
  uint nw, nh;
  uint nlevels;
  neighborTex.GetDimensions(uint(NEIGHBOR_TEX_MIP), nw, nh, nlevels);
  int max_x = int(nw) - 1;
  int max_y = int(nh) - 1;

  float2 V_max_uv = float2(0.0, 0.0);
  float V_max_uv_len2 = 0.0;
  for (int dy = -PYRAMID_NBR_RADIUS; dy <= PYRAMID_NBR_RADIUS; dy++) {
    int ty = clamp(tile_coord.y + dy, 0, max_y);
    for (int dx = -PYRAMID_NBR_RADIUS; dx <= PYRAMID_NBR_RADIUS; dx++) {
      int tx = clamp(tile_coord.x + dx, 0, max_x);
      float2 cand = neighborTex.Load(int3(tx, ty, int(NEIGHBOR_TEX_MIP))).xy;
      float l2 = dot(cand, cand);
      if (l2 > V_max_uv_len2) {
        V_max_uv_len2 = l2;
        V_max_uv = cand;
      }
    }
  }
  V_max_uv *= strength;
  float2 V_max_px = V_max_uv * vp;
  float V_max_len = length(V_max_px);

  // No motion in this neighborhood — pass through unchanged.
  if (V_max_len < HALF_VELOCITY_CUTOFF) {
    outputTex[gid.xy] = inputTex[gid.xy];
    return;
  }

  // X's own velocity (used for the background cone term).
  float2 V_x_uv = motionTex[gid.xy].xy * strength;
  float2 V_x_px = V_x_uv * vp;
  float V_x_len = length(V_x_px);

  float4 C_x = inputTex[gid.xy];

  // X's own color always weights into the average. Avoids a wrecked
  // result when every tap misses (e.g. on a thin moving feature).
  float total_w = 1.0;
  float4 total = C_x;

  // Per-pixel jitter so neighbouring pixels don't all sample the same
  // sub-pixel locations — banding becomes uniform noise.
  float jitter = interleaved_gradient_noise(X) - 0.5;

  int N = max(samples, 4);
  for (int i = 1; i <= N; i++) {
    // Distribute taps evenly across the gather range with a half-step
    // offset and per-pixel jitter. Maps i in [1, N] -> t in (-1, +1).
    float t = (float(i) + jitter) / (float(N) + 1.0);
    float offset = lerp(-1.0, 1.0, t);

    // Sample over ±V_max (total range 2·V_max). McGuire's original
    // filter samples ±V_max/2 because that's enough to find any pixel
    // whose own velocity covers X (cone weight is zero past |V_y|).
    // We widen to ±V_max so trail-pixels sitting up to V_max behind a
    // moving object can still reach the object's current position
    // — otherwise trails far from the moving feature are invisible.
    float2 Y = X + V_max_px * offset;
    int2 yi = int2(clamp(Y, float2(0.0, 0.0), vp - 1.0));

    float2 V_y_uv = motionTex[yi].xy * strength;
    float2 V_y_px = V_y_uv * vp;
    float V_y_len = length(V_y_px);
    float4 C_y = inputTex[yi];

    float dist = length(Y - X);

    float w_fg  = cone(dist, V_y_len);
    float w_bg  = cone(dist, V_x_len);
    float w_cyl = cylinder(dist, V_y_len) * cylinder(dist, V_x_len) * 2.0;

    // 50/50 foreground/background mix in absence of depth, plus the
    // cylinder bonus when both X and Y agree on direction.
    float w = w_fg * 0.5 + w_bg * 0.5 + w_cyl;

    total += C_y * w;
    total_w += w;
  }

  outputTex[gid.xy] = total / total_w;
}
