#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace canvas {

struct DrawCmd {
  enum Type { FillRect, DrawImage, DrawText } type;
  float x, y, w, h;
  float r, g, b, a;
  int32_t tex_id;       // for DrawImage
  std::string text;     // for DrawText
  float font_size;      // for DrawText
};

struct DrawList {
  std::vector<DrawCmd> commands;

  void fill_rect(float x, float y, float w, float h,
                 float r, float g, float b, float a) {
    commands.push_back({DrawCmd::FillRect, x, y, w, h, r, g, b, a, 0, {}, 0});
  }

  void draw_image(int32_t tex_id, float x, float y, float w, float h) {
    commands.push_back({DrawCmd::DrawImage, x, y, w, h, 1, 1, 1, 1, tex_id, {}, 0});
  }

  void draw_text(const std::string& text, float x, float y, float size,
                 float r, float g, float b, float a) {
    commands.push_back({DrawCmd::DrawText, x, y, 0, 0, r, g, b, a, 0, text, size});
  }

  void clear() { commands.clear(); }
  bool empty() const { return commands.empty(); }
  size_t size() const { return commands.size(); }
};

} // namespace canvas
