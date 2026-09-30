// display_windows_win.cpp — see display_windows.h. The Win32 counterpart of
// display_windows_mac.mm.
//
//   - Screens: QueryDisplayConfig's active paths, one per SOURCE (a mirrored
//     pair is one screen). Identified by the monitor's device path (stable
//     across reboots and hotplug, unlike an index or \\.\DISPLAYn), named by
//     its EDID friendly name. Sizes are physical pixels: the process is
//     per-monitor DPI aware. Hotplug: WM_DISPLAYCHANGE, which Windows
//     broadcasts to top-level windows — so the control window is a hidden
//     top-level one, not message-only.
//   - Fullscreen: a borderless topmost popup over the monitor's whole rect
//     (taskbar included), never activated, not in Alt+Tab. The engine presents
//     into it through a flip-model swap chain (GPUBackend::createPresentTarget
//     takes the HWND); covering a whole monitor, DWM hands it independent flip.
//   - Window mode: a normal window; closing it turns the display off (a
//     `closed` event); moving or sizing it is remembered (`moved`, the client
//     rect in physical pixels, origin top-left).
//   - Spout mode: a sender, no window (spout_outputs.h).
//   - Ctrl+Shift+D ("Disable Output", as in Resolume): a system hotkey while
//     any output is up — every output off at once, `disableOutput` reported.
//     (No ⌘Q counterpart: an output never takes focus, and Alt+F4 on a
//     rehearsal window closes that window, the Windows way.)
//
// A closed window is HIDDEN at once and destroyed a moment later: the render
// thread may still hold a swap chain on it for a frame.

#include "compositor/display_windows.h"
#include "compositor/spout_outputs.h"

#include <windows.h>
#include <dxgi.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/d3d11_adapter_win.h"

using json = nlohmann::json;

namespace compositor {
namespace {

constexpr double kIdentifySec = 3.0;
constexpr double kRetireSec = 2.0;  // a closed window outlives the render thread's use
constexpr UINT kMsgApply = WM_APP + 1;
constexpr UINT kMsgIdentify = WM_APP + 2;
constexpr UINT_PTR kTimerRescan = 1;
constexpr int kHotKeyDisable = 1;
const wchar_t* kControlClass = L"NanoCompositorControl";
const wchar_t* kOutputClass = L"NanoCompositorOutput";
const wchar_t* kIdentifyClass = L"NanoCompositorIdentify";

char* dupString(const std::string& s) {
  char* out = (char*)std::malloc(s.size() + 1);
  std::memcpy(out, s.c_str(), s.size() + 1);
  return out;
}

double nowSec() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

std::string utf8(const wchar_t* w) {
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return std::string();
  std::string out((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), n, nullptr, nullptr);
  out.resize((size_t)n - 1);
  return out;
}

std::wstring wide(const std::string& s) {
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  if (n <= 1) return std::wstring();
  std::wstring out((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
  out.resize((size_t)n - 1);
  return out;
}

/// Per-monitor DPI awareness (v2), so every rect here is physical pixels.
/// Must precede the first window in the process.
void becomeDpiAware() {
  using Fn = BOOL(WINAPI*)(HANDLE);
  if (auto fn = (Fn)(void*)GetProcAddress(GetModuleHandleW(L"user32.dll"),
                                          "SetProcessDpiAwarenessContext")) {
    fn((HANDLE)-4);  // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
  }
}

UINT dpiOf(HWND hwnd) {
  using Fn = UINT(WINAPI*)(HWND);
  static auto fn = (Fn)(void*)GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow");
  const UINT d = fn && hwnd ? fn(hwnd) : 96;
  return d ? d : 96;
}

struct Screen {
  std::string uuid;  // the monitor's device path
  std::string name;
  int w = 0, h = 0;
  double hz = 0;
  bool main = false;
  RECT rect{};        // virtual-screen pixels
  std::wstring gdi;   // \\.\DISPLAYn — for matching HMONITORs
};

struct Want {
  std::string placementId, slotId, name, screenUuid;
  bool window = false;  // a rehearsal window
  bool spout = false;   // a Spout sender (no window at all)
  int w = 0, h = 0;     // Spout: the frame size
  json windowFrame;
};

/// The active displays, one per source (a mirrored pair is one screen).
std::vector<Screen> enumerateScreens() {
  std::vector<Screen> out;
  UINT32 np = 0, nm = 0;
  std::vector<DISPLAYCONFIG_PATH_INFO> paths;
  std::vector<DISPLAYCONFIG_MODE_INFO> modes;
  LONG rc = ERROR_INSUFFICIENT_BUFFER;
  for (int tries = 0; rc == ERROR_INSUFFICIENT_BUFFER && tries < 4; tries++) {
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &np, &nm) != ERROR_SUCCESS) return out;
    paths.resize(np);
    modes.resize(nm);
    rc = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &np, paths.data(), &nm, modes.data(), nullptr);
  }
  if (rc != ERROR_SUCCESS) return out;
  paths.resize(np);

