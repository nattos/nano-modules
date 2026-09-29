// test_light_map.cpp — goldens for the light devices' pixel mapping
// (lights/light_map.h): plan parsing, footprint sampling, DMX encoding and
// the identify / test patterns. Pure CPU — no GPU, no socket.

#include <catch2/catch_test_macros.hpp>

#include <vector>

#include "lights/light_map.h"

using namespace lights;

namespace {

/// A w×h RGBA8 image, every texel `fill(x, y)`.
template <class F>
std::vector<uint8_t> image(int w, int h, F fill) {
  std::vector<uint8_t> px((size_t)w * h * 4);
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      const auto c = fill(x, y);
      uint8_t* p = &px[((size_t)y * w + x) * 4];
      p[0] = c[0]; p[1] = c[1]; p[2] = c[2]; p[3] = 255;
    }
  }
  return px;
}

Fixture strip(int pixels, float x, Format fmt = Format::RGB, float gamma = 1.0f, int channel = 1) {
  Fixture f;
  f.slotId = "s";
  f.channel = channel;
  f.format = fmt;
  f.gamma = gamma;
  for (int i = 0; i < pixels; i++) {
    f.footprints.push_back({x - 0.05f, (float)i / pixels, x + 0.05f, (float)(i + 1) / pixels});
  }
  return f;
}

}  // namespace

TEST_CASE("light plan parses and skips malformed entries", "[light_map]") {
  const auto plan = parsePlan(nlohmann::json::parse(R"({"outputs":[
    {"placementId":"p1","enabled":true,"fixtures":[
      {"slotId":"a","universe":3,"channel":41,"dest":"10.0.0.5","format":"rgbw","gamma":2.5,
       "footprints":[[0,0,0.1,0.1],[0,0.1,0.1],"bad"]}]},
    {"enabled":true},
    {"placementId":"p2","enabled":false,"fixtures":[]}]})"));
  REQUIRE(plan.outputs.size() == 2);
  const auto& f = plan.outputs[0].fixtures.at(0);
  CHECK(f.universe == 3);
  CHECK(f.channel == 41);
  CHECK(f.dest == "10.0.0.5");
  CHECK(f.format == Format::RGBW);
  CHECK(f.gamma == 2.5f);
  CHECK(f.footprints.size() == 1);
  CHECK_FALSE(plan.outputs[1].enabled);
  CHECK(plan.anyEnabled());
}

TEST_CASE("footprints box-average the texels whose centres they cover", "[light_map]") {
  // Left half red, right half blue; a footprint straddling the middle averages.
  const auto px = image(8, 4, [](int x, int) {
    return x < 4 ? std::array<uint8_t, 3>{255, 0, 0} : std::array<uint8_t, 3>{0, 0, 255};
  });
  Fixture f;
  f.footprints = {{0.0f, 0.0f, 0.5f, 1.0f}, {0.25f, 0.0f, 0.75f, 1.0f}, {0.9f, 0.4f, 0.91f, 0.41f}};
  const auto c = sampleFootprints(px.data(), 8, 4, f);
  CHECK(c[0] == Rgb{1, 0, 0});
  CHECK(c[1] == Rgb{0.5f, 0, 0.5f});
  // Too small to hold a texel centre: the texel under its centre.
  CHECK(c[2] == Rgb{0, 0, 1});
}

TEST_CASE("rows are top-down: pixel 0 of a vertical strip samples the top", "[light_map]") {
  const auto px = image(4, 10, [](int, int y) {
    return y == 0 ? std::array<uint8_t, 3>{255, 255, 255} : std::array<uint8_t, 3>{0, 0, 0};
  });
  const auto c = sampleFootprints(px.data(), 4, 10, strip(10, 0.5f));
  CHECK(c[0] == Rgb{1, 1, 1});
  CHECK(c[1] == Rgb{0, 0, 0});
}

TEST_CASE("encode: channel order, RGBW white extraction, gamma, start channel", "[light_map]") {
  const std::vector<Rgb> colors = {{1.0f, 0.5f, 0.0f}, {1, 1, 1}};
  Frames frames;
  encodeFixture(strip(2, 0.5f, Format::GRB), colors, frames);
  auto u = frames.at({"broadcast", 0});
  CHECK(u[0] == 128); CHECK(u[1] == 255); CHECK(u[2] == 0);   // G R B
  CHECK(u[3] == 255); CHECK(u[4] == 255); CHECK(u[5] == 255);

  frames.clear();
  encodeFixture(strip(2, 0.5f, Format::RGBW, 1.0f, 41), {{1, 1, 0.25f}, {1, 1, 1}}, frames);
  u = frames.at({"broadcast", 0});
  CHECK(u[39] == 0);                                           // nothing before ch 41
  CHECK(u[40] == 191); CHECK(u[41] == 191); CHECK(u[42] == 0); CHECK(u[43] == 64);
  CHECK(u[44] == 0); CHECK(u[45] == 0); CHECK(u[46] == 0); CHECK(u[47] == 255);

  frames.clear();
  encodeFixture(strip(1, 0.5f, Format::RGB, 2.5f), {{0.5f, 1, 0}}, frames);
  u = frames.at({"broadcast", 0});
  CHECK(u[0] == 45);   // 255 * 0.5^2.5
  CHECK(u[1] == 255);
}

TEST_CASE("pixels past channel 512 are dropped, never spilled", "[light_map]") {
  Frames frames;
  encodeFixture(strip(3, 0.5f, Format::RGBW, 1.0f, 505), {{1, 0, 0}, {1, 0, 0}, {1, 0, 0}}, frames);
  const auto& u = frames.at({"broadcast", 0});
  CHECK(u[504] == 255);   // first pixel: channels 505..508
  CHECK(u[508] == 255);   // second: 509..512
  CHECK(frames.size() == 1);
}

TEST_CASE("test patterns", "[light_map]") {
  CHECK(parsePattern("identify") == Pattern::Identify);
  CHECK(parsePattern("nope") == Pattern::None);
  CHECK(patternColor(Pattern::White, 0, 3, 10, 0) == Rgb{1, 1, 1});
  CHECK(patternColor(Pattern::Off, 0, 3, 10, 0) == Rgb{0, 0, 0});
  CHECK(patternColor(Pattern::Colors, 0, 0, 10, 1.5) == Rgb{0, 1, 0});
  // numbers: slot 2 lights three pixels
  CHECK(patternColor(Pattern::Numbers, 2, 2, 10, 0) == Rgb{1, 1, 1});
  CHECK(patternColor(Pattern::Numbers, 2, 3, 10, 0) == Rgb{0, 0, 0});
  // chase: 12 px/s — at t = 0.25 the dot is on pixel 3
  CHECK(patternColor(Pattern::Chase, 0, 3, 10, 0.25) == Rgb{1, 1, 1});
  CHECK(patternColor(Pattern::Chase, 0, 4, 10, 0.25) == Rgb{0, 0, 0});
  // identify: pixel 0 stays red so the strip's direction shows
  CHECK(patternColor(Pattern::Identify, 0, 0, 10, 0.25) == Rgb{1, 0, 0});
}
