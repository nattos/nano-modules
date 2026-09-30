// test_frame_sources.cpp — the native decoders behind FrameSource.
//
// openFrameSource routes a file to DXV, a still, or AVFoundation; the pump's
// cache assumes every one of them is a pure function of the frame index. The
// AVFoundation source builds random access on a forward-only reader, so the
// fixture here is built to catch an off-by-one: test_h264_ramp.mp4 is 60
// frames at 30 fps, 64×64, where frame N is a flat grey of 16 + 3N, with a
// keyframe every 24 frames and B-frames (so presentation ≠ decode order, and
// a seek lands mid-GOP). Regenerate with:
//
//   ffmpeg -f lavfi -i "nullsrc=s=64x64:r=30:d=2,format=gray,geq=lum='16+3*N'" \
//     -c:v libx264 -pix_fmt yuv420p -g 24 -bf 2 -crf 10 -movflags +faststart \
//     test_h264_ramp.mp4

#include <catch2/catch_test_macros.hpp>

#include "wasm_paths.h"

#include <cmath>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

#include "gpu/gpu_backend.h"
#include "media/frame_source.h"

using nano_media::FrameSource;
using nano_media::openFrameSource;

namespace {

std::string mediaPath(const char* name) { return nanoMediaPath(name); }

std::unique_ptr<FrameSource> open(const char* name) {
  std::string why;
  auto s = openFrameSource(mediaPath(name), &why);
  INFO(name << ": " << why);
  REQUIRE(s);
  return s;
}

/// The ramp frame a decoded texture shows: grey 16 + 3N → N. The fixture's
/// frames are flat and 3 levels apart, so rounding absorbs the codec's error.
int rampFrame(const std::vector<uint8_t>& px) {
  double sum = 0;
  for (size_t i = 0; i < px.size(); i += 4) sum += px[i + 1];  // G: same in BGRA and RGBA
  const double grey = sum / (double)(px.size() / 4);
  return (int)std::lround((grey - 16.0) / 3.0);
}

struct Gpu {
  std::unique_ptr<gpu::GPUBackend> backend = gpu::createBackend();
  bool ok() const { return backend && backend->getBackend() != 1; }  // native: Metal or D3D11

  int decoded(FrameSource& s, int idx, int32_t tex) {
    REQUIRE(s.decode(backend.get(), idx, tex));
    backend->submit();
    return rampFrame(backend->readbackTexture(tex, s.width(), s.height()));
  }
};

}  // namespace

TEST_CASE("openFrameSource routes each file to its decoder", "[frame_source]") {
  CHECK(open("test_dxv.mov")->codec().substr(0, 2) == "DX");
  if (kPlatformDecodesVideo) CHECK(open("test_h264.mp4")->codec() == "avc1");
  const std::string png = open("test_image_rgba.png")->codec();  // image:public.png / image:png
  CHECK(png.rfind("image:", 0) == 0);
  CHECK(png.find("png") != std::string::npos);

  std::string why;
  CHECK_FALSE(openFrameSource(mediaPath("nope.mov"), &why));
  INFO(why);
  // Every decoder's refusal is named, not just the last one's.
  CHECK(why.find("dxv:") != std::string::npos);
  CHECK(why.find("image:") != std::string::npos);
  if (kPlatformDecodesVideo) CHECK(why.find("avfoundation:") != std::string::npos);
}

TEST_CASE("an AVFoundation source reports the container's shape", "[frame_source]") {
  NANO_REQUIRE_VIDEO_DECODE();
  auto s = open("test_h264_ramp.mp4");
  CHECK(s->width() == 64);
  CHECK(s->height() == 64);
  CHECK(s->frameCount() == 60);
  CHECK(s->fps() == 30.0);
  CHECK(s->formatCode() == 0);  // BGRA8, sampled by the pump's blit
}

