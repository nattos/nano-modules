#include "canvas/canvas_renderer.h"
#include "canvas/font8x8.h"

#include <cstring>

namespace canvas {

// --- Shaders (ported from nano-selfcontrol overlay_renderer.cpp) ---

static const char* kPassthroughVert = R"(
#version 150
in vec2 aPos;
in vec2 aUV;
out vec2 vUV;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vUV = aUV;
})";

static const char* kPassthroughFrag = R"(
#version 150
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
void main() {
  fragColor = texture(uTex, vUV);
})";

static const char* kQuadVert = R"(
#version 150
in vec2 aPos;
in vec4 aColor;
out vec4 vColor;
uniform vec2 uViewport;
void main() {
  vec2 ndc = (aPos / uViewport) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vColor = aColor;
})";

static const char* kQuadFrag = R"(
#version 150
in vec4 vColor;
out vec4 fragColor;
void main() {
  fragColor = vColor;
})";

static const char* kImageVert = R"(
#version 150
in vec2 aPos;
in vec2 aUV;
out vec2 vUV;
uniform vec2 uViewport;
void main() {
  vec2 ndc = (aPos / uViewport) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUV = aUV;
})";

static const char* kImageFrag = R"(
#version 150
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
void main() {
  fragColor = texture(uTex, vUV);
})";

// Text shader: R8 atlas texture with per-vertex color
static const char* kTextVert = R"(
#version 150
in vec2 aPos;
in vec2 aUV;
in vec4 aColor;
out vec2 vUV;
out vec4 vColor;
uniform vec2 uViewport;
void main() {
  vec2 ndc = (aPos / uViewport) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUV = aUV;
  vColor = aColor;
})";

static const char* kTextFrag = R"(
#version 150
in vec2 vUV;
in vec4 vColor;
out vec4 fragColor;
uniform sampler2D uTex;
void main() {
  float alpha = texture(uTex, vUV).r;
  fragColor = vec4(vColor.rgb, vColor.a * alpha);
})";

// --- Helpers ---

GLuint CanvasRenderer::compileShader(GLenum type, const char* src) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &src, nullptr);
  glCompileShader(s);
  return s;
}

GLuint CanvasRenderer::linkProgram(GLuint vert, GLuint frag) {
  GLuint p = glCreateProgram();
  glAttachShader(p, vert);
  glAttachShader(p, frag);
  glLinkProgram(p);
  glDeleteShader(vert);
  glDeleteShader(frag);
  return p;
}

// --- Init / Deinit ---

void CanvasRenderer::init() {
  // Passthrough
  {
    GLuint v = compileShader(GL_VERTEX_SHADER, kPassthroughVert);
    GLuint f = compileShader(GL_FRAGMENT_SHADER, kPassthroughFrag);
    pt_program_ = linkProgram(v, f);
    float verts[] = { -1,-1, 0,0,  1,-1, 1,0,  -1,1, 0,1,  1,1, 1,1 };
    glGenVertexArrays(1, &pt_vao_);
    glGenBuffers(1, &pt_vbo_);
    glBindVertexArray(pt_vao_);
    glBindBuffer(GL_ARRAY_BUFFER, pt_vbo_);
    glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 16, (void*)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 16, (void*)8);
    glBindVertexArray(0);
  }

  // Colored quad shader
  {
    GLuint v = compileShader(GL_VERTEX_SHADER, kQuadVert);
    GLuint f = compileShader(GL_FRAGMENT_SHADER, kQuadFrag);
    quad_program_ = linkProgram(v, f);
    glGenVertexArrays(1, &quad_vao_);
    glGenBuffers(1, &quad_vbo_);
    glBindVertexArray(quad_vao_);
    glBindBuffer(GL_ARRAY_BUFFER, quad_vbo_);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 24, (void*)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 4, GL_FLOAT, GL_FALSE, 24, (void*)8);
    glBindVertexArray(0);
  }

  // Textured image shader
  {
    GLuint v = compileShader(GL_VERTEX_SHADER, kImageVert);
    GLuint f = compileShader(GL_FRAGMENT_SHADER, kImageFrag);
    img_program_ = linkProgram(v, f);
    glGenVertexArrays(1, &img_vao_);
    glGenBuffers(1, &img_vbo_);
    glBindVertexArray(img_vao_);
    glBindBuffer(GL_ARRAY_BUFFER, img_vbo_);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 16, (void*)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 16, (void*)8);
    glBindVertexArray(0);
  }

  // Text shader (R8 atlas + per-vertex color)
  {
    GLuint v = compileShader(GL_VERTEX_SHADER, kTextVert);
    GLuint f = compileShader(GL_FRAGMENT_SHADER, kTextFrag);
    text_program_ = linkProgram(v, f);
    glGenVertexArrays(1, &text_vao_);
    glGenBuffers(1, &text_vbo_);
    glBindVertexArray(text_vao_);
    glBindBuffer(GL_ARRAY_BUFFER, text_vbo_);
    // pos(2) + uv(2) + color(4) = 32 bytes per TextVertex
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 32, (void*)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 32, (void*)8);
    glEnableVertexAttribArray(2);
    glVertexAttribPointer(2, 4, GL_FLOAT, GL_FALSE, 32, (void*)16);
    glBindVertexArray(0);
  }

  buildFontAtlas();
}

