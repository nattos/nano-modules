// test_video_pump_async.cpp — the pump's realtime mode (Config::async).
//
// Decode runs on a thread per clip, so pump() never waits on a seek or an
// open. The contract the realtime compositor relies on, and the web pump's
// (video-compositor.ts clipReady):
//   - a clip still opening is NOT ready;
//   - ready means THIS beat's frame is the one bound; a frame not decoded yet
//     leaves the previous one bound and reports not ready;
//   - pumping again once the decode thread has caught up binds the exact frame;
//   - an open that fails lands in skipped() and reports ready (transparent).
//
// Uses the H.264 grey ramp (frame N = grey 16 + 3N) so every bound frame can be
// read back and identified.

#include <catch2/catch_test_macros.hpp>

#include "wasm_paths.h"

#include <chrono>
#include <cmath>
#include <map>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "media/video_pump.h"

using json = nlohmann::json;

namespace {

std::string mediaPath(const char* name) { return nanoMediaPath(name); }

constexpr int kW = 32, kH = 32;

/// 120 BPM, 30 fps: a beat is 15 source frames.
json rampDesc(const std::string& url) {
  return json{{"clipId", "v1"}, {"instanceKey", "v1_v"}, {"url", url},
              {"startBeat", 0}, {"lengthBeat", 64}, {"fps", 30}, {"durationFrames", 60},
              {"loop", {{"mode", "time"}, {"startSec", 0}, {"speed", 1}}}};
}

struct Harness {
  std::unique_ptr<gpu::GPUBackend> backend = gpu::createBackend();
  std::unique_ptr<nano_media::VideoPump> pump;
  int32_t bound = -1;
  std::map<std::string, bool> ready;

  bool ok() const { return backend && backend->getBackend() != 1; }  // native: Metal or D3D11

  void make(bool async) {
    nano_media::VideoPump::Config cfg;
    cfg.renderW = kW;
    cfg.renderH = kH;
    cfg.async = async;
    pump = std::make_unique<nano_media::VideoPump>(backend.get(), cfg);
    pump->setInjectSink([this](const std::string&, int32_t tex) { bound = tex; });
    pump->setReadySink([this](const std::string& id, bool r) { ready[id] = r; });
  }

  /// The ramp frame currently bound, or -1 for nothing.
  int boundFrame() {
    if (bound < 0) return -1;
    backend->submit();
    const auto px = backend->readbackTexture(bound, kW, kH);
    const size_t o = ((kH / 2) * kW + kW / 2) * 4;
    return (int)std::lround((px[o + 1] - 16.0) / 3.0);
  }

