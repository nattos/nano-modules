// comp_export.h — an offline MP4 export run inside the compositor process.
//
// The native twin of export-renderer.ts, on the same rules: its OWN comp host
// (a second engine — the live one keeps playing), at the export resolution,
// transport paused and Fluid, every frame a seek to a PLANNED beat
// (export_plan.h, on the document's warp clock) with the exact video frame
// decoded and injected first (the synchronous pump), a few dt-0 warm-up steps
// so frame 0 renders a fully-built chain, and a timeline gap exported as the
// backdrop. What differs is only the plumbing: AVFoundation decodes (so H.264
// frames are exact, not a <video> seek), and the encode is AVAssetWriter.
//
// The job is stepped from the render loop a few frames at a time (step()), so
// the live comp keeps rendering between slices: the GPU backend is
// single-threaded, so an export can't run beside it on another thread.
//
// HOST ONLY.

#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "bridge/comp_host.h"
#include "media/video_encoder.h"
#include "sketch/comp/export_plan.h"

namespace bridge {

class CompExportJob {
 public:
  struct Settings {
    std::string path;     ///< output .mp4
    int width = 0;        ///< rounded to even
    int height = 0;
    double fps = 30;
    double startBeat = 0;
    double endBeat = 0;
    int64_t bitrate = 0;
    bool ignoreSolo = false;
    /// Backdrop RGB (0..255) under transparent pixels and timeline gaps.
    uint8_t bg[3] = {0, 0, 0};
    std::string mediaBase;
  };

  /** The runtime, registry and bundles are the live host's (shared); the
   *  job's instances live under `keyNamespace`, destroyed with the job. */
  CompExportJob(gpu::GPUBackend* gpu, effect_runtime::EffectRuntime* rt,
                sketch_executor::ModuleRegistry* registry,
                sketch_executor::WasmEffectBundles* bundles, std::string keyNamespace);
  ~CompExportJob();

  /// Load the document, plan the frames, open the encoder. False + error().
  bool start(const nlohmann::json& doc, const Settings& s);
  /// Render + encode up to `maxFrames` more frames. False once the job has
  /// ended (finished, or failed — see error()).
  bool step(int maxFrames);
  /// Stop and delete the partial file.
  void cancel();

  int framesDone() const { return next_; }
  int framesTotal() const { return (int)plan_.size(); }
  int engineFrames() const { return engineFrames_; }
  bool finished() const { return finished_; }
  const std::string& error() const { return error_; }
  const Settings& settings() const { return s_; }

 private:
  bool warmUp();

  gpu::GPUBackend* gpu_;
  effect_runtime::EffectRuntime* rt_;
  sketch_executor::ModuleRegistry* registry_;
  sketch_executor::WasmEffectBundles* bundles_;
  std::string ns_;
  std::unique_ptr<CompHost> host_;
  nano_media::VideoEncoder enc_;
  Settings s_;
  std::vector<comp::ExportFrame> plan_;
  std::vector<uint8_t> frame_;
  int next_ = 0;
  int engineFrames_ = 0;
  bool warmed_ = false;
  bool finished_ = false;
  bool ended_ = false;
  std::string error_;
};

}  // namespace bridge
