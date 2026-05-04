// Per-pixel kernel for video.saturate. Authored once; the build emits
// both the standalone compute shader (via compute.hlsl wrapping this
// file) and the fusion fragment (via DXC + naga, see
// compile_shaders_compute_fused in wasm_build_env.sh). The runtime
// fuser splices fuse_transform into a composed compute dispatch when
// adjacent stages in a column are also fusion-compatible.

struct FuseUniforms {
  float prescale;
  float asymm;
  float linear_deadzone;
  float _pad;
};
// b2 is the canonical "uniforms" slot — slots 0/1 are tex_in/tex_out for
// the standalone compute wrapper. The runtime fuser renumbers this to a
// per-stage slot when composing a fused shader.
ConstantBuffer<FuseUniforms> u_fuse : register(b2);

[noinline]
float saturate_channel(float x) {
  float y = max(0.0, x) * u_fuse.prescale;
  float dz = saturate(u_fuse.linear_deadzone);
  float rolloff_range = max(1.0 - dz, 1e-6);
  float excess = max(0.0, y - dz);
  float steepness = exp2(u_fuse.asymm);
  float z_outside = dz + rolloff_range * tanh(excess / rolloff_range * steepness);
  return lerp(z_outside, y, step(y, dz));
}

[noinline]
float4 fuse_transform(uint2 gid, float4 c) {
  return float4(saturate_channel(c.r),
                saturate_channel(c.g),
                saturate_channel(c.b),
                c.a);
}