  /// Pump at `beat` until the clip reports ready (the decode thread caught up).
  bool pumpUntilReady(double beat, int maxMs = 3000) {
    const auto t0 = std::chrono::steady_clock::now();
    for (;;) {
      pump->pump(beat, 120);
      if (ready["v1"]) return true;
      if (std::chrono::steady_clock::now() - t0 > std::chrono::milliseconds(maxMs)) return false;
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
  }
};

}  // namespace

TEST_CASE("async: not ready while opening, then the exact frame", "[video_pump][gpu]") {
  Harness h;
  if (!h.ok()) SKIP("No GPU device available");
  h.make(/*async=*/true);
  h.pump->setActiveClips(json::array({rampDesc(mediaPath("test_h264_ramp.mp4"))}));

  // The first pump can't have anything: the open is on the decode thread.
  h.pump->pump(1.0, 120);
  CHECK(h.ready["v1"] == false);
  CHECK(h.bound == -1);

  REQUIRE(h.pumpUntilReady(1.0));
  CHECK(h.boundFrame() == 15);
}

TEST_CASE("async: playback binds every frame exactly, ready only when it is", "[video_pump][gpu]") {
  Harness h;
  if (!h.ok()) SKIP("No GPU device available");
  h.make(/*async=*/true);
  h.pump->setActiveClips(json::array({rampDesc(mediaPath("test_h264_ramp.mp4"))}));
  REQUIRE(h.pumpUntilReady(0.0));

  // Step through a beat and a half, one source frame at a time. Whenever the
  // pump says ready, the bound frame must be the target; when it doesn't, the
  // previous frame must still be bound (never a hole, never a wrong frame).
  int lastGood = 0;
  for (int f = 1; f < 24; f++) {
    const double beat = f / 15.0 + 1e-4;
    h.pump->pump(beat, 120);
    const int shown = h.boundFrame();
    if (h.ready["v1"]) {
      CHECK(shown == f);
      lastGood = f;
    } else {
      CHECK(shown == lastGood);
      REQUIRE(h.pumpUntilReady(beat));
      CHECK(h.boundFrame() == f);
      lastGood = f;
    }
  }
}

TEST_CASE("async: a backward seek lands exactly", "[video_pump][gpu]") {
  Harness h;
  if (!h.ok()) SKIP("No GPU device available");
  h.make(/*async=*/true);
  h.pump->setActiveClips(json::array({rampDesc(mediaPath("test_h264_ramp.mp4"))}));
  REQUIRE(h.pumpUntilReady(3.5));   // frame 52
  CHECK(h.boundFrame() == 52);
  REQUIRE(h.pumpUntilReady(0.4));   // frame 6, mid-GOP, behind the reader
  CHECK(h.boundFrame() == 6);
}

TEST_CASE("async: a failed open is skipped and ready", "[video_pump][gpu]") {
  Harness h;
  if (!h.ok()) SKIP("No GPU device available");
  h.make(/*async=*/true);
  h.pump->setActiveClips(json::array({rampDesc(mediaPath("test_not_media.mov"))}));
  REQUIRE(h.pumpUntilReady(1.0));
  CHECK(h.pump->skipped().count("v1") == 1);
  CHECK(h.bound == -1);
  // …and stays ready on later pumps (the skip path re-reports it).
  h.ready.clear();
  h.pump->pump(1.1, 120);
  CHECK(h.ready["v1"] == true);
}

TEST_CASE("async: a clip leaving mid-decode tears down without blocking", "[video_pump][gpu]") {
  Harness h;
  if (!h.ok()) SKIP("No GPU device available");
  h.make(/*async=*/true);
  h.pump->setActiveClips(json::array({rampDesc(mediaPath("test_h264_ramp.mp4"))}));
  h.pump->pump(2.0, 120);
  h.pump->setActiveClips(json::array());
  h.pump->pump(2.0, 120);
  CHECK(h.bound == -1);
  h.pump.reset();  // joins whatever is still running
}

TEST_CASE("sync mode is unchanged: the frame is bound on the first pump", "[video_pump][gpu]") {
  Harness h;
  if (!h.ok()) SKIP("No GPU device available");
  h.make(/*async=*/false);
  h.pump->setActiveClips(json::array({rampDesc(mediaPath("test_h264_ramp.mp4"))}));
  h.pump->pump(2.0, 120);
  CHECK(h.ready["v1"] == true);
  CHECK(h.boundFrame() == 30);
}

// The placement blit (frame_blitter.cpp → shaders/frame_blit.hlsl) with the
// sources every platform decodes — so it runs where H.264 doesn't yet.
TEST_CASE("the placement blit fits a still: the frame placed, the bars transparent", "[video_pump][gpu]") {
  Harness h;
  if (!h.ok()) SKIP("No GPU device available");
  h.make(/*async=*/false);
  json d = rampDesc(mediaPath("test_image_rgba.png"));  // 4x2: red, green, blue, orange
  d["durationFrames"] = 1;
  d["scaleMode"] = "fit";
  h.pump->setActiveClips(json::array({d}));
  h.pump->pump(0.5, 120);
  REQUIRE(h.ready["v1"] == true);
  REQUIRE(h.bound >= 0);
  h.backend->submit();
  const auto px = h.backend->readbackTexture(h.bound, kW, kH);
  const auto at = [&](int x, int y, int c) { return (int)px[((size_t)y * kW + x) * 4 + c]; };
  // 2:1 into 32x32 fits as 32x16, rows 8..23.
  CHECK(at(16, 2, 3) == 0);    // top bar
  CHECK(at(16, 29, 3) == 0);   // bottom bar
  CHECK(at(2, 16, 0) == 255);  // the red texel's column
  CHECK(at(2, 16, 3) == 255);
  CHECK(at(29, 16, 0) >= 199);  // the orange one (200,100,50)
  CHECK(at(29, 16, 2) <= 51);
}

TEST_CASE("a DXV clip binds real pixels through the placement blit", "[video_pump][gpu]") {
  Harness h;
  if (!h.ok()) SKIP("No GPU device available");
  h.make(/*async=*/false);
  json d = rampDesc(mediaPath("test_dxv.mov"));
  d["scaleMode"] = "stretch";
  h.pump->setActiveClips(json::array({d}));
  h.pump->pump(1.0, 120);
  REQUIRE(h.ready["v1"] == true);
  REQUIRE(h.bound >= 0);
  h.backend->submit();
  const auto px = h.backend->readbackTexture(h.bound, kW, kH);
  uint64_t rgb = 0;
  int opaque = 0;
  for (size_t i = 0; i < px.size(); i += 4) {
    rgb += px[i] + px[i + 1] + px[i + 2];
    opaque += px[i + 3] == 255;
  }
  CHECK(rgb > 0);                  // a picture, not black
  CHECK(opaque == kW * kH);        // stretch covers the frame
}
