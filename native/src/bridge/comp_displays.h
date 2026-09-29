// comp_displays.h — the display devices' OUTPUT half of a comp host.
//
// After each rendered frame, every enabled display in the page's plan
// (display-plan.ts) presents what it shows — the composite, or a routed stage
// (CompExecutor::deviceSourceTexture) — onto its present target, scaled per
// its fit (GPUBackend::presentScaled; a slow screen is skipped, never waited
// on).
//
// The runner never touches a window. Where outputs land is a DisplaySurfaces
// provider's business:
//   - the compositor process's window code (AppKit, on its main thread —
//     tools/compositor/display_windows_mac.mm, over bridge_api.h's C
//     NanoDisplayProvider), or
//   - OffscreenDisplays: fake screens and offscreen targets, for tests and
//     headless runs (NANO_DISPLAY_REDIRECT=offscreen). Nothing opens on a
//     real screen.
//
// Screen binding (resolveScreen): the slot's remembered screen by UUID; else
// Display N takes the Nth screen that is NOT the main one, so a fresh machine
// never covers the editor; else there's no screen and the display is inert (an
// unplugged cable). A window-mode or Syphon display ignores screens.
//
// Modes: FULLSCREEN on a screen, WINDOW (rehearsal), SYPHON (a Syphon server
// the provider runs; its frame is the render size, and the provider publishes
// each one once the GPU has finished writing it).
//
// Owned by CompHost; driven on the render thread only.

#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"

namespace comp { class CompExecutor; }

namespace bridge {

struct DisplayScreen {
  std::string uuid;
  std::string name;
  int width = 0;   // pixels
  int height = 0;
  double hz = 0;
  bool main = false;  // the screen with the menu bar (the editor's, usually)
};

std::vector<DisplayScreen> parseDisplayScreens(const nlohmann::json& j);
nlohmann::json displayScreensJson(const std::vector<DisplayScreen>& screens);

enum class DisplayMode { Fullscreen, Window, Syphon };
DisplayMode parseDisplayMode(const std::string& s);
const char* displayModeName(DisplayMode m);

/// One output of the page's plan (display-plan.ts DisplayPlan.outputs).
struct DisplayOutput {
  std::string placementId;
  std::string slotId;
  std::string name;
  bool enabled = true;
  std::string screenUuid;  // this machine's binding; '' = automatic
  int ordinal = 1;         // Display N
  DisplayMode mode = DisplayMode::Fullscreen;
  nlohmann::json windowFrame;  // {x, y, w, h} (screen points) or null
  gpu::GPUBackend::PresentFit fit = gpu::GPUBackend::PresentFit::Fit;
};

std::vector<DisplayOutput> parseDisplayPlan(const nlohmann::json& plan);

/// The screen `o` binds to, as an index into `screens`, or -1 (none).
int resolveDisplayScreen(const DisplayOutput& o, const std::vector<DisplayScreen>& screens);

/// What the runner asks the provider to show: one per ENABLED output.
struct DisplayWant {
  std::string placementId;
  std::string slotId;
  std::string name;
  std::string screenUuid;  // resolved (fullscreen only)
  DisplayMode mode = DisplayMode::Fullscreen;
  nlohmann::json windowFrame;
  int width = 0, height = 0;  // Syphon: the frame size (the render size)
  bool operator==(const DisplayWant& o) const {
    return placementId == o.placementId && slotId == o.slotId && name == o.name &&
           screenUuid == o.screenUuid && mode == o.mode && windowFrame == o.windowFrame &&
           width == o.width && height == o.height;
  }
};

class DisplaySurfaces {
 public:
  virtual ~DisplaySurfaces() = default;
  virtual std::vector<DisplayScreen> screens() = 0;
  /// Bumps whenever screens() changes (hotplug).
  virtual uint64_t screensVersion() = 0;
  /// The outputs that should be up now; everything else closes. Latest wins,
  /// and may apply later (windows open on the main thread).
  virtual void reconcile(const std::vector<DisplayWant>& wants) = 0;
  /// A placement's surface once it is up: a window's `CAMetalLayer*`, a
  /// Syphon server's `IOSurfaceRef`, or (native null) an offscreen target of
  /// width × height. Width/height zero and native null: not (yet) there.
  struct Surface {
    enum Kind { Offscreen, Layer, IOSurface };
    Kind kind = Offscreen;
    void* native = nullptr;
    int width = 0;
    int height = 0;
  };
  virtual Surface surfaceFor(const std::string& placementId) = 0;
  /// A frame for `placementId`'s Syphon server is complete (the GPU is done
  /// writing its IOSurface): tell its clients. Any thread.
  virtual void publish(const std::string& placementId) { (void)placementId; }
  /// Paint `label` over a screen (or in a window) for a few seconds.
  virtual void identify(const std::string& label, const std::string& screenUuid, bool window) = 0;
  /// What happened since the last call: [{type:'closed', placementId},
  /// {type:'moved', slotId, frame}, {type:'identified', label, screenUuid}].
  virtual nlohmann::json takeEvents() = 0;
};

/// Fake screens, offscreen targets, no windows (tests; headless).
class OffscreenDisplays : public DisplaySurfaces {
 public:
  explicit OffscreenDisplays(std::vector<DisplayScreen> screens) : screens_(std::move(screens)) {}
  /// From NANO_FAKE_SCREENS (a JSON array of {uuid,name,w,h,hz,main}); none if unset.
  static std::unique_ptr<OffscreenDisplays> fromEnv();

