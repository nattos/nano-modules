// video.flow_swarm — shared helpers (hashes, color, mask shapes, particle
// layout, the VS→FS varyings). Both update.hlsl and the vs/fs raster pair
// include this so the GPU-resident particle layout stays consistent.

#ifndef FLOW_SWARM_COMMON_HLSL
#define FLOW_SWARM_COMMON_HLSL

// ===========================================================
// PCG bit-mix integer hash (same construction as flash_particles).
// ===========================================================
uint fsw_hash(uint x) {
  x = x * 747796405u + 2891336453u;
  uint word = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (word >> 22u) ^ word;
}
uint fsw_hash2(uint a, uint b) { return fsw_hash(a + fsw_hash(b)); }
uint fsw_hash3(uint a, uint b, uint c) {
  return fsw_hash(a + fsw_hash(b + fsw_hash(c)));
}
float fsw_unit(uint h)   { return float(h) * (1.0 / 4294967296.0); }   // [0,1)
float fsw_signed(uint h) { return fsw_unit(h) * 2.0 - 1.0; }            // [-1,1)

// ===========================================================
// Captured color packing: RGB → one float slot (asfloat of a packed
// rgba8 uint). We only ever reinterpret the bits (never do float math
// on the slot), so a NaN/inf bit pattern is harmless.
// ===========================================================
uint fsw_pack_rgb(float3 c) {
  uint r = (uint)(saturate(c.r) * 255.0 + 0.5);
  uint g = (uint)(saturate(c.g) * 255.0 + 0.5);
  uint b = (uint)(saturate(c.b) * 255.0 + 0.5);
  return r | (g << 8u) | (b << 16u);
}
float3 fsw_unpack_rgb(uint p) {
  return float3(float(p & 0xFFu), float((p >> 8u) & 0xFFu),
                float((p >> 16u) & 0xFFu)) * (1.0 / 255.0);
}

// ===========================================================
// HSV → RGB (for the optional flow-direction tint).
// ===========================================================
float3 fsw_hsv_to_rgb(float3 hsv) {
  float h = frac(hsv.x);
  float s = saturate(hsv.y);
  float v = saturate(hsv.z);
  float h6 = h * 6.0;
  float c = v * s;
  float x = c * (1.0 - abs(fmod(h6, 2.0) - 1.0));
  float m = v - c;
  float3 rgb;
  if      (h6 < 1.0) rgb = float3(c, x, 0);
  else if (h6 < 2.0) rgb = float3(x, c, 0);
  else if (h6 < 3.0) rgb = float3(0, c, x);
  else if (h6 < 4.0) rgb = float3(0, x, c);
  else if (h6 < 5.0) rgb = float3(x, 0, c);
  else               rgb = float3(c, 0, x);
  return rgb + m;
}

// ===========================================================
// Mask shapes (particle-local corner ∈ [-1,1]²).
//   0 solid · 1 circle/squircle · 2 gaussian.
// ===========================================================
float fsw_mask(float2 n, uint kind, float param) {
  if (kind == 0u) return 1.0;
  if (kind == 1u) {
    float k = lerp(2.0, 8.0, saturate(param));
    float v = pow(abs(n.x), k) + pow(abs(n.y), k);
    float r = pow(max(v, 1e-8), 1.0 / k);
    return smoothstep(1.0, 0.92, r);
  }
  float sigma = lerp(0.25, 0.85, saturate(param));
  float r2 = dot(n, n);
  float g = exp(-r2 / (sigma * sigma));
  float window = smoothstep(1.0, 0.85, sqrt(r2));
  return g * window;
}

// ===========================================================
// Particle layout — 2 vec4 = 32 bytes. 1M particles = 32 MB.
//   a.xy = pos (screen uv), a.z = life_remain (s), a.w = life_total (s)
//   b.xy = velocity (uv/s, carries momentum), b.z = size (isotropic uv),
//   b.w  = asfloat(packed rgba8 captured color)
// ===========================================================
struct Particle { float4 a; float4 b; };

// VS → FS varyings (shared so the two stages agree exactly).
struct VsOut {
  float4 pos     : SV_Position;
  float2 corner  : TEXCOORD0;                       // quad-local [-1,1]²
  nointerpolation float4 col_life : TEXCOORD1;      // rgb = captured color, w = life_norm
  nointerpolation float4 vel      : TEXCOORD2;      // xy = velocity, z = speed, w = reserved
};

#endif // FLOW_SWARM_COMMON_HLSL
