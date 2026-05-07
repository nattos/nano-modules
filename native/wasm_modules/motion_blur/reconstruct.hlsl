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

Texture2D<float4>   inputTex      : register(t0);
Texture2D<float4>   motionTex     : register(t1);
Texture2D<float4>   neighborTex   : register(t2);
RWTexture2D<float4> outputTex     : register(u3);
SamplerState        linearSampler : register(s5);

cbuffer Uniforms : register(b4) {
  // row 0
  float strength;
  int   samples;
  float chroma_r;
  float chroma_g;
  // row 1
  float chroma_b;
  float _pad0;
  float _pad1;
  float _pad2;
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
// Stylized chromatic-aberration-along-motion. When non-zero, every
// per-tap sample of `inputTex` reads R/G/B at independently offset
// positions Y + V_max_px * chroma_<channel>, giving a velocity-
// proportional RGB shift. Toggle is a spec constant so the chroma
// branch is dead-stripped at compile time when off — turning it off
// costs nothing.
[[vk::constant_id(4)]] const int  CHROMA_ENABLED     = 0;
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

// Sample inputTex at `pos_px` with optional per-channel chroma offset
// along V_max. When CHROMA_ENABLED is 0 the spec constant collapses
// this to a single texture read; the chroma branch dead-strips at
// pipeline-creation time.
//
// The branch is written as an `if` on the spec constant directly
// (not a uint/int comparison) because naga rejects the SpecConstantOp
// patterns DXC emits for `if (SPEC != 0u)` — the comparison ends up
// in a SPV type slot. A bare `if (SPEC)` reads as bool-cast and
// generates a clean conditional in the WGSL output.
float4 sample_input(float2 pos_px, float2 V_max_px, float2 vp) {
  int chroma_on = CHROMA_ENABLED;
  if (chroma_on > 0) {
    float2 P_r = pos_px + V_max_px * chroma_r;
    float2 P_g = pos_px + V_max_px * chroma_g;
    float2 P_b = pos_px + V_max_px * chroma_b;
    int2 i_r = int2(clamp(P_r, float2(0.0, 0.0), vp - 1.0));
    int2 i_g = int2(clamp(P_g, float2(0.0, 0.0), vp - 1.0));
    int2 i_b = int2(clamp(P_b, float2(0.0, 0.0), vp - 1.0));
    // Green carries alpha through unmodified — picking one channel
    // as the "anchor" avoids guessing how to combine three different
    // alpha samples. Green has no special meaning beyond convention.
    float4 c_g = inputTex[i_g];
    return float4(inputTex[i_r].r, c_g.g, inputTex[i_b].b, c_g.a);
  }
  int2 i = int2(clamp(pos_px, float2(0.0, 0.0), vp - 1.0));
  return inputTex[i];
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float2 X = float2(gid.xy);
  float2 vp = float2(float(w), float(h));

  // Sample the pyramid at the chosen mip with HARDWARE BILINEAR. A
  // nearest-neighbor Load() would produce hard tile boundaries —
  // adjacent source pixels in different tiles see fully different
  // V_max values, manifesting as a visible quantization grid in the
  // output. Bilinear blends the 4 nearest pyramid texels per tap so
  // V_max varies smoothly across tile boundaries.
  //
  // Tradeoff: bilinear of a max-field can underestimate the true max
  // at boundaries (the blend of 10 and 2 is 6, but the "real" max
  // over the 2x2 region is 10). Visually that just slightly softens
  // the trail at boundaries — the alternative (sharp tiles) was the
  // worse of the two artifacts.
  //
  // The 3x3 in-shader expansion still applies: each tap is its own
  // bilinear sample, offset by one tile-step in uv space. Total
  // reach = (NBR_RADIUS * 2 + 1) * tile_size with bilinear-smooth
  // boundaries between tap regions.
  float2 base_uv = (float2(gid.xy) + 0.5) / vp;
  // One tile step in uv space. TILE_SIZE is the source-pixel
  // footprint of one pyramid texel at the chosen mip.
  float tile_step = float(TILE_SIZE);
  float2 tile_step_uv = float2(tile_step, tile_step) / vp;

  float2 V_max_uv = float2(0.0, 0.0);
  float V_max_uv_len2 = 0.0;
  for (int dy = -PYRAMID_NBR_RADIUS; dy <= PYRAMID_NBR_RADIUS; dy++) {
    for (int dx = -PYRAMID_NBR_RADIUS; dx <= PYRAMID_NBR_RADIUS; dx++) {
      float2 tap_uv = base_uv + float2(float(dx), float(dy)) * tile_step_uv;
      // SampleLevel for compute shader: explicit mip, no derivatives
      // needed. Sampler is set to linear-clamp on the C++ side.
      float2 cand = neighborTex.SampleLevel(
          linearSampler, tap_uv, float(NEIGHBOR_TEX_MIP)).xy;
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

  // X's own color, optionally chroma-shifted: the centre pixel still
  // shows the trail effect when chroma is on, so the smear isn't
  // "missing" at the seed pixel.
  float4 C_x = sample_input(X, V_max_px, vp);

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
    float4 C_y = sample_input(Y, V_max_px, vp);

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
