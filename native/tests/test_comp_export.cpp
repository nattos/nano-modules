// test_comp_export.cpp — the compositor's offline MP4 export, end to end.
//
// A red clip, a gap, a green clip; exported with a blue backdrop, then decoded
// back with the pump's own AVFoundation source. Pins: the frame count comes
// from the plan (export_plan.h), each frame is the timeline at its planned
// beat, a gap exports the backdrop, and a cancel leaves no file.

#include <catch2/catch_test_macros.hpp>

#include <unistd.h>

#include <cmath>
#include <cstdlib>
#include <string>

#include <nlohmann/json.hpp>

#include "bridge/comp_export.h"
#include "gpu/gpu_backend.h"
#include "media/frame_source.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/wasm_bundles.h"

#include "wasm_paths.h"

using effect_runtime::EffectRuntime;
using json = nlohmann::json;

namespace {

json solidClip(const std::string& id, double start, double len, json rgb) {
  return {{"id", id}, {"name", id}, {"startBeat", start}, {"lengthBeat", len},
          {"kind", "effect"},
          {"sketch", {{"devices", json::array({{{"id", id + "_d"},
                                                 {"moduleType", "source.solid_color"},
                                                 {"name", "solid"},
                                                 {"capabilities", json::array()},
                                                 {"state", {{"color", rgb}}}}})}}},
          {"loop", {{"mode", "time"}, {"startSec", 0}, {"speed", 1}, {"direction", "forward"}}},
          {"automation", json::array()}, {"exports", json::array()}, {"warps", json::array()}};
}

json mkDoc() {
  json tracks = json::array({
      {{"id", "t1"}, {"name", "t1"}, {"kind", "track"}, {"parentId", nullptr},
       {"sketch", {{"devices", json::array()}}}, {"automation", json::array()},
       {"clips", json::array({solidClip("red", 0, 4, {1, 0, 0}),
                              solidClip("green", 8, 4, {0, 1, 0})})}},
      {{"id", "main-bus"}, {"name", "Main Bus"}, {"kind", "group"}, {"parentId", nullptr},
       {"sketch", {{"devices", json::array()}}}, {"automation", json::array()},
       {"clips", json::array()}},
  });
  return {{"meta", {{"resolution", {{"width", 64}, {"height", 64}}}, {"baseBPM", 120},
                    {"timeSignature", {4, 4}}}},
          {"tracks", tracks}, {"rails", json::array()},
          {"playMode", {{"defaultMode", "time"}}}};
}

struct Harness {
  std::unique_ptr<gpu::GPUBackend> backend;
  sketch_executor::WasmEffectBundles bundles;
  std::unique_ptr<EffectRuntime> rt;
  std::unique_ptr<sketch_executor::ModuleRegistry> registry;

  bool init() {
    backend = gpu::createBackend();
    if (!backend) return false;
    if (!bundles.init()) return false;
    rt = std::make_unique<EffectRuntime>(backend.get());
    registry = std::make_unique<sketch_executor::ModuleRegistry>(rt.get());
    return bundles.loadBundleFile(kCoreWasm, *registry, backend.get(), nullptr) > 1;
  }
};

std::string tempPath(const char* name) {
  const char* tmp = std::getenv("TMPDIR");
  return std::string(tmp ? tmp : "/tmp") + "/nano_export_" + std::to_string(getpid()) + "_" + name;
}

bridge::CompExportJob::Settings settings(const std::string& path) {
  bridge::CompExportJob::Settings s;
  s.path = path;
  s.width = 64;
  s.height = 64;
  s.fps = 10;
  s.startBeat = 0;
  s.endBeat = 12;  // 6 s at 120 BPM → 60 frames
  s.bg[0] = 0; s.bg[1] = 0; s.bg[2] = 255;
  return s;
}

/// Centre pixel of output frame `idx`, decoded back (BGRA).
struct Rgb { int r, g, b; };
Rgb centreOf(gpu::GPUBackend& g, nano_media::FrameSource& src, int idx) {
  const int32_t tex = g.createTexture(src.width(), src.height(), src.formatCode());
  REQUIRE(src.decode(&g, idx, tex));
  g.submit();
  const auto px = g.readbackTexture(tex, src.width(), src.height());
  g.release(tex);
  const size_t o = ((src.height() / 2) * src.width() + src.width() / 2) * 4;
  return {px[o + 2], px[o + 1], px[o]};
}

}  // namespace

TEST_CASE("export: the timeline, frame by frame, with the backdrop in the gaps", "[comp_export][gpu]") {
  Harness hx;
  if (!hx.init()) SKIP("no GPU / core.wasm");
  const std::string path = tempPath("timeline.mp4");

  {
    bridge::CompExportJob job(hx.backend.get(), hx.rt.get(), hx.registry.get(), &hx.bundles,
                              "export/");
    REQUIRE(job.start(mkDoc(), settings(path)));
    CHECK(job.framesTotal() == 60);
    while (job.step(7)) {}
    INFO(job.error());
    REQUIRE(job.finished());
    CHECK(job.framesDone() == 60);
    CHECK(job.engineFrames() == 40);  // beats 0-4 and 8-12: 4 of the 6 seconds
  }
  CHECK(hx.rt->instancePoolSize() == 0);  // the job's instances went with it

  std::string why;
  auto out = nano_media::openFrameSource(path, &why);
  INFO(why);
  REQUIRE(out);
  CHECK(out->width() == 64);
  CHECK(out->height() == 64);
  CHECK(out->frameCount() == 60);
  CHECK(out->fps() == 10.0);

  const auto near = [](int v, int want) { return std::abs(v - want) <= 12; };
  const Rgb red = centreOf(*hx.backend, *out, 10);      // beat 2
  CHECK((near(red.r, 255) && near(red.g, 0) && near(red.b, 0)));
  const Rgb gap = centreOf(*hx.backend, *out, 30);      // beat 6: the backdrop
  CHECK((near(gap.r, 0) && near(gap.g, 0) && near(gap.b, 255)));
  const Rgb green = centreOf(*hx.backend, *out, 50);    // beat 10
  CHECK((near(green.r, 0) && near(green.g, 255) && near(green.b, 0)));
  if (std::getenv("NANO_KEEP_EXPORT")) WARN("kept " << path);   // inspect with ffprobe
  else unlink(path.c_str());
}

TEST_CASE("export: a cancel leaves no file", "[comp_export][gpu]") {
  Harness hx;
  if (!hx.init()) SKIP("no GPU / core.wasm");
  const std::string path = tempPath("canceled.mp4");
  bridge::CompExportJob job(hx.backend.get(), hx.rt.get(), hx.registry.get(), &hx.bundles,
                            "export/");
  REQUIRE(job.start(mkDoc(), settings(path)));
  REQUIRE(job.step(5));
  job.cancel();
  CHECK_FALSE(job.step(5));
  CHECK_FALSE(job.finished());
  CHECK(access(path.c_str(), F_OK) != 0);
}