void CanvasRenderer::deinit() {
  auto del = [](GLuint& id, auto fn) { if (id) { fn(1, &id); id = 0; } };
  auto delP = [](GLuint& id) { if (id) { glDeleteProgram(id); id = 0; } };
  delP(pt_program_); del(pt_vao_, glDeleteVertexArrays); del(pt_vbo_, glDeleteBuffers);
  delP(quad_program_); del(quad_vao_, glDeleteVertexArrays); del(quad_vbo_, glDeleteBuffers);
  delP(img_program_); del(img_vao_, glDeleteVertexArrays); del(img_vbo_, glDeleteBuffers);
  delP(text_program_); del(text_vao_, glDeleteVertexArrays); del(text_vbo_, glDeleteBuffers);
  del(font_tex_, glDeleteTextures);
}

// --- Bitmap Font Atlas ---

void CanvasRenderer::buildFontAtlas() {
  // Build a 128x48 R8 texture from font8x8 data
  // 16 columns × 6 rows of 8x8 glyphs = 96 glyphs (ASCII 32-127)
  uint8_t pixels[kFontAtlasW * kFontAtlasH];
  memset(pixels, 0, sizeof(pixels));

  for (int i = 0; i < 96; i++) {
    int col = i % kFontAtlasCols;
    int row = i / kFontAtlasCols;
    for (int py = 0; py < kFontGlyphH; py++) {
      uint8_t bits = kFont8x8[i][py];
      for (int px = 0; px < kFontGlyphW; px++) {
        if (bits & (1 << px)) {
          int ax = col * kFontGlyphW + px;
          int ay = row * kFontGlyphH + py;
          pixels[ay * kFontAtlasW + ax] = 255;
        }
      }
    }
  }

  glGenTextures(1, &font_tex_);
  glBindTexture(GL_TEXTURE_2D, font_tex_);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, kFontAtlasW, kFontAtlasH, 0,
               GL_RED, GL_UNSIGNED_BYTE, pixels);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glBindTexture(GL_TEXTURE_2D, 0);
}

// --- Passthrough ---

void CanvasRenderer::drawPassthrough(GLuint input_tex, int vp_x, int vp_y, int vp_w, int vp_h) {
  glViewport(vp_x, vp_y, vp_w, vp_h);
  glUseProgram(pt_program_);
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, input_tex);
  glUniform1i(glGetUniformLocation(pt_program_, "uTex"), 0);
  glBindVertexArray(pt_vao_);
  glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
  glBindVertexArray(0);
  glUseProgram(0);
}

// --- Quad batching ---

void CanvasRenderer::pushQuad(float x, float y, float w, float h,
                               float r, float g, float b, float a) {
  float x1 = x + w, y1 = y + h;
  auto emit = [&](float px, float py) {
    quad_batch_.push_back({px, py, r, g, b, a});
  };
  emit(x, y); emit(x1, y); emit(x, y1);
  emit(x1, y); emit(x1, y1); emit(x, y1);
}

void CanvasRenderer::flushQuads(int vp_w, int vp_h) {
  if (quad_batch_.empty()) return;
  glUseProgram(quad_program_);
  glUniform2f(glGetUniformLocation(quad_program_, "uViewport"),
              (float)vp_w, (float)vp_h);
  glBindVertexArray(quad_vao_);
  glBindBuffer(GL_ARRAY_BUFFER, quad_vbo_);
  glBufferData(GL_ARRAY_BUFFER,
               quad_batch_.size() * sizeof(ColorVertex),
               quad_batch_.data(), GL_STREAM_DRAW);
  glDrawArrays(GL_TRIANGLES, 0, (GLsizei)quad_batch_.size());
  glBindVertexArray(0);
  glUseProgram(0);
  quad_batch_.clear();
}

