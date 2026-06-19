// debug.rw_storage_test — read-write storage-texture round trip.
//
// Two storage textures of DIFFERENT formats: an r32float read_write scratch
// and an rgba8unorm write-only output. Only the scratch carries an explicit
// [[vk::image_format("r32f")]] — DXC otherwise defaults every RWTexture to
// rgba32float, and the single registerShaderSPV format override can't express
// two formats. With scratch pinned to r32f (read_write), the output is left as
// the default rgba32float,read_write and the registerShaderSPV("rgba8unorm",
// "write") override rewrites ONLY it to rgba8unorm,write on web (rgba8 can't be
// read_write in WebGPU); the scratch's r32float,read_write is untouched.
// On native, SPIRV-Cross takes the format from the bound texture and Apple
// Silicon (read-write tier 2) accepts the write-only-used rgba8 output.
[[vk::image_format("r32f")]] RWTexture2D<float> scratch : register(u0);
RWTexture2D<float4> outputTex : register(u1);

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  uint2 p = gid.xy;

  scratch[p] = 0.25;
  float r0 = scratch[p];          // read_write: read back what we wrote
  scratch[p] = r0 + 0.5;
  float r1 = scratch[p];
  outputTex[p] = float4(r1, r1, r1, 1.0);
}
