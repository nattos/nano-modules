// debug.compute_probe case 2 — write a value only 32-bit float can hold
// (above half-float's 65504) into an RGBA32F texture.
RWTexture2D<float4> big : register(u0);

[numthreads(1, 1, 1)]
void main() {
  big[uint2(0, 0)] = float4(70000.0, 0.0, 0.0, 1.0);
}
