#pragma once

#ifdef __APPLE__
#include <OpenGL/gl3.h>
#else
#include <GL/glew.h>
#endif

#include <vector>

#include "canvas/draw_list.h"

namespace canvas {

/// OpenGL renderer that executes a DrawList.
/// Uses quad batching, bitmap font text, and textured quads.
/// Coordinates are pixel-space, top-left origin.
class CanvasRenderer {
public:
  void init();
  void deinit();

  /// Draw an FFGL input texture as full-screen passthrough.
  void drawPassthrough(GLuint input_tex, int vp_x, int vp_y, int vp_w, int vp_h);

  /// Execute all commands in the draw list.
  void execute(const DrawList& list, int vp_w, int vp_h);

private:
  // Passthrough shader
  GLuint pt_program_ = 0;
  GLuint pt_vao_ = 0;
  GLuint pt_vbo_ = 0;

  // Colored quad shader
  GLuint quad_program_ = 0;
  GLuint quad_vao_ = 0;
  GLuint quad_vbo_ = 0;

  // Textured quad shader (for images and text)
  GLuint img_program_ = 0;
  GLuint img_vao_ = 0;
  GLuint img_vbo_ = 0;

  // Bitmap font atlas (8x8 glyphs, 128x48 R8 texture)
  GLuint font_tex_ = 0;
  // Font text shader (R8 texture with color)
  GLuint text_program_ = 0;
  GLuint text_vao_ = 0;
  GLuint text_vbo_ = 0;

  struct ColorVertex { float x, y, r, g, b, a; };
  std::vector<ColorVertex> quad_batch_;

  struct TextVertex { float x, y, u, v, r, g, b, a; };
  std::vector<TextVertex> text_batch_;

  GLuint compileShader(GLenum type, const char* src);
  GLuint linkProgram(GLuint vert, GLuint frag);

  void buildFontAtlas();
  void pushQuad(float x, float y, float w, float h, float r, float g, float b, float a);
  void flushQuads(int vp_w, int vp_h);
  void pushTextGlyph(char ch, float x, float y, float size, float r, float g, float b, float a);
  void drawText(const std::string& text, float x, float y, float size,
                float r, float g, float b, float a);
  void flushText(int vp_w, int vp_h);
  void drawImage(GLuint tex, float x, float y, float w, float h, int vp_w, int vp_h);
};

} // namespace canvas
