// debug.mrt_test vertex — fullscreen triangle, no vertex buffer.
// Three vertices, IDs 0/1/2 → (-1,-1), (3,-1), (-1,3).

struct VSOutput {
  float4 position : SV_Position;
};

VSOutput main(uint vid : SV_VertexID) {
  float2 pts[3] = {
    float2(-1.0, -1.0),
    float2( 3.0, -1.0),
    float2(-1.0,  3.0),
  };
  VSOutput o;
  o.position = float4(pts[vid], 0.0, 1.0);
  return o;
}
