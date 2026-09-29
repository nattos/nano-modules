// comp_lights.cpp — see comp_lights.h.

#include "bridge/comp_lights.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <mutex>

#include "gpu/gpu_backend.h"
#include "sketch/comp/comp_executor.h"

namespace bridge {
namespace {

using Clock = std::chrono::steady_clock;
constexpr double kIdentifySec = 5.0;

}  // namespace

struct LightRunner::State {
  mutable std::mutex mu;
  std::shared_ptr<const lights::Plan> plan = std::make_shared<lights::Plan>();
  uint64_t planGen = 0;
  int readbackLong = 256;   // readback long edge (setPlan sizes it)
  LightSink* sink = nullptr;
  /// placementId → per fixture, per pixel: the last sampled colours.
  std::map<std::string, std::vector<std::vector<lights::Rgb>>> sampled;
  struct Test {
    std::string slotId;
    lights::Pattern pattern = lights::Pattern::None;
    Clock::time_point start;
  };
  std::map<std::string, Test> tests;
  std::map<std::string, std::vector<uint8_t>> shown;
  uint64_t version = 1;

  /// Colours for every light (sampled, or a test pattern), encoded for the
  /// enabled / testing ones and handed to the sink. Under `mu`.
  void publishLocked() {
    const auto now = Clock::now();
    for (auto it = tests.begin(); it != tests.end();) {
      const double t = std::chrono::duration<double>(now - it->second.start).count();
      if (it->second.pattern == lights::Pattern::Identify && t > kIdentifySec) it = tests.erase(it);
      else ++it;
    }
    lights::Frames frames;
    std::map<std::string, std::vector<uint8_t>> nextShown;
    for (const auto& o : plan->outputs) {
      const auto test = tests.find(o.placementId);
      const bool testing = test != tests.end();
      const auto samp = sampled.find(o.placementId);
      std::vector<uint8_t> bytes;
      for (size_t fi = 0; fi < o.fixtures.size(); fi++) {
        const auto& f = o.fixtures[fi];
        const size_t n = f.footprints.size();
        std::vector<lights::Rgb> colors(n);
        if (samp != sampled.end() && fi < samp->second.size() && samp->second[fi].size() == n) {
          colors = samp->second[fi];
        }
        if (testing) {
          const auto& tt = test->second;
          const bool hit = tt.slotId.empty() || tt.slotId == f.slotId;
          const double t = std::chrono::duration<double>(now - tt.start).count();
          for (size_t i = 0; i < n; i++) {
            colors[i] = hit ? lights::patternColor(tt.pattern, (int)fi, (int)o.fixtures.size(), (int)i, (int)n, t)
                            : lights::Rgb{};
          }
        }
        if (o.enabled || testing) lights::encodeFixture(f, colors, frames);
        for (const auto& c : colors) {
          bytes.push_back(lights::toByte(c.r, 1.0f));
          bytes.push_back(lights::toByte(c.g, 1.0f));
          bytes.push_back(lights::toByte(c.b, 1.0f));
        }
      }
      nextShown[o.placementId] = std::move(bytes);
    }
    if (nextShown != shown) {
      shown = std::move(nextShown);
      version++;
    }
    if (sink) sink->submit(frames);
  }
};

LightRunner::LightRunner(gpu::GPUBackend* gpu) : gpu_(gpu), st_(std::make_shared<State>()) {}

LightRunner::~LightRunner() {
  // In-flight readbacks hold `st_` (shared) and check the plan generation, so
  // a late callback is harmless — but it must never reach a dead sink.
  std::lock_guard<std::mutex> lk(st_->mu);
  st_->sink = nullptr;
}

void LightRunner::setPlan(const nlohmann::json& plan) {
  auto parsed = std::make_shared<lights::Plan>(lights::parsePlan(plan));
  // Long enough that the smallest footprint spans ~2 texels along its short
  // side, whatever the frame's aspect: 256 .. 1024.
  const float smallest = lights::smallestFootprint(*parsed);
  const int want = (int)std::ceil(2.0f / smallest * 1.8f);
  std::lock_guard<std::mutex> lk(st_->mu);
  st_->plan = std::move(parsed);
  st_->planGen++;
  st_->readbackLong = std::clamp(want, 256, 1024);
  st_->sampled.clear();
  st_->publishLocked();
}

void LightRunner::setTest(const std::string& placementId, const std::string& slotId,
                          const std::string& pattern) {
  std::lock_guard<std::mutex> lk(st_->mu);
  const auto p = lights::parsePattern(pattern);
  if (p == lights::Pattern::None) st_->tests.erase(placementId);
  else st_->tests[placementId] = {slotId, p, Clock::now()};
  st_->publishLocked();
}

void LightRunner::setSink(LightSink* sink) {
  std::lock_guard<std::mutex> lk(st_->mu);
  st_->sink = sink;
}

bool LightRunner::active() const {
  std::lock_guard<std::mutex> lk(st_->mu);
  return !st_->plan->outputs.empty() || !st_->tests.empty();
}

void LightRunner::afterFrame(comp::CompExecutor& cx, int32_t composite, int width, int height,
                             bool hasContent) {
  std::shared_ptr<const lights::Plan> plan;
  uint64_t gen = 0;
  int longEdge = 256;
  {
    std::lock_guard<std::mutex> lk(st_->mu);
    if (st_->plan->outputs.empty()) {
      if (!st_->tests.empty()) st_->publishLocked();
      return;
    }
    plan = st_->plan;
    gen = st_->planGen;
    longEdge = st_->readbackLong;
  }
  if (width <= 0 || height <= 0 || !gpu_) return;

  // Group the lights by the texture they sample: one readback per texture.
  std::map<int32_t, std::vector<size_t>> groups;
  std::vector<std::string> dark;
  for (size_t i = 0; i < plan->outputs.size(); i++) {
    const auto& o = plan->outputs[i];
    bool routed = false;
    int32_t tex = cx.lightSourceTexture(o.placementId, &routed);
    if (!routed) tex = hasContent ? composite : -1;
    if (tex > 0) groups[tex].push_back(i);
    else dark.push_back(o.placementId);
  }
  {
    std::lock_guard<std::mutex> lk(st_->mu);
    for (const auto& pid : dark) st_->sampled.erase(pid);
    if (groups.empty()) {
      st_->publishLocked();
      return;
    }
  }

  const bool wide = width >= height;
  int rw = wide ? longEdge : std::max(1, (int)std::lround((double)longEdge * width / height));
  int rh = wide ? std::max(1, (int)std::lround((double)longEdge * height / width)) : longEdge;
  // Same size takes the backend's raw-copy fast path, which returns the
  // SOURCE's format (8 bytes a texel from an RGBA16F stage). Resample instead.
  if (rw == width && rh == height) rw = std::max(1, rw - 1);

  auto st = st_;
  for (auto& [tex, idxs] : groups) {
    gpu_->readbackTextureScaledAsync(
        tex, (uint32_t)width, (uint32_t)height, (uint32_t)rw, (uint32_t)rh,
        [st, plan, gen, idxs = idxs, rw, rh](const uint8_t* px, size_t n) {
          if (!px || n < (size_t)rw * (size_t)rh * 4) return;
          std::lock_guard<std::mutex> lk(st->mu);
          if (st->planGen != gen) return;  // a newer plan: these footprints are stale
          for (size_t i : idxs) {
            const auto& o = plan->outputs[i];
            auto& per = st->sampled[o.placementId];
            per.clear();
            for (const auto& f : o.fixtures) per.push_back(lights::sampleFootprints(px, rw, rh, f));
          }
          st->publishLocked();
        });
  }
}

std::map<std::string, std::vector<uint8_t>> LightRunner::colors() const {
  std::lock_guard<std::mutex> lk(st_->mu);
  return st_->shown;
}

uint64_t LightRunner::version() const {
  std::lock_guard<std::mutex> lk(st_->mu);
  return st_->version;
}

}  // namespace bridge
