// test_video_pump_skip.cpp — a clip the native pump can't decode must not
// stall the Precise gate.
//
// The pump names every clip no decoder takes (`skipped()`), and — the web's
// "permanently broken" rule — reports it READY with nothing bound, so Precise
// barrels past it transparent. Before, a skipped clip never reported ready:
// an H.264 or PNG clip (when the pump was DXV-only) held the desktop app's
// native transport, forcing through one frame per 2.5 s timeout.
//
// No GPU needed: every path here stops before a texture is made.

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <map>
#include <string>

#include <nlohmann/json.hpp>

#include "media/video_pump.h"

using json = nlohmann::json;

namespace {

/// A file that exists but no decoder takes.
const std::string kNotMedia = [] {
  const auto p = std::filesystem::temp_directory_path() / "nano_pump_not_media.mov";
  std::ofstream(p) << "not a movie";
  return p.string();
}();

/// Every decoder that refused is named (the last one differs per platform).
bool namesEveryDecoder(const std::string& why) {
  return why.find("dxv:") != std::string::npos && why.find("image:") != std::string::npos;
}

json desc(const std::string& clipId, const std::string& url) {
  return json{{"clipId", clipId}, {"instanceKey", clipId + "_v"}, {"url", url},
              {"startBeat", 0}, {"lengthBeat", 8}, {"fps", 30}, {"durationFrames", 30}};
}

struct Pump {
  nano_media::VideoPump pump{nullptr, {64, 64}};
  std::map<std::string, bool> ready;
  Pump() { pump.setReadySink([this](const std::string& id, bool r) { ready[id] = r; }); }
};

}  // namespace

TEST_CASE("an undecodable clip is named AND reported ready", "[video_pump]") {
  Pump p;
  p.pump.setActiveClips(json::array({desc("v1", kNotMedia)}));
  p.pump.pump(1.0, 120);

  REQUIRE(p.pump.skipped().count("v1"));
  CHECK(namesEveryDecoder(p.pump.skipped().at("v1")));
  CHECK(p.ready["v1"] == true);

  // Re-reported every pump: the executor prunes its ready set on a set change.
  p.ready.clear();
  p.pump.pump(1.1, 120);
  CHECK(p.ready["v1"] == true);
}

TEST_CASE("a clip with no locatable media is ready too", "[video_pump]") {
  Pump p;
  p.pump.setActiveClips(json::array({desc("v1", "")}));
  p.pump.pump(1.0, 120);
  CHECK(p.pump.skipped().count("v1"));
  CHECK(p.ready["v1"] == true);
}

TEST_CASE("a skipped clip that leaves the set stops being reported", "[video_pump]") {
  Pump p;
  p.pump.setActiveClips(json::array({desc("v1", kNotMedia)}));
  p.pump.setActiveClips(json::array());
  p.ready.clear();
  p.pump.pump(1.0, 120);
  CHECK(p.ready.empty());
  // Still NAMED — the runner reports every skip of the run.
  CHECK(p.pump.skipped().count("v1"));
}

TEST_CASE("a skipped clip whose source changes gets a fresh attempt", "[video_pump]") {
  Pump p;
  p.pump.setActiveClips(json::array({desc("v1", "")}));
  REQUIRE(p.pump.skipped().at("v1").find("no locatable media") != std::string::npos);
  // Relinked: the same clip id, a new source — tried again, not remembered.
  p.pump.setActiveClips(json::array({desc("v1", kNotMedia)}));
  CHECK(namesEveryDecoder(p.pump.skipped().at("v1")));
}
