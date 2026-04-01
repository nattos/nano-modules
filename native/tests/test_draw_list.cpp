#include <catch2/catch_test_macros.hpp>

#include "canvas/draw_list.h"

using canvas::DrawList;
using canvas::DrawCmd;

TEST_CASE("DrawList starts empty", "[draw_list]") {
  DrawList list;
  REQUIRE(list.empty());
  REQUIRE(list.size() == 0);
}

TEST_CASE("fill_rect adds command", "[draw_list]") {
  DrawList list;
  list.fill_rect(10, 20, 100, 50, 1.0f, 0.5f, 0.0f, 0.8f);

  REQUIRE(list.size() == 1);
  auto& cmd = list.commands[0];
  REQUIRE(cmd.type == DrawCmd::FillRect);
  REQUIRE(cmd.x == 10);
  REQUIRE(cmd.y == 20);
  REQUIRE(cmd.w == 100);
  REQUIRE(cmd.h == 50);
  REQUIRE(cmd.r == 1.0f);
  REQUIRE(cmd.g == 0.5f);
  REQUIRE(cmd.b == 0.0f);
  REQUIRE(cmd.a == 0.8f);
}

TEST_CASE("draw_image adds command", "[draw_list]") {
  DrawList list;
  list.draw_image(42, 0, 0, 200, 150);

  REQUIRE(list.size() == 1);
  auto& cmd = list.commands[0];
  REQUIRE(cmd.type == DrawCmd::DrawImage);
  REQUIRE(cmd.tex_id == 42);
  REQUIRE(cmd.w == 200);
  REQUIRE(cmd.h == 150);
}

TEST_CASE("draw_text adds command", "[draw_list]") {
  DrawList list;
  list.draw_text("Hello", 10, 20, 16.0f, 0.9f, 0.9f, 0.9f, 1.0f);

  REQUIRE(list.size() == 1);
  auto& cmd = list.commands[0];
  REQUIRE(cmd.type == DrawCmd::DrawText);
  REQUIRE(cmd.text == "Hello");
  REQUIRE(cmd.font_size == 16.0f);
  REQUIRE(cmd.r == 0.9f);
}

TEST_CASE("commands preserve insertion order", "[draw_list]") {
  DrawList list;
  list.fill_rect(0, 0, 10, 10, 1, 0, 0, 1);
  list.draw_text("A", 0, 0, 8, 1, 1, 1, 1);
  list.draw_image(1, 0, 0, 50, 50);
  list.fill_rect(10, 10, 20, 20, 0, 1, 0, 1);

  REQUIRE(list.size() == 4);
  REQUIRE(list.commands[0].type == DrawCmd::FillRect);
  REQUIRE(list.commands[1].type == DrawCmd::DrawText);
  REQUIRE(list.commands[2].type == DrawCmd::DrawImage);
  REQUIRE(list.commands[3].type == DrawCmd::FillRect);
}

TEST_CASE("clear removes all commands", "[draw_list]") {
  DrawList list;
  list.fill_rect(0, 0, 10, 10, 1, 0, 0, 1);
  list.draw_text("X", 0, 0, 8, 1, 1, 1, 1);
  REQUIRE(list.size() == 2);

  list.clear();
  REQUIRE(list.empty());
  REQUIRE(list.size() == 0);
}
