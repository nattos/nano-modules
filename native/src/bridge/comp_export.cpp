// comp_export.cpp — see comp_export.h.

#include "bridge/comp_export.h"

#include <algorithm>
#include <cmath>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"

namespace bridge {
namespace {

/// export-renderer.ts: consecutive structure-stable warm-up frames before
/// recording, and the cap (a chain that never settles must not hang).
constexpr int kWarmupSettledFrames = 3;
constexpr int kMaxWarmupFrames = 30;

int evenDim(int n) { return std::max(2, (int)std::lround(n / 2.0) * 2); }

}  // namespace

CompExportJob::CompExportJob(gpu::GPUBackend* gpu, effect_runtime::EffectRuntime* rt,
                             sketch_executor::ModuleRegistry* registry,
                             sketch_executor::WasmEffectBundles* bundles, std::string keyNamespace)
    : gpu_(gpu), rt_(rt), registry_(registry), bundles_(bundles), ns_(std::move(keyNamespace)) {}

CompExportJob::~CompExportJob() {
  if (!ended_) cancel();
  host_.reset();
  // Its effect instances leave the shared pool with it.
  if (rt_) rt_->destroyInstancesWithKeyPrefix(ns_);
}

bool CompExportJob::start(const nlohmann::json& doc, const Settings& s) {
  s_ = s;
  s_.width = evenDim(s.width);
  s_.height = evenDim(s.height);
  s_.fps = std::max(1.0, s.fps);

  CompHost::Config cfg;
  cfg.width = s_.width;
  cfg.height = s_.height;
  cfg.asyncDecode = false;  // every frame waits for its exact decode
  cfg.keyNamespace = ns_;
  host_ = std::make_unique<CompHost>(gpu_, rt_, registry_, bundles_, cfg);
  host_->setMediaBase(s_.mediaBase);
  host_->loadDocument(doc);

  // Paused and Fluid: each frame is an explicit seek, and decode is awaited by
  // construction, so the Precise gate has nothing to guard.
  auto& cx = host_->executor();
  cx.pause();
  cx.setTransportMode(false);
  cx.setLoop(false, 0, 0);
  cx.setIgnoreSolo(s_.ignoreSolo);

  // The document's warp clock: a warped region yields more frames, as on web.
  plan_ = comp::planExportFrames(cx.warpClock(), s_.fps, s_.startBeat, s_.endBeat);
  frame_.assign((size_t)s_.width * s_.height * 4, 0);

  nano_media::VideoEncoder::Config ec;
  ec.path = s_.path;
  ec.width = s_.width;
  ec.height = s_.height;
  ec.fps = s_.fps;
  ec.bitrate = s_.bitrate;
  if (!enc_.open(ec)) {
    error_ = enc_.error();
    ended_ = true;
    return false;
  }
  if (!plan_.empty()) host_->primeExport(plan_[0].beat);
  return true;
}

bool CompExportJob::warmUp() {
  // Build the graph at the first frame's beat without moving any clock, until
  // the chain stops changing — so frame 0 isn't recorded half-instantiated.
  const auto& f0 = plan_[0];
  int settled = 0;
  for (int i = 0; i < kMaxWarmupFrames && settled < kWarmupSettledFrames; i++) {
    host_->stepExport(f0.beat, f0.tSec, s_.fps, /*warm=*/true);
    settled = (host_->lastFlags() & comp::kCompStructureChanged) ? 0 : settled + 1;
  }
  return true;
}

bool CompExportJob::step(int maxFrames) {
  if (ended_) return false;
  if (!warmed_) {
    warmed_ = true;
    if (!plan_.empty()) warmUp();
  }
  for (int n = 0; n < maxFrames && next_ < (int)plan_.size(); n++) {
    const auto& fr = plan_[(size_t)next_];
    const int32_t handle = host_->stepExport(fr.beat, fr.tSec, s_.fps);
    const bool content = (host_->lastFlags() & comp::kCompHasContent) != 0;
    if (content) {
      engineFrames_++;
      gpu_->submit();
      const auto px = gpu_->readbackTexture(handle >= 0 ? handle : host_->outputTexture(),
                                            (uint32_t)s_.width, (uint32_t)s_.height);
      if (px.size() != frame_.size()) {
        error_ = "readback failed";
        cancel();
        return false;
      }
      // Straight alpha over the backdrop — the monitor's drawImage, and what
      // engineBridge.compositeImage does. MP4 has no alpha.
      for (size_t o = 0; o < px.size(); o += 4) {
        const uint32_t a = px[o + 3], ia = 255 - a;
        for (int c = 0; c < 3; c++) frame_[o + c] = (uint8_t)((px[o + c] * a + s_.bg[c] * ia + 127) / 255);
        frame_[o + 3] = 255;
      }
    } else {
      // A gap in the timeline: the backdrop, as the web exporter does.
      for (size_t o = 0; o < frame_.size(); o += 4) {
        frame_[o] = s_.bg[0]; frame_[o + 1] = s_.bg[1]; frame_[o + 2] = s_.bg[2]; frame_[o + 3] = 255;
      }
    }
    if (!enc_.append(frame_.data(), fr.index)) {
      error_ = enc_.error();
      cancel();
      return false;
    }
    next_++;
  }
  if (next_ < (int)plan_.size()) return true;
  ended_ = true;
  if (!enc_.finish()) {
    error_ = enc_.error();
    return false;
  }
  finished_ = true;
  return false;
}

void CompExportJob::cancel() {
  if (ended_ && finished_) return;
  ended_ = true;
  enc_.cancel();
}

}  // namespace bridge