  std::vector<DisplayScreen> screens() override { return screens_; }
  uint64_t screensVersion() override { return 1; }
  void reconcile(const std::vector<DisplayWant>& wants) override;
  Surface surfaceFor(const std::string& placementId) override;
  void identify(const std::string& label, const std::string& screenUuid, bool window) override;
  nlohmann::json takeEvents() override;

 private:
  std::vector<DisplayScreen> screens_;
  std::map<std::string, Surface> up_;
  nlohmann::json events_ = nlohmann::json::array();
};

class DisplayRunner {
 public:
  explicit DisplayRunner(gpu::GPUBackend* gpu);
  ~DisplayRunner();
  DisplayRunner(const DisplayRunner&) = delete;
  DisplayRunner& operator=(const DisplayRunner&) = delete;

  /// The page's resolved plan. Replaces the previous one. Its `armed` is the
  /// page's master output switch (absent = on): off, nothing shows.
  void setPlan(const nlohmann::json& plan);
  /// Not owned; may be null (nothing shows). Must outlive the runner, or be
  /// replaced first.
  void setSurfaces(DisplaySurfaces* surfaces);
  /// Is anything placed (enabled or not — an off display still reports)?
  bool active() const { return !outputs_.empty(); }

  /// After a SUBMITTED frame: present every enabled output. `composite` is
  /// what the executor rendered into (hasContent false ⇒ it is blank: black);
  /// width × height is the render size (a Syphon frame's size).
  void afterFrame(comp::CompExecutor& cx, int32_t composite, int width, int height,
                  bool hasContent);

  /// Identify a slot (placed or not): {label, screenUuid, ordinal, mode}.
  void identify(const nlohmann::json& m);

  /// placementId → {state, screen?, width, height, fps[, probe]}. `state`:
  /// 'showing' | 'window' | 'syphon' | 'opening' | 'no-screen' | 'off' | 'disarmed'
  /// (the master switch is off) | 'no-output'.
  /// `probe` (offscreen targets only): 16×16 RGB of what was presented, for
  /// tests.
  nlohmann::json status();
  nlohmann::json screensJson();
  uint64_t screensVersion();
  nlohmann::json takeEvents();

  /// The offscreen texture a placement presents into (tests); -1 otherwise.
  int32_t targetTexture(const std::string& placementId) const;

 private:
  struct Target {
    int32_t handle = -1;
    DisplaySurfaces::Surface::Kind kind = DisplaySurfaces::Surface::Offscreen;
    void* native = nullptr;
    int width = 0, height = 0;
    int presented = 0;       // this second
    double fps = 0;
    double windowStart = 0;  // seconds (steady clock)
    double lastProbe = -1;
  };
  struct Probes;

  void releaseTarget(Target& t);

  gpu::GPUBackend* gpu_;
  DisplaySurfaces* surfaces_ = nullptr;
  std::vector<DisplayOutput> outputs_;
  bool armed_ = true;
  std::vector<DisplayWant> lastWants_;
  bool wantsSent_ = false;
  uint64_t lastScreensVersion_ = 0;
  std::vector<DisplayScreen> screens_;
  std::map<std::string, Target> targets_;
  std::shared_ptr<Probes> probes_;
};

}  // namespace bridge
