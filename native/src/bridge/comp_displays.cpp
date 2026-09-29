// comp_displays.cpp — see comp_displays.h.

#include "bridge/comp_displays.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <mutex>

#include "sketch/comp/comp_executor.h"

namespace bridge {
namespace {

using PresentFit = gpu::GPUBackend::PresentFit;

constexpr int kProbeSize = 16;
constexpr double kProbeIntervalSec = 0.25;
constexpr int kDefaultWindowW = 1280;
constexpr int kDefaultWindowH = 720;

double nowSec() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

PresentFit parseFit(const std::string& s) {
  if (s == "fill") return PresentFit::Fill;
  if (s == "stretch") return PresentFit::Stretch;
  return PresentFit::Fit;
}

std::string base64(const std::vector<uint8_t>& bytes) {
  static const char* k = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((bytes.size() + 2) / 3 * 4);
  for (size_t i = 0; i < bytes.size(); i += 3) {
    const uint32_t b0 = bytes[i];
    const uint32_t b1 = i + 1 < bytes.size() ? bytes[i + 1] : 0;
    const uint32_t b2 = i + 2 < bytes.size() ? bytes[i + 2] : 0;
    const uint32_t v = (b0 << 16) | (b1 << 8) | b2;
    out += k[(v >> 18) & 63];
    out += k[(v >> 12) & 63];
    out += i + 1 < bytes.size() ? k[(v >> 6) & 63] : '=';
    out += i + 2 < bytes.size() ? k[v & 63] : '=';
  }
  return out;
}

}  // namespace

// ── Screens + plan ──────────────────────────────────────────────────────────

std::vector<DisplayScreen> parseDisplayScreens(const nlohmann::json& j) {
  std::vector<DisplayScreen> out;
  if (!j.is_array()) return out;
  for (const auto& s : j) {
    if (!s.is_object()) continue;
    DisplayScreen d;
    d.uuid = s.value("uuid", std::string());
    d.name = s.value("name", std::string());
    d.width = s.value("w", 0);
    d.height = s.value("h", 0);
    d.hz = s.value("hz", 0.0);
    d.main = s.value("main", false);
    if (!d.uuid.empty() && d.width > 0 && d.height > 0) out.push_back(std::move(d));
  }
  return out;
}

nlohmann::json displayScreensJson(const std::vector<DisplayScreen>& screens) {
  nlohmann::json out = nlohmann::json::array();
  for (const auto& s : screens) {
    out.push_back({{"uuid", s.uuid}, {"name", s.name}, {"w", s.width}, {"h", s.height},
                   {"hz", s.hz}, {"main", s.main}});
  }
  return out;
}

std::vector<DisplayOutput> parseDisplayPlan(const nlohmann::json& plan) {
  std::vector<DisplayOutput> out;
  if (!plan.is_object() || !plan.contains("outputs") || !plan["outputs"].is_array()) return out;
  for (const auto& o : plan["outputs"]) {
    if (!o.is_object()) continue;
    DisplayOutput d;
    d.placementId = o.value("placementId", std::string());
    if (d.placementId.empty()) continue;
    d.slotId = o.value("slotId", std::string());
    d.name = o.value("name", std::string());
    d.enabled = o.value("enabled", true);
    d.screenUuid = o.value("screenUuid", std::string());
    d.ordinal = std::max(1, o.value("ordinal", 1));
    d.window = o.value("window", false);
    if (o.contains("windowFrame") && o["windowFrame"].is_object()) d.windowFrame = o["windowFrame"];
    d.fit = parseFit(o.value("fit", std::string("fit")));
    out.push_back(std::move(d));
  }
  return out;
}

int resolveDisplayScreen(const DisplayOutput& o, const std::vector<DisplayScreen>& screens) {
  if (!o.screenUuid.empty()) {
    for (size_t i = 0; i < screens.size(); i++) {
      if (screens[i].uuid == o.screenUuid) return (int)i;
    }
  }
  // Automatic: the Nth screen that isn't the main one — never the editor's.
  int n = 0;
  for (size_t i = 0; i < screens.size(); i++) {
    if (screens[i].main) continue;
    if (++n == o.ordinal) return (int)i;
  }
  return -1;
}

// ── OffscreenDisplays ───────────────────────────────────────────────────────

std::unique_ptr<OffscreenDisplays> OffscreenDisplays::fromEnv() {
  std::vector<DisplayScreen> screens;
  if (const char* env = std::getenv("NANO_FAKE_SCREENS"); env && *env) {
    screens = parseDisplayScreens(nlohmann::json::parse(env, nullptr, false));
  }
  return std::make_unique<OffscreenDisplays>(std::move(screens));
}

void OffscreenDisplays::reconcile(const std::vector<DisplayWant>& wants) {
  std::map<std::string, Surface> next;
  for (const auto& w : wants) {
    Surface s;
    if (w.window) {
      s.width = kDefaultWindowW;
      s.height = kDefaultWindowH;
      if (w.windowFrame.is_object()) {
        s.width = std::max(1, (int)w.windowFrame.value("w", (double)kDefaultWindowW));
        s.height = std::max(1, (int)w.windowFrame.value("h", (double)kDefaultWindowH));
      }
    } else {
      for (const auto& sc : screens_) {
        if (sc.uuid == w.screenUuid) {
          s.width = sc.width;
          s.height = sc.height;
        }
      }
    }
    if (s.width > 0 && s.height > 0) next[w.placementId] = s;
  }
  up_ = std::move(next);
}

DisplaySurfaces::Surface OffscreenDisplays::surfaceFor(const std::string& placementId) {
  const auto it = up_.find(placementId);
  return it == up_.end() ? Surface{} : it->second;
}

void OffscreenDisplays::identify(const std::string& label, const std::string& screenUuid,
                                 bool window) {
  events_.push_back({{"type", "identified"}, {"label", label}, {"screenUuid", screenUuid},
                     {"window", window}});
}

nlohmann::json OffscreenDisplays::takeEvents() {
  nlohmann::json out = std::move(events_);
  events_ = nlohmann::json::array();
  return out;
}

// ── DisplayRunner ───────────────────────────────────────────────────────────

/// Offscreen probes land on the backend's readback thread.
struct DisplayRunner::Probes {
  std::mutex mu;
  std::map<std::string, std::vector<uint8_t>> rgb;  // placementId → 16×16 RGB
};

DisplayRunner::DisplayRunner(gpu::GPUBackend* gpu)
    : gpu_(gpu), probes_(std::make_shared<Probes>()) {}

DisplayRunner::~DisplayRunner() {
  for (auto& [pid, t] : targets_) releaseTarget(t);
  if (surfaces_ && wantsSent_) surfaces_->reconcile({});
}

void DisplayRunner::releaseTarget(Target& t) {
  if (t.handle > 0 && gpu_) gpu_->releasePresentTarget(t.handle);
  t.handle = -1;
}

void DisplayRunner::setPlan(const nlohmann::json& plan) {
  outputs_ = parseDisplayPlan(plan);
}

void DisplayRunner::setSurfaces(DisplaySurfaces* surfaces) {
  if (surfaces == surfaces_) return;
  for (auto& [pid, t] : targets_) releaseTarget(t);
  targets_.clear();
  if (surfaces_ && wantsSent_) surfaces_->reconcile({});
  surfaces_ = surfaces;
  lastWants_.clear();
  wantsSent_ = false;
  lastScreensVersion_ = 0;
  screens_.clear();
}

uint64_t DisplayRunner::screensVersion() {
  return surfaces_ ? surfaces_->screensVersion() : 0;
}

nlohmann::json DisplayRunner::screensJson() {
  return displayScreensJson(surfaces_ ? surfaces_->screens() : std::vector<DisplayScreen>{});
}

nlohmann::json DisplayRunner::takeEvents() {
  return surfaces_ ? surfaces_->takeEvents() : nlohmann::json::array();
}

void DisplayRunner::identify(const nlohmann::json& m) {
  if (!surfaces_) return;
  DisplayOutput o;
  o.screenUuid = m.value("screenUuid", std::string());
  o.ordinal = std::max(1, m.value("ordinal", 1));
  const bool window = m.value("window", false);
  std::string uuid;
  if (!window) {
    const auto screens = surfaces_->screens();
    const int si = resolveDisplayScreen(o, screens);
    if (si < 0) return;  // nothing to identify on
    uuid = screens[si].uuid;
  }
  surfaces_->identify(m.value("label", std::string()), uuid, window);
}

void DisplayRunner::afterFrame(comp::CompExecutor& cx, int32_t composite, bool hasContent) {
  if (!surfaces_ || !gpu_) return;
  // Screens: re-read on a hotplug only.
  const uint64_t sv = surfaces_->screensVersion();
  if (sv != lastScreensVersion_) {
    lastScreensVersion_ = sv;
    screens_ = surfaces_->screens();
  }

  std::vector<DisplayWant> wants;
  for (const auto& o : outputs_) {
    if (!o.enabled) continue;
    DisplayWant w;
    w.placementId = o.placementId;
    w.slotId = o.slotId;
    w.name = o.name;
    w.window = o.window;
    w.windowFrame = o.windowFrame;
    if (!o.window) {
      const int si = resolveDisplayScreen(o, screens_);
      if (si < 0) continue;  // no screen: an unplugged cable
      w.screenUuid = screens_[si].uuid;
    }
    wants.push_back(std::move(w));
  }
  if (!wantsSent_ || wants != lastWants_) {
    surfaces_->reconcile(wants);
    lastWants_ = wants;
    wantsSent_ = true;
  }

  const double now = nowSec();
  std::map<std::string, Target> next;
  for (const auto& o : outputs_) {
    const bool wanted = std::any_of(wants.begin(), wants.end(),
                                    [&](const DisplayWant& w) { return w.placementId == o.placementId; });
    if (!wanted) continue;
    const auto s = surfaces_->surfaceFor(o.placementId);
    if (!s.layer && (s.width <= 0 || s.height <= 0)) continue;  // not up yet
    Target t;
    if (auto it = targets_.find(o.placementId); it != targets_.end()) {
      t = it->second;
      targets_.erase(it);
    }
    const bool same = s.layer ? t.layer == s.layer
                              : !t.layer && t.width == s.width && t.height == s.height;
    if (t.handle <= 0 || !same) {
      releaseTarget(t);
      t.handle = s.layer ? gpu_->createPresentTarget(s.layer)
                         : gpu_->createOffscreenPresentTarget((uint32_t)s.width, (uint32_t)s.height);
      t.layer = s.layer;
      t.presented = 0;
      t.fps = 0;
      t.windowStart = now;
      t.lastProbe = -1;
    }
    t.width = s.width;
    t.height = s.height;
    if (t.handle > 0) {
      bool routed = false;
      int32_t src = cx.deviceSourceTexture(o.placementId, &routed);
      if (!routed) src = hasContent ? composite : -1;
      if (gpu_->presentScaled(t.handle, src, o.fit)) t.presented++;
      if (now - t.windowStart >= 1.0) {
        t.fps = t.presented / (now - t.windowStart);
        t.presented = 0;
        t.windowStart = now;
      }
      // Offscreen: a small probe of what was presented, for the report.
      if (!t.layer && (t.lastProbe < 0 || now - t.lastProbe >= kProbeIntervalSec)) {
        t.lastProbe = now;
        const int32_t tex = gpu_->presentTargetTexture(t.handle);
        auto probes = probes_;
        const std::string pid = o.placementId;
        gpu_->readbackTextureScaledAsync(
            tex, (uint32_t)t.width, (uint32_t)t.height, kProbeSize, kProbeSize,
            [probes, pid](const uint8_t* px, size_t n) {
              if (!px || n < (size_t)kProbeSize * kProbeSize * 4) return;
              std::vector<uint8_t> rgb;
              rgb.reserve(kProbeSize * kProbeSize * 3);
              for (int i = 0; i < kProbeSize * kProbeSize; i++) {
                rgb.push_back(px[i * 4 + 0]);
                rgb.push_back(px[i * 4 + 1]);
                rgb.push_back(px[i * 4 + 2]);
              }
              std::lock_guard<std::mutex> lk(probes->mu);
              probes->rgb[pid] = std::move(rgb);
            });
      }
    }
    next[o.placementId] = t;
  }
  for (auto& [pid, t] : targets_) releaseTarget(t);  // no longer shown
  targets_ = std::move(next);
}

nlohmann::json DisplayRunner::status() {
  nlohmann::json out = nlohmann::json::object();
  std::map<std::string, std::vector<uint8_t>> probes;
  {
    std::lock_guard<std::mutex> lk(probes_->mu);
    probes = probes_->rgb;
  }
  for (const auto& o : outputs_) {
    nlohmann::json s = {{"state", "off"}};
    if (!surfaces_) {
      s["state"] = "no-output";
    } else if (o.enabled) {
      const int si = o.window ? -1 : resolveDisplayScreen(o, screens_);
      if (!o.window && si < 0) {
        s["state"] = "no-screen";
      } else {
        const auto it = targets_.find(o.placementId);
        const bool up = it != targets_.end() && it->second.handle > 0;
        s["state"] = !up ? "opening" : o.window ? "window" : "showing";
        if (up) {
          s["width"] = it->second.width;
          s["height"] = it->second.height;
          s["fps"] = std::round(it->second.fps * 10) / 10;
        }
        if (si >= 0) s["screen"] = displayScreensJson({screens_[si]})[0];
        const auto p = probes.find(o.placementId);
        if (up && !it->second.layer && p != probes.end()) s["probe"] = base64(p->second);
      }
    }
    out[o.placementId] = std::move(s);
  }
  return out;
}

int32_t DisplayRunner::targetTexture(const std::string& placementId) const {
  const auto it = targets_.find(placementId);
  if (it == targets_.end() || it->second.handle <= 0 || !gpu_) return -1;
  return gpu_->presentTargetTexture(it->second.handle);
}

}  // namespace bridge