TEST_CASE("AVFoundation frames are exact: forward, backward, mid-GOP", "[frame_source][gpu]") {
  NANO_REQUIRE_VIDEO_DECODE();
  Gpu g;
  if (!g.ok()) SKIP("No GPU device available");
  auto s = open("test_h264_ramp.mp4");
  const int32_t tex = g.backend->createTexture(s->width(), s->height(), s->formatCode());

  // Playback: every frame, in order, through two keyframes and the B-frames.
  for (int i = 0; i < 60; i++) REQUIRE(g.decoded(*s, i, tex) == i);

  // Scrubbing: backward, across GOPs, mid-GOP, repeats, and short hops the
  // reader serves by reading forward rather than restarting.
  for (int i : {5, 50, 13, 13, 14, 20, 47, 0, 59, 30, 29, 31, 36, 12}) {
    INFO("frame " << i);
    CHECK(g.decoded(*s, i, tex) == i);
  }
}

TEST_CASE("a still decodes as one straight-alpha RGBA frame", "[frame_source][gpu]") {
  Gpu g;
  if (!g.ok()) SKIP("No GPU device available");
  auto s = open("test_image_rgba.png");
  REQUIRE(s->width() == 4);
  REQUIRE(s->height() == 2);
  CHECK(s->frameCount() == 1);
  CHECK(s->formatCode() == 1);

  const int32_t tex = g.backend->createTexture(4, 2, 1);
  REQUIRE(s->decode(g.backend.get(), 0, tex));
  CHECK_FALSE(s->decode(g.backend.get(), 1, tex));
  g.backend->submit();
  const auto px = g.backend->readbackTexture(tex, 4, 2);
  REQUIRE(px.size() == 32);

  // Written as (255,0,0,255) (0,255,0,128) (0,0,255,64) (200,100,50,255).
  // Straight alpha, as web's copyExternalImageToTexture leaves it: the
  // half-transparent green is still full green, not 128.
  const auto at = [&](int x, int c) { return (int)px[x * 4 + c]; };
  CHECK(at(0, 0) == 255); CHECK(at(0, 3) == 255);
  CHECK(at(1, 1) >= 254); CHECK(at(1, 3) == 128);
  CHECK(at(2, 2) >= 252); CHECK(at(2, 3) == 64);
  CHECK(std::abs(at(3, 0) - 200) <= 1);
  CHECK(std::abs(at(3, 1) - 100) <= 1);
  CHECK(std::abs(at(3, 2) - 50) <= 1);
}

// Timing, not a gate: `NANO_BENCH_MEDIA=/path/to/clip ./test_frame_sources "[.bench]"`.
// Sequential playback, then scattered seeks — what a threaded pump has to hide.
TEST_CASE("decode timing on a real clip", "[.bench]") {
  const char* path = std::getenv("NANO_BENCH_MEDIA");
  if (!path) SKIP("set NANO_BENCH_MEDIA");
  Gpu g;
  if (!g.ok()) SKIP("No GPU device available");
  std::string why;
  auto s = openFrameSource(path, &why);
  INFO(why);
  REQUIRE(s);
  const int32_t tex = g.backend->createTexture(s->width(), s->height(), s->formatCode());
  const auto time = [&](int idx) {
    REQUIRE(s->decode(g.backend.get(), idx, tex));
    g.backend->submit();
    return s->lastDecodeMs();
  };
  double seqMax = 0, seqSum = 0;
  const int n = std::min(120, s->frameCount());
  for (int i = 0; i < n; i++) {
    const double ms = time(i);
    seqSum += ms;
    seqMax = std::max(seqMax, ms);
  }
  double seekMax = 0, seekSum = 0;
  const int seeks = 20;
  for (int k = 0; k < seeks; k++) {
    const int idx = (int)((k * 7919L) % s->frameCount());
    const double ms = time(idx);
    seekSum += ms;
    seekMax = std::max(seekMax, ms);
  }
  WARN(s->codec() << " " << s->width() << "x" << s->height() << ": sequential mean "
                  << seqSum / n << " ms (max " << seqMax << "), seek mean " << seekSum / seeks
                  << " ms (max " << seekMax << ")");
}
