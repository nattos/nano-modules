// copy_word.hlsl — the one-word buffer copy behind "write-after-bind versions
// the buffer inside a submit batch" (test_effect_render.cpp).
//
// Authored as HLSL and baked to SPIR-V like every other shader in the tree, so
// the test runs on whatever backend is live. It used to be a raw MSL literal in
// the test itself, which made the case Metal-only — and the semantic it checks
// is precisely the one the two backends reach by DIFFERENT means (Metal swaps
// in a fresh backing buffer; D3D11 gets it free from UpdateSubresource being
// queued into the command stream), so it is worth running on both.
//
// Registers are the host's slots: src 0, dst 1. Both end up in u-space on
// D3D11 — spv_to_hlsl forces every compute storage buffer to a UAV, because
// that is how computeSetBuffer binds them.

ByteAddressBuffer   src : register(t0);
RWByteAddressBuffer dst : register(u1);

[numthreads(1, 1, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  if (gid.x == 0 && gid.y == 0) dst.Store(0, src.Load(0));
}
