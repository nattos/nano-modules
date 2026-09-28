// comp_host.h — the native HOST of a composition executor: everything around
// `comp::CompExecutor` that a native process needs to run an arrangement.
//
// One class, two users, so the parity runner exercises the code that ships:
//   - tools/comp_test_runner.mm   fixed-step scenarios + offline export;
//   - BarrelRuntime's comp instance, which the nano_compositor process drives
//     (realtime, over the bridge protocol).
//
// It owns the executor and the decode pump and does the per-frame host
// contract (comp_executor.h), with the web host's clock: effects step by the
// TRANSPORT's motion (paused = a static frame, a scrub = a seek), in this
// order:
//
//   pump (the last frame's position)  → update → host clock → transportResolve
//   → render
//
// The pump runs FIRST on purpose — web can't inject mid-frame (its pump is on
// the main thread while update+render run in the worker), so the native host
// takes the same one-frame lag or mid-play frames differ by one decoded frame.
// A realtime video scenario therefore needs >= 2 steps after a seek. Export is
// the exception: the target beat is known, so it injects before the seek.
//
// HOST ONLY. Never include from src/sketch/comp/.

#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "media/video_pump.h"
#include "sketch/comp/comp_executor.h"

namespace effect_runtime { class EffectRuntime; }
namespace gpu { class GPUBackend; }
namespace sketch_executor {
class ModuleRegistry;
class WasmEffectBundles;
}

namespace bridge {

class CompHost {
 public:
  struct Config {
    /// Render (and injected-frame) size.
    int width = 64;
    int height = 64;
    /// Frames the decode pump precaches per pull (0 disables read-ahead).
    int readAheadDepth = nano_media::kReadAheadDepth;
    /// Decode on threads (VideoPump::Config::async) — the realtime compositor.
    /// The fixed-step runner and export keep the synchronous pump.
    bool asyncDecode = false;
    /// Prefix for this comp's effect instances in the shared pool (see
    /// CompExecutor::setKeyNamespace). Required for pruneInstances() whenever
    /// the runtime hosts anything else.
    std::string keyNamespace;
  };

  /// Seeds the catalog from `registry`, binds the streams table into
  /// `bundles`, installs the library media resolver and wires the pump. All
  /// pointers must outlive the host.
  CompHost(gpu::GPUBackend* gpu, effect_runtime::EffectRuntime* rt,
           sketch_executor::ModuleRegistry* registry,
           sketch_executor::WasmEffectBundles* bundles, const Config& cfg);
  ~CompHost();

  CompHost(const CompHost&) = delete;
  CompHost& operator=(const CompHost&) = delete;

  comp::CompExecutor& executor() { return *cx_; }
  nano_media::VideoPump& pump() { return *pump_; }

  /// Re-seed every registered schema + capability set (after a module reload
  /// swapped bundles; the constructor seeds once).
  void seedSchemas();

  /// Full document replace. Also records the composition's own output height:
  /// the host may render a scaled proxy of it, and effects with pixel params
  /// need the ratio (host::pxScale).
  void loadDocument(const nlohmann::json& doc);

  /// What clip urls that aren't file paths resolve against (media_fetch.h) —
  /// the editor's page url. Survives resize (which rebuilds the pump).
  void setMediaBase(const std::string& base) {
    mediaBase_ = base;
    if (pump_) pump_->setMediaBase(base);
  }

  /// Change the render size. Recreates the output texture; the pump keeps its
  /// clips but presents at the new size from the next frame.
  void resize(int width, int height);
  int width() const { return cfg_.width; }
  int height() const { return cfg_.height; }

  /// One realtime frame (see the order above). Returns what the executor
  /// rendered into: the output texture, or the (blank) input when there was
  /// nothing to render — check `lastFlags() & kCompHasContent` for whether
  /// the composition had content at all.
  int32_t step(double dt);

  /// One offline-export frame at a PLANNED beat/time: decode + inject the
  /// exact frame first, then seek + step with dt 0 and the effect clock at
  /// `tSec`. Call primeExport(startBeat) once first. `warm`: a build-only pass
  /// that advances no effect (dt 0) — the exporter settles the chain with it
  /// before recording frame 0, as export-renderer.ts does.
  int32_t stepExport(double beat, double tSec, double fps, bool warm = false);
  /// Publish the desc set for `beat` without rendering, so an export's frame
  /// 0 has something to decode. One thrown-away update.
  void primeExport(double beat);

  /// Flags of the last update() (CompUpdateFlags).
  uint32_t lastFlags() const { return lastFlags_; }
  /// Chain keys as of the last structure change ("[]" before one).
  const std::string& chainKeysJson() const { return chainKeys_; }
  /// The output texture this host renders into.
  int32_t outputTexture() const { return outTex_; }

  /**
   * Destroy every effect instance under this comp's namespace that isn't in
   * `required` ((moduleType, bare instanceKey) — CompExecutor::requiredJson),
   * the web host's pruneInstancesExcept. A long session otherwise keeps an
   * instance for every clip it ever composited. Re-asserts state when anything
   * went, so a pruned key that re-enters the chain gets its params back.
   * Returns how many were destroyed.
   */
  size_t pruneInstances(const std::vector<std::pair<std::string, std::string>>& required);

  /// Frames stepped, and how many of them held on unready video (Precise).
  int frames() const { return frames_; }
  int stalledFrames() const { return stalledFrames_; }

 private:
  void ensureTextures();
  void publishClock(double dt);
  int32_t renderFrame(double execDt);

  gpu::GPUBackend* gpu_;
  effect_runtime::EffectRuntime* rt_;
  sketch_executor::ModuleRegistry* registry_;
  sketch_executor::WasmEffectBundles* bundles_;
  Config cfg_;

  std::unique_ptr<comp::CompExecutor> cx_;
  std::unique_ptr<nano_media::VideoPump> pump_;
  int32_t inTex_ = -1;
  int32_t outTex_ = -1;
  int texW_ = 0, texH_ = 0;

  std::string mediaBase_;
  int referenceH_ = 0;
  double hostTime_ = 0.0;
  /** Transport position at the end of the last frame (the effect clock's
   *  anchor — see step()). */
  double prevSec_ = 0.0;
  bool havePrevSec_ = false;
  uint32_t lastFlags_ = 0;
  std::string chainKeys_ = "[]";
  int frames_ = 0;
  int stalledFrames_ = 0;
};

}  // namespace bridge
