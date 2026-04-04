// Spinning Triangles — Fragment Shader

struct PSInput {
  float4 pos : SV_Position;
  float4 col : COLOR;
};

float4 main(PSInput input) : SV_Target {
  return input.col;
}
