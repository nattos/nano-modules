// debug.mrt_test fragment — writes distinct constants to two render targets.
//   target0 ← (1, 0, 0, 1)
//   target1 ← (0, 1, 0, 1)
// The combine compute pass samples both and writes (target0.r, target1.g,
// 0, 1) to the visible output. Yellow = both targets received their writes.

struct PSOutput {
  float4 c0 : SV_Target0;
  float4 c1 : SV_Target1;
};

PSOutput main() {
  PSOutput o;
  o.c0 = float4(1.0, 0.0, 0.0, 1.0);
  o.c1 = float4(0.0, 1.0, 0.0, 1.0);
  return o;
}
