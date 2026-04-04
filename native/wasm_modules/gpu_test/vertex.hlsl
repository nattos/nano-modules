struct VSInput {
  float2 pos : POSITION;
  float4 col : COLOR;
};

struct VSOutput {
  float4 pos : SV_Position;
  float4 col : COLOR;
};

VSOutput main(VSInput input) {
  VSOutput output;
  output.pos = float4(input.pos, 0.0, 1.0);
  output.col = input.col;
  return output;
}