  // GDI name → monitor rect + primary flag.
  struct Mon { RECT rect; bool primary; };
  std::map<std::wstring, Mon> mons;
  EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR m, HDC, LPRECT, LPARAM lp) -> BOOL {
    MONITORINFOEXW mi{};
    mi.cbSize = sizeof(mi);
    if (GetMonitorInfoW(m, &mi)) {
      (*(std::map<std::wstring, Mon>*)lp)[mi.szDevice] =
          Mon{mi.rcMonitor, (mi.dwFlags & MONITORINFOF_PRIMARY) != 0};
    }
    return TRUE;
  }, (LPARAM)&mons);

  std::set<std::wstring> seen;
  int unnamed = 0;
  for (const auto& p : paths) {
    DISPLAYCONFIG_SOURCE_DEVICE_NAME src{};
    src.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
    src.header.size = sizeof(src);
    src.header.adapterId = p.sourceInfo.adapterId;
    src.header.id = p.sourceInfo.id;
    if (DisplayConfigGetDeviceInfo(&src.header) != ERROR_SUCCESS) continue;
    const std::wstring gdi = src.viewGdiDeviceName;
    if (!seen.insert(gdi).second) continue;  // a clone of a screen already listed
    const auto mon = mons.find(gdi);
    if (mon == mons.end()) continue;

    DISPLAYCONFIG_TARGET_DEVICE_NAME tgt{};
    tgt.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
    tgt.header.size = sizeof(tgt);
    tgt.header.adapterId = p.targetInfo.adapterId;
    tgt.header.id = p.targetInfo.id;
    const bool haveTarget = DisplayConfigGetDeviceInfo(&tgt.header) == ERROR_SUCCESS;

    Screen s;
    s.gdi = gdi;
    s.rect = mon->second.rect;
    s.main = mon->second.primary;
    s.w = s.rect.right - s.rect.left;
    s.h = s.rect.bottom - s.rect.top;
    s.uuid = haveTarget ? utf8(tgt.monitorDevicePath) : std::string();
    if (s.uuid.empty()) s.uuid = utf8(gdi.c_str());  // a virtual display with no EDID
    // An internal panel's EDID name is a part number ("TL070FVXS01-0"): call
    // it what it is, as macOS does.
    const auto tech = p.targetInfo.outputTechnology;
    const bool internal = tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL ||
                          tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED ||
                          tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_UDI_EMBEDDED ||
                          tech == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_LVDS;
    s.name = internal ? "Built-in Display"
                      : haveTarget ? utf8(tgt.monitorFriendlyDeviceName) : std::string();
    if (s.name.empty()) s.name = "Display " + std::to_string(++unnamed);
    const auto& r = p.targetInfo.refreshRate;
    s.hz = r.Denominator ? (double)r.Numerator / (double)r.Denominator : 0;
    out.push_back(std::move(s));
  }
  return out;
}

class WinDisplayWindows final : public DisplayWindows {
 public:
  explicit WinDisplayWindows(double maxHz) : maxHz_(maxHz) {
    becomeDpiAware();
    const HINSTANCE inst = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.hInstance = inst;
    wc.hCursor = LoadCursorW(nullptr, (LPCWSTR)IDC_ARROW);
    wc.lpfnWndProc = &WinDisplayWindows::controlProc;
    wc.lpszClassName = kControlClass;
    RegisterClassExW(&wc);
    wc.lpfnWndProc = &WinDisplayWindows::outputProc;
    wc.lpszClassName = kOutputClass;
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    RegisterClassExW(&wc);
    wc.lpfnWndProc = &WinDisplayWindows::identifyProc;
    wc.lpszClassName = kIdentifyClass;
    RegisterClassExW(&wc);
    // Hidden, never shown; top-level so it hears WM_DISPLAYCHANGE.
    control_ = CreateWindowExW(WS_EX_TOOLWINDOW, kControlClass, L"Nano Modules", WS_POPUP, 0, 0,
                               0, 0, nullptr, nullptr, inst, this);

    provider_.ctx = this;
    provider_.screens_json = [](void* c) { return self(c)->screensJson(); };
    provider_.screens_version = [](void* c) { return self(c)->screensVersion(); };
    provider_.reconcile = [](void* c, const char* w) { self(c)->reconcile(w); };
    provider_.surface_for = [](void* c, const char* pid, int32_t* w, int32_t* h, int32_t* kind) {
      return self(c)->surfaceFor(pid, w, h, kind);
    };
    provider_.publish = [](void* c, const char* pid) { self(c)->spout_.publish(pid ? pid : ""); };
    provider_.identify = [](void* c, const char* label, const char* uuid, int32_t window) {
      self(c)->identify(label ? label : "", uuid ? uuid : "", window != 0);
    };
    provider_.take_events = [](void* c) { return self(c)->takeEvents(); };
    refreshScreens();
    vsyncThread_ = std::thread([this] { vsyncLoop(); });
  }

