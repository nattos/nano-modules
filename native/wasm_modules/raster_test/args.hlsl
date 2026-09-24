// debug.raster_test — writes the indirect draw args {6, count, 0, 0}, so the
// instance count reaches the draw only through the GPU buffer.
cbuffer Params : register(b1) {
  uint  count;
  uint  _pad0;
  uint  _pad1;
  uint  _pad2;
};
RWStructuredBuffer<uint> args : register(u0);

[numthreads(1, 1, 1)]
void main() {
  args[0] = 6u;
  args[1] = count;
  args[2] = 0u;
  args[3] = 0u;
}
