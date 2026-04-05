// --- Quad shader (colored rectangles) ---

struct QuadUniforms {
  viewport: vec2<f32>,
};

@group(0) @binding(0) var<uniform> quad_uniforms: QuadUniforms;

struct QuadVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn quad_vertex(
  @location(0) pos: vec2<f32>,
  @location(1) color: vec4<f32>,
) -> QuadVertexOutput {
  var ndc = (pos / quad_uniforms.viewport) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  var out: QuadVertexOutput;
  out.position = vec4<f32>(ndc, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn quad_fragment(in: QuadVertexOutput) -> @location(0) vec4<f32> {
  return in.color;
}

// --- Text shader (R8 font atlas + per-vertex color) ---

@group(0) @binding(0) var<uniform> text_uniforms: QuadUniforms;
@group(0) @binding(1) var font_texture: texture_2d<f32>;
@group(0) @binding(2) var font_sampler: sampler;

struct TextVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn text_vertex(
  @location(0) pos: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) color: vec4<f32>,
) -> TextVertexOutput {
  var ndc = (pos / text_uniforms.viewport) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  var out: TextVertexOutput;
  out.position = vec4<f32>(ndc, 0.0, 1.0);
  out.uv = uv;
  out.color = color;
  return out;
}

@fragment
fn text_fragment(in: TextVertexOutput) -> @location(0) vec4<f32> {
  let alpha = textureSample(font_texture, font_sampler, in.uv).r;
  return vec4<f32>(in.color.rgb, in.color.a * alpha);
}
