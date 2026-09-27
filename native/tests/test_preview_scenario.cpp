// nano::PreviewScenario — the effect-store preview scenario builder
// (wasm_modules/include/preview_scenario.h). It hand-writes JSON with no libc
// formatting, so pin that what it writes parses, and carries every piece.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <nlohmann/json.hpp>

#include "preview_scenario.h"

using nlohmann::json;
using Catch::Matchers::WithinAbs;

TEST_CASE("PreviewScenario: an empty scenario is valid JSON with defaults absent") {
  nano::PreviewScenario s;
  const json j = json::parse(s.json());
  CHECK(j["v"] == 1);
  CHECK_FALSE(j.contains("input"));
  CHECK(j["params"].empty());
  CHECK(j["aux"].empty());
  CHECK(j["wires"].empty());
  CHECK_FALSE(j.contains("capture"));
  CHECK_FALSE(j.contains("loop"));
}

TEST_CASE("PreviewScenario: carries input, params, aux, wires and timing") {
  nano::PreviewScenario s;
  s.input("motion")
      .param("contrast", 1.4f)
      .param("brightness", -0.25f)
      .auxGenerator("b", "edges")
      .aux("lfo", "mod.source.lfo")
      .auxParam("lfo", "rate", 0.5f)
      .wire("b.output", "$self.tex_b")
      .wire("lfo.output", "$self.opacity", "mix", "unsigned")
      .capture(1.5f)
      .loop(4.0f);
  const json j = json::parse(s.json());

  CHECK(j["input"] == "motion");
  CHECK_THAT(j["params"]["contrast"].get<double>(), WithinAbs(1.4, 1e-4));
  CHECK_THAT(j["params"]["brightness"].get<double>(), WithinAbs(-0.25, 1e-4));
  // An aux node's params stay with that node, not the previewed effect.
  CHECK_FALSE(j["params"].contains("rate"));

  REQUIRE(j["aux"].size() == 2);
  CHECK(j["aux"][0]["key"] == "b");
  CHECK(j["aux"][0]["generator"] == "edges");
  CHECK_FALSE(j["aux"][0].contains("effect"));
  CHECK(j["aux"][1]["key"] == "lfo");
  CHECK(j["aux"][1]["effect"] == "mod.source.lfo");
  CHECK_THAT(j["aux"][1]["params"]["rate"].get<double>(), WithinAbs(0.5, 1e-4));

  REQUIRE(j["wires"].size() == 2);
  CHECK(j["wires"][0]["src"] == "b.output");
  CHECK(j["wires"][0]["dest"] == "$self.tex_b");
  CHECK_FALSE(j["wires"][0].contains("combine"));
  CHECK(j["wires"][1]["combine"] == "mix");
  CHECK(j["wires"][1]["magnitude"] == "unsigned");

  CHECK_THAT(j["capture"].get<double>(), WithinAbs(1.5, 1e-4));
  CHECK_THAT(j["loop"].get<double>(), WithinAbs(4.0, 1e-4));
}

TEST_CASE("PreviewScenario: numbers round and quotes can't break the JSON") {
  nano::PreviewScenario s;
  s.param("a", 0.99999f).param("b", 12345.5f).param("c", 0.0f).input("x\"y\\z");
  const json j = json::parse(s.json());
  CHECK_THAT(j["params"]["a"].get<double>(), WithinAbs(1.0, 1e-4));
  CHECK_THAT(j["params"]["b"].get<double>(), WithinAbs(12345.5, 1e-4));
  CHECK_THAT(j["params"]["c"].get<double>(), WithinAbs(0.0, 1e-9));
  CHECK(j["input"] == "xyz");
}

TEST_CASE("PreviewScenario: table overflow drops extras instead of corrupting") {
  nano::PreviewScenario s;
  for (int i = 0; i < 40; ++i) s.param("p", (float)i);
  for (int i = 0; i < 20; ++i) s.aux("k", "e");
  for (int i = 0; i < 20; ++i) s.wire("k.o", "$self.p");
  const json j = json::parse(s.json());
  CHECK(j["aux"].size() == (size_t)nano::PreviewScenario::kMaxAux);
  CHECK(j["wires"].size() == (size_t)nano::PreviewScenario::kMaxWires);
}

TEST_CASE("PreviewScenario: vectors, escaped strings, pre stages, plot and thumb") {
  nano::PreviewScenario s;
  s.param("color", 1.f, 0.5f, 0.25f)
      .paramStr("text", "Say \"hi\"\n\\ok")
      .pre("mv", "debug.motion_rect")
      .auxParam("mv", "speed", 2.f)
      .aux("lfo", "mod.source.lfo")
      .auxParam("lfo", "tint", 0.f, 1.f, 0.f, 1.f)
      .wire("lfo.output", "$self.mix", "mix", nullptr, 0.25f)
      .output("meter")
      .plot("lfo.output")
      .thumbIcon();
  const json j = json::parse(s.json());
  CHECK(j["params"]["color"].size() == 3);
  CHECK_THAT(j["params"]["color"][1].get<double>(), WithinAbs(0.5, 1e-4));
  CHECK(j["params"]["text"] == "Say \"hi\"\n\\ok");
  REQUIRE(j["pre"].size() == 1);
  CHECK(j["pre"][0]["effect"] == "debug.motion_rect");
  CHECK_THAT(j["pre"][0]["params"]["speed"].get<double>(), WithinAbs(2.0, 1e-4));
  CHECK(j["aux"][0]["params"]["tint"].size() == 4);
  CHECK_THAT(j["wires"][0]["mixFactor"].get<double>(), WithinAbs(0.25, 1e-4));
  CHECK_FALSE(j["wires"][0].contains("magnitude"));
  CHECK(j["output"] == "meter");
  CHECK(j["plot"] == json::array({"lfo.output"}));
  CHECK(j["thumb"] == "icon");
}

TEST_CASE("PreviewScenario: optional keys stay absent by default") {
  nano::PreviewScenario s;
  s.wire("a.o", "$self.p");
  const json j = json::parse(s.json());
  CHECK_FALSE(j.contains("pre"));
  CHECK_FALSE(j.contains("plot"));
  CHECK_FALSE(j.contains("output"));
  CHECK_FALSE(j.contains("thumb"));
  CHECK_FALSE(j["wires"][0].contains("mixFactor"));
}
