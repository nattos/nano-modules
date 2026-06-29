// Per-pixel kernel for source.noise — multiple algorithms.

#include "nano_coords.hlsl"
#include "nano_hash.hlsl"
#include "nano_curves.hlsl"

struct FuseUniforms {
  int   algorithm;
  float scale;
  float contrast;
  float seed;
  int   octaves;
  float color;
  float static_phase;
  float aspect_x;
  float aspect_y;
  float _pad_x;
  float _pad_y;
  float _pad_z;
};
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float channel_for(float2 sq, float chan_offset) {
  float cells = lerp(4.0, 64.0, u_fuse.scale);
  float2 p = sq * cells + float2(chan_offset, chan_offset * 1.7);

  // static_phase accumulates at speed*30/s. Discrete modes (white/static)
  // reroll on each integer crossing (up to ~30 Hz); smooth modes (value/fbm)
  // evolve continuously through a time axis at a gentle speed/s.
  float frame_id = floor(u_fuse.static_phase);
  float t_cont   = u_fuse.static_phase * (1.0 / 30.0);

  if (u_fuse.algorithm == 0) {
    // White: fine per-pixel white noise rerolled each frame. The fine grid
    // (p * 256) produces large coords that collapse the float hash to a few
    // banded levels, so hash in the integer domain instead. Seed offsets the
    // three axes by coprime strides to avoid diagonal correlation.
    int seed_i = int(u_fuse.seed * 4096.0);
    int3 cell = int3(int2(floor(p * 256.0)) + int2(seed_i, seed_i * 7),
                     int(frame_id) + seed_i * 13);
    return nano_hash31i(cell);
  }
  if (u_fuse.algorithm == 1) {
    return nano_value_noise3(float3(p + u_fuse.seed * 16.0, t_cont));
  }
  if (u_fuse.algorithm == 2) {
    return nano_fbm3(float3(p + u_fuse.seed * 16.0, t_cont), u_fuse.octaves);
  }
  // Static: TV-style per-frame reroll.
  return nano_hash31(float3(p, frame_id + u_fuse.seed * 16.0));
}

[noinline]
float4 fuse_transform(uint2 gid, uint2 vp_size) {
  float2 sq = nano_pixel_to_cover_square(float2(gid), float2(vp_size),
                                          float2(u_fuse.aspect_x, u_fuse.aspect_y));

  float r = channel_for(sq, 0.0);
  float g = (u_fuse.color > 0.5) ? channel_for(sq, 41.0) : r;
  float b = (u_fuse.color > 0.5) ? channel_for(sq, 79.0) : r;

  r = nano_apply_curve(r, u_fuse.contrast);
  g = nano_apply_curve(g, u_fuse.contrast);
  b = nano_apply_curve(b, u_fuse.contrast);

  return float4(saturate(float3(r, g, b)), 1.0);
}