// --- Text rendering (8x8 bitmap font) ---

void CanvasRenderer::pushTextGlyph(char ch, float x, float y, float size,
                                    float r, float g, float b, float a) {
  int idx = (int)(unsigned char)ch - 32;
  if (idx < 0 || idx >= 96) idx = 0; // fallback to space

  int col = idx % kFontAtlasCols;
  int row = idx / kFontAtlasCols;

  float u0 = (float)(col * kFontGlyphW) / kFontAtlasW;
  float v0 = (float)(row * kFontGlyphH) / kFontAtlasH;
  float u1 = (float)((col + 1) * kFontGlyphW) / kFontAtlasW;
  float v1 = (float)((row + 1) * kFontGlyphH) / kFontAtlasH;

  float x1 = x + size, y1 = y + size;
  auto emit = [&](float px, float py, float pu, float pv) {
    text_batch_.push_back({px, py, pu, pv, r, g, b, a});
  };
  emit(x, y, u0, v0);   emit(x1, y, u1, v0);   emit(x, y1, u0, v1);
  emit(x1, y, u1, v0);  emit(x1, y1, u1, v1);  emit(x, y1, u0, v1);
}

void CanvasRenderer::drawText(const std::string& text, float x, float y, float size,
                               float r, float g, float b, float a) {
  float cursor_x = x;
  for (char ch : text) {
    if (ch >= 32 && ch < 127) {
      pushTextGlyph(ch, cursor_x, y, size, r, g, b, a);
    }
    cursor_x += size; // monospace: each character advances by size
  }
}

void CanvasRenderer::flushText(int vp_w, int vp_h) {
  if (text_batch_.empty()) return;
  glUseProgram(text_program_);
  glUniform2f(glGetUniformLocation(text_program_, "uViewport"),
              (float)vp_w, (float)vp_h);
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, font_tex_);
  glUniform1i(glGetUniformLocation(text_program_, "uTex"), 0);
  glBindVertexArray(text_vao_);
  glBindBuffer(GL_ARRAY_BUFFER, text_vbo_);
  glBufferData(GL_ARRAY_BUFFER,
               text_batch_.size() * sizeof(TextVertex),
               text_batch_.data(), GL_STREAM_DRAW);
  glDrawArrays(GL_TRIANGLES, 0, (GLsizei)text_batch_.size());
  glBindVertexArray(0);
  glUseProgram(0);
  text_batch_.clear();
}

// --- Image drawing ---

void CanvasRenderer::drawImage(GLuint tex, float x, float y, float w, float h,
                                int vp_w, int vp_h) {
  if (!tex) return;
  float x1 = x + w, y1 = y + h;
  float verts[] = {
    x,  y,  0, 0,
    x1, y,  1, 0,
    x,  y1, 0, 1,
    x1, y,  1, 0,
    x1, y1, 1, 1,
    x,  y1, 0, 1,
  };
  glUseProgram(img_program_);
  glUniform2f(glGetUniformLocation(img_program_, "uViewport"), (float)vp_w, (float)vp_h);
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, tex);
  glUniform1i(glGetUniformLocation(img_program_, "uTex"), 0);
  glBindVertexArray(img_vao_);
  glBindBuffer(GL_ARRAY_BUFFER, img_vbo_);
  glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STREAM_DRAW);
  glDrawArrays(GL_TRIANGLES, 0, 6);
  glBindVertexArray(0);
  glUseProgram(0);
}

// --- Execute DrawList ---

void CanvasRenderer::execute(const DrawList& list, int vp_w, int vp_h) {
  glEnable(GL_BLEND);
  glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

  for (const auto& cmd : list.commands) {
    switch (cmd.type) {
      case DrawCmd::FillRect:
        pushQuad(cmd.x, cmd.y, cmd.w, cmd.h, cmd.r, cmd.g, cmd.b, cmd.a);
        break;

      case DrawCmd::DrawImage:
        // Flush pending quads before switching to image shader
        flushQuads(vp_w, vp_h);
        flushText(vp_w, vp_h);
        drawImage((GLuint)cmd.tex_id, cmd.x, cmd.y, cmd.w, cmd.h, vp_w, vp_h);
        break;

      case DrawCmd::DrawText:
        drawText(cmd.text, cmd.x, cmd.y, cmd.font_size,
                 cmd.r, cmd.g, cmd.b, cmd.a);
        break;
    }
  }

  // Flush remaining batches
  flushQuads(vp_w, vp_h);
  flushText(vp_w, vp_h);

  glDisable(GL_BLEND);
}

} // namespace canvas
