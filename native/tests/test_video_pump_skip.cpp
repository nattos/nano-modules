// test_video_pump_skip.cpp — a clip the native pump can't decode must not
// stall the Precise gate.
//
// The pump decodes DXV only (AVFoundation is the follow-up). It names every
// clip it skips (`skipped()`), and — the web's "permanently broken" rule —
// reports it READY with nothing bound, so Precise barrels past it transparent.
// Before, a skipped clip never reported ready: an H.264 or PNG clip in the
// desktop app's native engine held the transport, forcing through one frame
// per 2.5 s timeout.
//
// No GPU needed: every path here stops before a texture is made.

#include <catch2/catch_test_macros.hpp>

#include <map>
#include <string>

#include <nlohmann/json.hpp>

#include "media/video_pump.h"

using json = nlohmann::json;

namespace {

std::string mediaPath(const char* name) { return std::string(TEST_MEDIA_DIR) + "/" + name; }

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
  p.pump.setActiveClips(json::array({desc("v1", mediaPath("test_h264.mp4"))}));
  p.pump.pump(1.0, 120);

  REQUIRE(p.pump.skipped().count("v1"));
  CHECK(p.pump.skipped().at("v1").find("not a DXV stream") != std::string::npos);
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
  p.pump.setActiveClips(json::array({desc("v1", mediaPath("test_h264.mp4"))}));
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
  p.pump.setActiveClips(json::array({desc("v1", mediaPath("test_h264.mp4"))}));
  CHECK(p.pump.skipped().at("v1").find("not a DXV stream") != std::string::npos);
}
