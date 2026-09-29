// comp_lights.h — the light devices' OUTPUT half of a comp host.
//
// After each rendered frame, every enabled light in the page's plan
// (lights/light_map.h) reads back the texture it samples — the composite, or a
// routed stage (CompExecutor::deviceSourceTexture) — asynchronously and small
// (the backend's Lanczos downscale; the render thread never waits). The
// readback callback samples the footprints, and the whole plan is re-encoded
// into DMX and handed to the SINK (the Art-Net transmitter in production, a
// capture in tests), which sends at its own fixed rate.
//
// Identify / test patterns replace a light's sampled colours while they run;
// they are transient (never saved) and override a switched-off output — they
// are an explicit request to light the fixtures.
//
// Owned by CompHost, so comp_test_runner and the compositor run the same code.

#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "lights/light_map.h"

namespace gpu { class GPUBackend; }
namespace comp { class CompExecutor; }

namespace bridge {

/// Where encoded DMX goes. `submit` is called from the backend's readback
/// thread (and from setTest on the caller's) — implementations take the
/// latest and must not block.
class LightSink {
 public:
  virtual ~LightSink() = default;
  virtual void submit(const lights::Frames& frames) = 0;
};

class LightRunner {
 public:
  explicit LightRunner(gpu::GPUBackend* gpu);
  ~LightRunner();
  LightRunner(const LightRunner&) = delete;
  LightRunner& operator=(const LightRunner&) = delete;

  /// The page's resolved plan (light-plan.ts). Replaces the previous one.
  void setPlan(const nlohmann::json& plan);
  /// Start (`pattern` non-empty) or stop a test pattern on one light, or one
  /// slot of it (`slotId` empty = the whole light). Identify stops itself
  /// after 5 s.
  void setTest(const std::string& placementId, const std::string& slotId,
               const std::string& pattern);
  /// Not owned; may be null (nothing is sent).
  void setSink(LightSink* sink);
  /// Does the plan (or a running test) have anything to send?
  bool active() const;

  /// After a SUBMITTED frame: queue this frame's readbacks. `composite` is the
  /// texture the executor rendered into (hasContent false ⇒ it is blank).
  void afterFrame(comp::CompExecutor& cx, int32_t composite, int width, int height,
                  bool hasContent);

  /// Latest colours per light: placementId → RGB bytes (every slot's pixels
  /// in plan order, pre-gamma — what the UI draws). `version()` bumps when
  /// they change.
  std::map<std::string, std::vector<uint8_t>> colors() const;
  uint64_t version() const;

 private:
  struct State;
  gpu::GPUBackend* gpu_;
  std::shared_ptr<State> st_;
};

}  // namespace bridge