  ~WinDisplayWindows() override {
    {
      std::lock_guard<std::mutex> lk(vmu_);
      vstop_ = true;
      linkActive_ = false;
      vcv_.notify_all();
    }
    if (vsyncThread_.joinable()) vsyncThread_.join();
    if (pacingOutput_) pacingOutput_->Release();
    if (hotKey_) UnregisterHotKey(control_, kHotKeyDisable);
    for (auto& [pid, o] : outs_) DestroyWindow(o.hwnd);
    for (auto& r : retired_) DestroyWindow(r.hwnd);
    for (auto& [hwnd, at] : identifyWindows_) DestroyWindow(hwnd);
    if (control_) DestroyWindow(control_);
  }

  const NanoDisplayProvider* provider() override { return &provider_; }

  void pumpMainThread(double sec) override {
    MsgWaitForMultipleObjectsEx(0, nullptr, (DWORD)std::max(0.0, sec * 1000.0), QS_ALLINPUT,
                                MWMO_INPUTAVAILABLE);
    MSG m;
    while (PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&m);
      DispatchMessageW(&m);
    }
    const double now = nowSec();
    for (auto it = retired_.begin(); it != retired_.end();) {
      if (now - it->at > kRetireSec) {
        DestroyWindow(it->hwnd);
        it = retired_.erase(it);
      } else {
        ++it;
      }
    }
    for (auto it = identifyWindows_.begin(); it != identifyWindows_.end();) {
      if (now - it->second > kIdentifySec) {
        DestroyWindow(it->first);
        it = identifyWindows_.erase(it);
      } else {
        ++it;
      }
    }
  }

  bool waitVsync(double timeoutSec, double* dt) override {
    std::unique_lock<std::mutex> lk(vmu_);
    if (!linkActive_) return false;
    const uint64_t seen = vsyncSeen_;
    const bool ticked = vcv_.wait_for(lk, std::chrono::duration<double>(timeoutSec),
                                      [&] { return vsyncSeq_ != seen || !linkActive_; });
    if (!ticked || !linkActive_) return false;
    vsyncSeen_ = vsyncSeq_;
    if (dt) *dt = vsyncDt_;
    return true;
  }

 private:
  struct Out {
    Want want;
    HWND hwnd = nullptr;
  };
  struct Surface {
    void* native = nullptr;  // an HWND (kind 0) or a Spout share HANDLE (kind 1)
    int kind = 0;
    int w = 0, h = 0;
  };
  struct Retired {
    HWND hwnd = nullptr;
    double at = 0;
  };
  struct IdentifyReq {
    std::string label, uuid;
    bool window = false;
  };
  struct IdentifyPaint {
    std::wstring label, sub;
  };

  static WinDisplayWindows* self(void* c) { return static_cast<WinDisplayWindows*>(c); }

  // ── Render-thread side: snapshots under mu_ ──

  char* screensJson() {
    std::lock_guard<std::mutex> lk(mu_);
    json arr = json::array();
    for (const auto& s : screens_) {
      arr.push_back({{"uuid", s.uuid}, {"name", s.name}, {"w", s.w}, {"h", s.h},
                     {"hz", s.hz}, {"main", s.main}});
    }
    return dupString(arr.dump());
  }

  uint64_t screensVersion() {
    std::lock_guard<std::mutex> lk(mu_);
    return screensVersion_;
  }

  void reconcile(const char* wantsJson) {
    std::vector<Want> wants;
    auto arr = json::parse(wantsJson ? wantsJson : "[]", nullptr, false);
    if (arr.is_array()) {
      for (const auto& w : arr) {
        Want x;
        x.placementId = w.value("placementId", std::string());
        x.slotId = w.value("slotId", std::string());
        x.name = w.value("name", std::string());
        x.screenUuid = w.value("screenUuid", std::string());
        const std::string mode = w.value("mode", std::string("fullscreen"));
        if (mode == "syphon") continue;  // macOS' share: nothing to do here
        x.window = mode == "window";
        x.spout = mode == "spout";
        x.w = w.value("w", 0);
        x.h = w.value("h", 0);
        if (w.contains("windowFrame") && w["windowFrame"].is_object()) x.windowFrame = w["windowFrame"];
        if (!x.placementId.empty()) wants.push_back(std::move(x));
      }
    }
    {
      std::lock_guard<std::mutex> lk(mu_);
      pendingWants_ = std::move(wants);
    }
    PostMessageW(control_, kMsgApply, 0, 0);
  }

  void* surfaceFor(const char* pid, int32_t* w, int32_t* h, int32_t* kind) {
    std::lock_guard<std::mutex> lk(mu_);
    const auto it = surfaces_.find(pid ? pid : "");
    if (it == surfaces_.end() || !it->second.native) return nullptr;
    if (w) *w = it->second.w;
    if (h) *h = it->second.h;
    if (kind) *kind = it->second.kind;
    return it->second.native;
  }

  void identify(const std::string& label, const std::string& uuid, bool window) {
    {
      std::lock_guard<std::mutex> lk(mu_);
      identifyQueue_.push_back({label, uuid, window});
    }
    PostMessageW(control_, kMsgIdentify, 0, 0);
  }

  char* takeEvents() {
    std::lock_guard<std::mutex> lk(mu_);
    if (events_.empty()) return nullptr;
    const std::string s = events_.dump();
    events_ = json::array();
    return dupString(s);
  }

  void pushEvent(json e) {
    std::lock_guard<std::mutex> lk(mu_);
    // A drag emits a stream of moves: keep only the latest per slot.
    if (e.value("type", std::string()) == "moved") {
      for (auto it = events_.begin(); it != events_.end();) {
        if ((*it).value("type", std::string()) == "moved" &&
            (*it).value("slotId", std::string()) == e.value("slotId", std::string()))
          it = events_.erase(it);
        else
          ++it;
      }
    }
    events_.push_back(std::move(e));
  }

  // ── Main-thread side: the windows ──

  static LRESULT CALLBACK controlProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_NCCREATE) {
      SetWindowLongPtrW(hwnd, GWLP_USERDATA,
                        (LONG_PTR)((CREATESTRUCTW*)lp)->lpCreateParams);
    }
    auto* me = (WinDisplayWindows*)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    if (me) {
      switch (msg) {
        case kMsgApply:
          me->applyWants();
          return 0;
        case kMsgIdentify:
          me->drainIdentify();
          return 0;
        case WM_DISPLAYCHANGE:
          me->rescan();
          // A monitor can finish arriving after the first message: look again.
          SetTimer(hwnd, kTimerRescan, 1000, nullptr);
          return 0;
        case WM_TIMER:
          if (wp == kTimerRescan) {
            KillTimer(hwnd, kTimerRescan);
            me->rescan();
          }
          return 0;
        case WM_HOTKEY:
          if (wp == kHotKeyDisable) me->killOutputs();
          return 0;
        default:
          break;
      }
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
  }

  static LRESULT CALLBACK outputProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_NCCREATE) {
      SetWindowLongPtrW(hwnd, GWLP_USERDATA,
                        (LONG_PTR)((CREATESTRUCTW*)lp)->lpCreateParams);
    }
    auto* me = (WinDisplayWindows*)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    if (me) {
      switch (msg) {
        case WM_CLOSE:
          me->viewerClosed(hwnd);
          return 0;  // hidden instead: the page turns the display off, then it closes
        case WM_MOUSEACTIVATE:
          if (me->isFullscreen(hwnd)) return MA_NOACTIVATE;
          break;
        case WM_ERASEBKGND:
          return 1;  // the swap chain paints it
        case WM_PAINT:
          ValidateRect(hwnd, nullptr);
          return 0;
        case WM_MOVE:
        case WM_SIZE:
          me->geometryChanged(hwnd);
          return 0;
        case WM_DPICHANGED: {
          const RECT* r = (const RECT*)lp;
          if (!me->isFullscreen(hwnd)) {
            SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
                         SWP_NOZORDER | SWP_NOACTIVATE);
          }
          return 0;
        }
        default:
          break;
      }
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
  }

  static LRESULT CALLBACK identifyProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_NCCREATE) {
      SetWindowLongPtrW(hwnd, GWLP_USERDATA,
                        (LONG_PTR)((CREATESTRUCTW*)lp)->lpCreateParams);
    }
    auto* paint = (IdentifyPaint*)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    switch (msg) {
      case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(hwnd, &ps);
        RECT rc;
        GetClientRect(hwnd, &rc);
        FillRect(dc, &rc, (HBRUSH)GetStockObject(BLACK_BRUSH));
        if (paint) {
          const int scale = (int)dpiOf(hwnd);
          SetBkMode(dc, TRANSPARENT);
          auto line = [&](const std::wstring& text, int pt, int top, int bottom, COLORREF c) {
            HFONT f = CreateFontW(-MulDiv(pt, scale, 96), 0, 0, 0, FW_BOLD, 0, 0, 0,
                                  DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
            HGDIOBJ old = SelectObject(dc, f);
            SetTextColor(dc, c);
            RECT r{rc.left + 20, top, rc.right - 20, bottom};
            DrawTextW(dc, text.c_str(), -1, &r,
                      DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
            SelectObject(dc, old);
            DeleteObject(f);
          };
          const int h = rc.bottom - rc.top;
          if (paint->sub.empty()) {
            line(paint->label, 54, 0, h, RGB(255, 255, 255));
          } else {
            line(paint->label, 54, 0, h * 62 / 100, RGB(255, 255, 255));
            line(paint->sub, 22, h * 55 / 100, h * 85 / 100, RGB(180, 180, 180));
          }
        }
        EndPaint(hwnd, &ps);
        return 0;
      }
      case WM_NCDESTROY:
        delete paint;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        break;
      default:
        break;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
  }

  void rescan() {
    refreshScreens();
    applyWants();  // fullscreen windows follow their screen's new rect
  }

  void refreshScreens() {
    std::vector<Screen> next = enumerateScreens();
    std::lock_guard<std::mutex> lk(mu_);
    bool same = next.size() == screens_.size();
    for (size_t i = 0; same && i < next.size(); i++) {
      same = next[i].uuid == screens_[i].uuid && next[i].w == screens_[i].w &&
             next[i].h == screens_[i].h && next[i].main == screens_[i].main &&
             next[i].name == screens_[i].name && EqualRect(&next[i].rect, &screens_[i].rect);
    }
    screens_ = std::move(next);
    if (!same) screensVersion_++;
  }

  bool screenRect(const std::string& uuid, RECT* out) {
    std::lock_guard<std::mutex> lk(mu_);
    for (const auto& s : screens_) {
      if (s.uuid == uuid) {
        *out = s.rect;
        return true;
      }
    }
    return false;
  }

  bool isFullscreen(HWND hwnd) {
    for (const auto& [pid, o] : outs_) {
      if (o.hwnd == hwnd) return !o.want.window;
    }
    return false;
  }

  Out* outFor(HWND hwnd) {
    for (auto& [pid, o] : outs_) {
      if (o.hwnd == hwnd) return &o;
    }
    return nullptr;
  }

  void applyWants() {
    std::vector<Want> wants;
    {
      std::lock_guard<std::mutex> lk(mu_);
      wants = pendingWants_;
    }
    // After Ctrl+Shift+D nothing opens until the page has acknowledged (its
    // master switch off → an empty want list); only then may outputs return.
    if (killed_) {
      if (wants.empty()) killed_ = false;
      else wants.clear();
    }
    std::vector<Want> spoutWants;
    for (auto it = wants.begin(); it != wants.end();) {
      if (it->spout) {
        spoutWants.push_back(std::move(*it));
        it = wants.erase(it);
      } else {
        ++it;
      }
    }
    applySpout(spoutWants);
    std::set<std::string> wanted;
    for (const auto& w : wants) wanted.insert(w.placementId);
    // A window the viewer closed stays down until the page drops it.
    for (auto it = dismissed_.begin(); it != dismissed_.end();) {
      if (!wanted.count(*it)) it = dismissed_.erase(it);
      else ++it;
    }

    // Close what is no longer wanted, or wanted differently.
    for (auto it = outs_.begin(); it != outs_.end();) {
      const Want* w = nullptr;
      for (const auto& x : wants) {
        if (x.placementId == it->first) w = &x;
      }
      const bool keep = w && !dismissed_.count(it->first) && w->window == it->second.want.window &&
                        (w->window || w->screenUuid == it->second.want.screenUuid);
      if (keep) {
        ++it;
        continue;
      }
      closeOut(it->second);
      it = outs_.erase(it);
    }

    for (const auto& w : wants) {
      if (dismissed_.count(w.placementId)) continue;
      auto it = outs_.find(w.placementId);
      if (it == outs_.end()) {
        if (!openOut(w)) continue;
        it = outs_.find(w.placementId);
      }
      Out& o = it->second;
      o.want = w;
      if (w.window) {
        SetWindowTextW(o.hwnd, wide(w.name + " \xE2\x80\x94 Nano Modules").c_str());
      } else {
        RECT r;
        RECT cur;
        GetWindowRect(o.hwnd, &cur);
        if (screenRect(w.screenUuid, &r) && !EqualRect(&r, &cur)) {
          SetWindowPos(o.hwnd, HWND_TOPMOST, r.left, r.top, r.right - r.left, r.bottom - r.top,
                       SWP_NOACTIVATE);
        }
      }
      updateSurface(o);
    }
    rePace();
    syncHotKey();
  }

  /** Every output off NOW, here — no round trip — then the page is told. */
  void killOutputs() {
    killed_ = true;
    for (auto& [pid, o] : outs_) closeOut(o);
    outs_.clear();
    applySpout({});
    rePace();
    syncHotKey();
    pushEvent({{"type", "disableOutput"}});
  }

  void syncHotKey() {
    const bool want = !outs_.empty();
    if (want && !hotKey_) {
      hotKey_ = RegisterHotKey(control_, kHotKeyDisable, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
                               'D') != 0;
    } else if (!want && hotKey_) {
      UnregisterHotKey(control_, kHotKeyDisable);
      hotKey_ = false;
    }
  }

  /** Spout senders for exactly `wants` (each at its frame size). */
  void applySpout(const std::vector<Want>& wants) {
    std::set<std::string> wanted;
    for (const auto& w : wants) wanted.insert(w.placementId);
    for (const auto& pid : spoutKeys_) {
      if (wanted.count(pid)) continue;
      {
        std::lock_guard<std::mutex> lk(mu_);
        surfaces_.erase(pid);
      }
      spout_.close(pid);  // the engine keeps its own reference while it still presents
    }
    spoutKeys_ = wanted;
    for (const auto& w : wants) {
      void* share = spout_.ensure(w.placementId, w.name, w.w, w.h);
      std::lock_guard<std::mutex> lk(mu_);
      if (share) surfaces_[w.placementId] = {share, 1, w.w, w.h};
      else surfaces_.erase(w.placementId);
    }
  }

  /// The rehearsal window's outer rect for a remembered client frame, or a
  /// default in the middle of the main screen — also when the remembered one
  /// is on no screen now (a monitor that's gone).
  RECT windowRectFor(const json& f, DWORD style, DWORD exStyle) {
    RECT client{};
    bool ok = false;
    if (f.is_object()) {
      const int w = (int)f.value("w", 0.0), h = (int)f.value("h", 0.0);
      if (w >= 64 && h >= 64) {
        client = {(LONG)f.value("x", 0.0), (LONG)f.value("y", 0.0), 0, 0};
        client.right = client.left + w;
        client.bottom = client.top + h;
        ok = MonitorFromRect(&client, MONITOR_DEFAULTTONULL) != nullptr;
      }
    }
    if (!ok) {
      HMONITOR m = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
      MONITORINFO mi{};
      mi.cbSize = sizeof(mi);
      GetMonitorInfoW(m, &mi);
      const RECT& wa = mi.rcWork;
      const int w = std::max<int>(320, (wa.right - wa.left) / 2);
      const int h = w * 9 / 16;
      client.left = (wa.left + wa.right - w) / 2;
      client.top = (wa.top + wa.bottom - h) / 2;
      client.right = client.left + w;
      client.bottom = client.top + h;
    }
    RECT outer = client;
    AdjustWindowRectEx(&outer, style, FALSE, exStyle);
    return outer;
  }

  bool openOut(const Want& w) {
    const HINSTANCE inst = GetModuleHandleW(nullptr);
    Out o;
    o.want = w;
    if (w.window) {
      const DWORD style = WS_OVERLAPPEDWINDOW;
      const RECT r = windowRectFor(w.windowFrame, style, 0);
      o.hwnd = CreateWindowExW(0, kOutputClass,
                               wide(w.name + " \xE2\x80\x94 Nano Modules").c_str(), style, r.left,
                               r.top, r.right - r.left, r.bottom - r.top, nullptr, nullptr, inst,
                               this);
      if (!o.hwnd) return false;
      ShowWindow(o.hwnd, SW_SHOWNA);  // up, without taking focus from the editor
    } else {
      RECT r;
      if (!screenRect(w.screenUuid, &r)) return false;
      o.hwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, kOutputClass,
                               wide(w.name).c_str(), WS_POPUP, r.left, r.top, r.right - r.left,
                               r.bottom - r.top, nullptr, nullptr, inst, this);
      if (!o.hwnd) return false;
      ShowWindow(o.hwnd, SW_SHOWNOACTIVATE);
    }
    outs_[w.placementId] = o;
    updateSurface(outs_[w.placementId]);
    return true;
  }

  void closeOut(Out& o) {
    ShowWindow(o.hwnd, SW_HIDE);
    retired_.push_back({o.hwnd, nowSec()});
    std::lock_guard<std::mutex> lk(mu_);
    surfaces_.erase(o.want.placementId);
  }

  /// The engine reads the client size at each present; this is the report's.
  void updateSurface(Out& o) {
    RECT rc{};
    GetClientRect(o.hwnd, &rc);
    std::lock_guard<std::mutex> lk(mu_);
    surfaces_[o.want.placementId] = {(void*)o.hwnd, 0, std::max<int>(1, rc.right - rc.left),
                                     std::max<int>(1, rc.bottom - rc.top)};
  }

  void viewerClosed(HWND hwnd) {
    std::string pid;
    for (const auto& [k, o] : outs_) {
      if (o.hwnd == hwnd) pid = k;
    }
    if (pid.empty()) return;
    dismissed_.insert(pid);
    closeOut(outs_[pid]);
    outs_.erase(pid);
    rePace();
    syncHotKey();
    pushEvent({{"type", "closed"}, {"placementId", pid}});
  }

  void geometryChanged(HWND hwnd) {
    Out* o = outFor(hwnd);
    if (!o) return;
    updateSurface(*o);
    rePace();  // a window dragged onto another monitor takes its pacing along
    if (!o->want.window || IsIconic(hwnd)) return;
    RECT rc{};
    GetClientRect(hwnd, &rc);
    POINT tl{rc.left, rc.top};
    ClientToScreen(hwnd, &tl);
    pushEvent({{"type", "moved"}, {"slotId", o->want.slotId},
               {"frame", {{"x", tl.x}, {"y", tl.y}, {"w", rc.right - rc.left},
                          {"h", rc.bottom - rc.top}}}});
  }

  // ── Pacing: the first output's monitor's vblank ──

  /// The DXGI output driving `mon`, or null. AddRef'd.
  static IDXGIOutput* outputFor(HMONITOR mon) {
    IDXGIFactory1* f = gpu::makeDxgiFactory();
    if (!f) return nullptr;
    IDXGIOutput* found = nullptr;
    IDXGIAdapter1* a = nullptr;
    for (UINT i = 0; !found && f->EnumAdapters1(i, &a) != DXGI_ERROR_NOT_FOUND; i++) {
      IDXGIOutput* o = nullptr;
      for (UINT j = 0; !found && a->EnumOutputs(j, &o) != DXGI_ERROR_NOT_FOUND; j++) {
        DXGI_OUTPUT_DESC d{};
        if (SUCCEEDED(o->GetDesc(&d)) && d.Monitor == mon) found = o;
        else o->Release();
      }
      a->Release();
    }
    f->Release();
    return found;
  }

  void rePace() {
    HMONITOR mon = outs_.empty() ? nullptr
                                 : MonitorFromWindow(outs_.begin()->second.hwnd,
                                                     MONITOR_DEFAULTTONEAREST);
    if (mon == pacingMonitor_) return;
    pacingMonitor_ = mon;
    IDXGIOutput* next = mon ? outputFor(mon) : nullptr;
    std::lock_guard<std::mutex> lk(vmu_);
    if (pacingOutput_) pacingOutput_->Release();
    pacingOutput_ = next;
    linkActive_ = next != nullptr;
    lastTick_ = 0;
    vcv_.notify_all();
  }

  /// Waits for each vblank of the pacing output and hands the render thread a
  /// tick — at most `maxHz` of them (a 144 Hz monitor still renders at 60).
  void vsyncLoop() {
    std::unique_lock<std::mutex> lk(vmu_);
    for (;;) {
      vcv_.wait(lk, [&] { return vstop_ || pacingOutput_; });
      if (vstop_) break;
      IDXGIOutput* out = pacingOutput_;
      out->AddRef();
      lk.unlock();
      const double before = nowSec();
      const bool ok = SUCCEEDED(out->WaitForVBlank());
      out->Release();
      const double t = nowSec();
      // A monitor asleep (or a failed wait) returns at once: don't spin.
      if (!ok || t - before < 0.001) std::this_thread::sleep_for(std::chrono::milliseconds(ok ? 1 : 16));
      lk.lock();
      if (vstop_) break;
      if (!ok) continue;
      if (lastTick_ > 0 && t - lastTick_ < 0.9 / std::max(1.0, maxHz_)) continue;
      vsyncDt_ = lastTick_ > 0 ? std::clamp(t - lastTick_, 0.0, 0.25) : 1.0 / std::max(1.0, maxHz_);
      lastTick_ = t;
      vsyncSeq_++;
      vcv_.notify_all();
    }
  }

  // ── Identify ──

  void drainIdentify() {
    std::vector<IdentifyReq> q;
    {
      std::lock_guard<std::mutex> lk(mu_);
      q.swap(identifyQueue_);
    }
    for (const auto& r : q) showIdentify(r);
  }

  void showIdentify(const IdentifyReq& r) {
    RECT area{};
    std::string screenName;
    if (r.window) {
      bool found = false;
      for (const auto& [pid, o] : outs_) {
        if (o.want.window && o.want.name == r.label) {
          GetWindowRect(o.hwnd, &area);
          found = true;
        }
      }
      if (!found) {
        MONITORINFO mi{};
        mi.cbSize = sizeof(mi);
        GetMonitorInfoW(MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY), &mi);
        area = mi.rcMonitor;
      }
    } else {
      if (!screenRect(r.uuid, &area)) return;
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& s : screens_) {
        if (s.uuid == r.uuid) screenName = s.name;
      }
    }
    const HMONITOR mon = MonitorFromRect(&area, MONITOR_DEFAULTTONEAREST);
    UINT dpiX = 96;
    {
      using Fn = HRESULT(WINAPI*)(HMONITOR, int, UINT*, UINT*);
      static auto fn = (Fn)(void*)GetProcAddress(LoadLibraryW(L"shcore.dll"), "GetDpiForMonitor");
      UINT dy = 96;
      if (fn) fn(mon, 0, &dpiX, &dy);
    }
    const int w = MulDiv(720, (int)dpiX, 96), h = MulDiv(280, (int)dpiX, 96);
    const int x = (area.left + area.right - w) / 2, y = (area.top + area.bottom - h) / 2;
    auto* paint = new IdentifyPaint{wide(r.label), wide(screenName)};
    HWND hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        kIdentifyClass, L"", WS_POPUP, x, y, w, h, nullptr, nullptr, GetModuleHandleW(nullptr),
        paint);
    if (!hwnd) {
      delete paint;
      return;
    }
    SetLayeredWindowAttributes(hwnd, 0, 204, LWA_ALPHA);  // 80% black
    const int radius = MulDiv(48, (int)dpiX, 96);
    SetWindowRgn(hwnd, CreateRoundRectRgn(0, 0, w + 1, h + 1, radius, radius), FALSE);
    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    UpdateWindow(hwnd);
    identifyWindows_.push_back({hwnd, nowSec()});
  }

  NanoDisplayProvider provider_{};
  HWND control_ = nullptr;

  // Guarded by mu_: what the render thread reads, and the want it last sent.
  std::mutex mu_;
  std::vector<Screen> screens_;
  uint64_t screensVersion_ = 1;
  std::vector<Want> pendingWants_;
  std::map<std::string, Surface> surfaces_;
  std::vector<IdentifyReq> identifyQueue_;
  json events_ = json::array();

  // Main thread only.
  std::map<std::string, Out> outs_;
  std::set<std::string> dismissed_;
  std::vector<Retired> retired_;
  std::vector<std::pair<HWND, double>> identifyWindows_;
  bool hotKey_ = false;
  bool killed_ = false;  // Ctrl+Shift+D pressed; cleared once the page sends no wants
  SpoutOutputs spout_;
  std::set<std::string> spoutKeys_;  // placements with a Spout sender
  HMONITOR pacingMonitor_ = nullptr;
  double maxHz_ = 60;

  // The pacing output's vblank → the render thread.
  std::thread vsyncThread_;
  std::mutex vmu_;
  std::condition_variable vcv_;
  IDXGIOutput* pacingOutput_ = nullptr;
  bool vstop_ = false;
  bool linkActive_ = false;
  uint64_t vsyncSeq_ = 0;
  uint64_t vsyncSeen_ = 0;
  double vsyncDt_ = 1.0 / 60;
  double lastTick_ = 0;
};

}  // namespace

std::unique_ptr<DisplayWindows> DisplayWindows::create(double maxHz) {
  return std::make_unique<WinDisplayWindows>(maxHz);
}

}  // namespace compositor
