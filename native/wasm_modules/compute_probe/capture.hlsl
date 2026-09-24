// debug.compute_probe case 4 — copy the input's centre pixel, as 0..255
// integers, into a storage buffer the CPU then reads back.
Texture2D<float4> texIn : register(t0);
RWStructuredBuffer<uint> captured : register(u1);

[numthreads(1, 1, 1)]
void main() {
  uint w, h;
  texIn.GetDimensions(w, h);
  float4 c = texIn.Load(int3(w / 2u, h / 2u, 0));
  captured[0] = uint(round(saturate(c.r) * 255.0));
  captured[1] = uint(round(saturate(c.g) * 255.0));
  captured[2] = uint(round(saturate(c.b) * 255.0));
  captured[3] = 1234567u;  // marks a real snapshot
}
