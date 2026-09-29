// display_windows_mac.mm — see display_windows.h. Compiled under ARC.

#include "compositor/display_windows.h"

#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <CoreGraphics/CoreGraphics.h>
#import <QuartzCore/QuartzCore.h>

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
#include <vector>

#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace {

constexpr double kIdentifySec = 3.0;
constexpr double kRetireSec = 2.0;  // a closed window's layer outlives the render thread's use

char* dupString(const std::string& s) {
  char* out = (char*)std::malloc(s.size() + 1);
  std::memcpy(out, s.c_str(), s.size() + 1);
  return out;
}

double nowSec() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

std::string displayUuid(CGDirectDisplayID d) {
  CFUUIDRef u = CGDisplayCreateUUIDFromDisplayID(d);
  if (!u) return std::string();
  CFStringRef s = CFUUIDCreateString(nullptr, u);
  CFRelease(u);
  std::string out = [(__bridge NSString*)s UTF8String];
  CFRelease(s);
  return out;
}

CGDirectDisplayID displayIdOf(NSScreen* s) {
  return (CGDirectDisplayID)[s.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
}

}  // namespace

// ── Views and windows ───────────────────────────────────────────────────────

/// A view backed by a CAMetalLayer: the render thread presents into it.
@interface NanoOutputView : NSView
@end

@implementation NanoOutputView
- (instancetype)initWithFrame:(NSRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.wantsLayer = YES;
    self.layerContentsRedrawPolicy = NSViewLayerContentsRedrawNever;
  }
  return self;
}
- (CALayer*)makeBackingLayer {
  CAMetalLayer* layer = [CAMetalLayer layer];
  layer.opaque = YES;
  layer.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
  return layer;
}
@end

/// Fullscreen outputs never take focus from the editor.
@interface NanoFullscreenWindow : NSWindow
@end

@implementation NanoFullscreenWindow
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface NanoOutputDelegate : NSObject <NSWindowDelegate>
@property(nonatomic, copy) void (^onClose)(void);
@property(nonatomic, copy) void (^onGeometry)(BOOL moved);
@end

@implementation NanoOutputDelegate
- (BOOL)windowShouldClose:(NSWindow*)sender {
  if (self.onClose) self.onClose();
  return NO;  // hidden instead: the page turns the display off, then it closes
}
- (void)windowDidMove:(NSNotification*)n { if (self.onGeometry) self.onGeometry(YES); }
- (void)windowDidResize:(NSNotification*)n { if (self.onGeometry) self.onGeometry(YES); }
- (void)windowDidChangeBackingProperties:(NSNotification*)n {
  if (self.onGeometry) self.onGeometry(NO);
}
- (void)windowDidChangeScreen:(NSNotification*)n { if (self.onGeometry) self.onGeometry(NO); }
@end

/// Receives the pacing display link's ticks (main run loop).
@interface NanoLinkTarget : NSObject
@property(nonatomic, copy) void (^onTick)(CADisplayLink* link);
- (void)tick:(CADisplayLink*)link;
@end

@implementation NanoLinkTarget
- (void)tick:(CADisplayLink*)link { if (self.onTick) self.onTick(link); }
@end

// ── The provider ────────────────────────────────────────────────────────────

namespace compositor {
namespace {

struct Screen {
  std::string uuid;
  std::string name;
  int w = 0, h = 0;
  double hz = 0;
  bool main = false;
};

struct Want {
  std::string placementId, slotId, name, screenUuid;
  bool window = false;
  json windowFrame;
};

class MacDisplayWindows final : public DisplayWindows {
 public:
  explicit MacDisplayWindows(double maxHz) : maxHz_(maxHz) {
    provider_.ctx = this;
    provider_.screens_json = [](void* c) { return self(c)->screensJson(); };
    provider_.screens_version = [](void* c) { return self(c)->screensVersion(); };
    provider_.reconcile = [](void* c, const char* w) { self(c)->reconcile(w); };
    provider_.surface_for = [](void* c, const char* pid, int32_t* w, int32_t* h) {
      return self(c)->surfaceFor(pid, w, h);
    };
    provider_.identify = [](void* c, const char* label, const char* uuid, int32_t window) {
      self(c)->identify(label ? label : "", uuid ? uuid : "", window != 0);
    };
    provider_.take_events = [](void* c) { return self(c)->takeEvents(); };
    refreshScreens();
    CGDisplayRegisterReconfigurationCallback(&MacDisplayWindows::onReconfigure, this);
  }

  ~MacDisplayWindows() override {
    CGDisplayRemoveReconfigurationCallback(&MacDisplayWindows::onReconfigure, this);
    if (hotKey_) UnregisterEventHotKey(hotKey_);
    if (quitKey_) UnregisterEventHotKey(quitKey_);
    if (hotKeyHandler_) RemoveEventHandler(hotKeyHandler_);
    if (keyMonitor_) [NSEvent removeMonitor:keyMonitor_];
    [link_ invalidate];
    for (auto& [pid, o] : outs_) [o.win orderOut:nil];
  }

  const NanoDisplayProvider* provider() override { return &provider_; }

  void pumpMainThread(double sec) override {
    @autoreleasepool {
      if (appStarted_) {
        NSDate* until = [NSDate dateWithTimeIntervalSinceNow:sec];
        while (NSEvent* e = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:until
                                                   inMode:NSDefaultRunLoopMode dequeue:YES]) {
          [NSApp sendEvent:e];
          until = [NSDate distantPast];  // drain what's queued, then return
        }
      } else {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, sec, true);
      }
      const double now = nowSec();
      std::lock_guard<std::mutex> lk(mu_);
      retired_.erase(std::remove_if(retired_.begin(), retired_.end(),
                                    [&](const Retired& r) { return now - r.at > kRetireSec; }),
                     retired_.end());
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
    NSWindow* win = nil;
    NanoOutputView* view = nil;
    NanoOutputDelegate* delegate = nil;
  };
  struct Surface {
    CAMetalLayer* layer = nil;
    int w = 0, h = 0;
  };
  struct Retired {
    CAMetalLayer* layer = nil;
    double at = 0;
  };

  static MacDisplayWindows* self(void* c) { return static_cast<MacDisplayWindows*>(c); }

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
        x.window = w.value("window", false);
        if (w.contains("windowFrame") && w["windowFrame"].is_object()) x.windowFrame = w["windowFrame"];
        if (!x.placementId.empty()) wants.push_back(std::move(x));
      }
    }
    {
      std::lock_guard<std::mutex> lk(mu_);
      pendingWants_ = std::move(wants);
    }
    dispatch_async(dispatch_get_main_queue(), ^{ this->applyWants(); });
  }

  void* surfaceFor(const char* pid, int32_t* w, int32_t* h) {
    std::lock_guard<std::mutex> lk(mu_);
    const auto it = surfaces_.find(pid ? pid : "");
    if (it == surfaces_.end() || !it->second.layer) return nullptr;
    if (w) *w = it->second.w;
    if (h) *h = it->second.h;
    return (__bridge void*)it->second.layer;
  }

  void identify(const std::string& label, const std::string& uuid, bool window) {
    dispatch_async(dispatch_get_main_queue(), ^{ this->showIdentify(label, uuid, window); });
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
        if ((*it).value("type", std::string()) == "moved" && (*it).value("slotId", std::string()) == e.value("slotId", std::string()))
          it = events_.erase(it);
        else
          ++it;
      }
    }
    events_.push_back(std::move(e));
  }

  // ── Main-thread side: the windows ──

  static void onReconfigure(CGDirectDisplayID, CGDisplayChangeSummaryFlags flags, void* ctx) {
    if (flags & kCGDisplayBeginConfigurationFlag) return;
    MacDisplayWindows* me = self(ctx);
    dispatch_async(dispatch_get_main_queue(), ^{
      me->refreshScreens();
      me->applyWants();  // fullscreen windows follow their screen's new frame
    });
  }

  void refreshScreens() {
    std::vector<Screen> next;
    std::map<std::string, NSScreen*> byUuid;
    for (NSScreen* s in [NSScreen screens]) {
      const CGDirectDisplayID d = displayIdOf(s);
      Screen x;
      x.uuid = displayUuid(d);
      if (x.uuid.empty()) continue;
      x.name = s.localizedName ? [s.localizedName UTF8String] : "Screen";
      if (CGDisplayModeRef m = CGDisplayCopyDisplayMode(d)) {
        x.w = (int)CGDisplayModeGetPixelWidth(m);
        x.h = (int)CGDisplayModeGetPixelHeight(m);
        x.hz = CGDisplayModeGetRefreshRate(m);
        CGDisplayModeRelease(m);
      }
      if (x.hz <= 0) x.hz = (double)s.maximumFramesPerSecond;
      x.main = CGDisplayIsMain(d);
      byUuid[x.uuid] = s;
      next.push_back(std::move(x));
    }
    nsScreens_ = std::move(byUuid);
    std::lock_guard<std::mutex> lk(mu_);
    bool same = next.size() == screens_.size();
    for (size_t i = 0; same && i < next.size(); i++) {
      same = next[i].uuid == screens_[i].uuid && next[i].w == screens_[i].w &&
             next[i].h == screens_[i].h && next[i].main == screens_[i].main &&
             next[i].name == screens_[i].name;
    }
    screens_ = std::move(next);
    if (!same) screensVersion_++;
  }

  void ensureApp() {
    if (appStarted_) return;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    appStarted_ = true;
    // ⌘Q with one of our windows in front (a rehearsal window has focus): this
    // process has no menu, so the chord would do nothing. Outputs off at once,
    // then ask the parent app to quit (a line on stdout — compositor.cjs).
    MacDisplayWindows* me = this;
    keyMonitor_ = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                        handler:^NSEvent*(NSEvent* e) {
      const NSEventModifierFlags mods =
          e.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
      if ((mods & ~NSEventModifierFlagCapsLock) == NSEventModifierFlagCommand &&
          [e.charactersIgnoringModifiers.lowercaseString isEqualToString:@"q"]) {
        me->quitRequested();
        return nil;
      }
      return e;
    }];
  }

  void quitRequested() {
    killOutputs();
    std::printf("nano_compositor quit\n");
    std::fflush(stdout);
  }

  static NSRect frameFromJson(const json& f, NSRect fallback) {
    if (!f.is_object()) return fallback;
    const double w = f.value("w", 0.0), h = f.value("h", 0.0);
    if (w < 64 || h < 64) return fallback;
    return NSMakeRect(f.value("x", 0.0), f.value("y", 0.0), w, h);
  }

  void applyWants() {
    std::vector<Want> wants;
    {
      std::lock_guard<std::mutex> lk(mu_);
      wants = pendingWants_;
    }
    // After ⌘⇧D nothing opens until the page has acknowledged (its master
    // switch off → an empty want list); only then may outputs come back.
    if (killed_) {
      if (wants.empty()) killed_ = false;
      else wants.clear();
    }
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
        o.win.title = [NSString stringWithFormat:@"%s — Nano Modules", w.name.c_str()];
      } else if (auto s = nsScreens_.find(w.screenUuid); s != nsScreens_.end()) {
        if (!NSEqualRects(o.win.frame, s->second.frame)) [o.win setFrame:s->second.frame display:NO];
      }
      updateSurface(o);
    }
    rePace();
    syncHotKey();
  }

  /**
   * System hotkeys (Carbon — they work whichever app is in front, and need no
   * permission), held only while they're needed so they steal from nothing
   * otherwise:
   *   - ⌘⇧D ("Disable Output", as in Resolume) while ANY output window is up;
   *   - ⌘Q while a fullscreen output covers the MAIN screen (the editor's):
   *     clicks pass through a fullscreen output, so whatever is under it can
   *     end up in front and would swallow ⌘Q. A projector on another screen
   *     leaves ⌘Q to every other app — quitting something else mid-show must
   *     never kill the show.
   */
  void syncHotKey() {
    bool coversMain = false;
    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& [pid, o] : outs_) {
        if (o.want.window) continue;
        for (const auto& sc : screens_) coversMain |= sc.main && sc.uuid == o.want.screenUuid;
      }
    }
    if ((!outs_.empty() || coversMain) && !hotKeyHandler_) {
      const EventTypeSpec spec{kEventClassKeyboard, kEventHotKeyPressed};
      InstallApplicationEventHandler(&MacDisplayWindows::onHotKey, 1, &spec, this, &hotKeyHandler_);
    }
    holdHotKey(hotKey_, !outs_.empty(), kVK_ANSI_D, cmdKey | shiftKey, kHotKeyDisable);
    holdHotKey(quitKey_, coversMain, kVK_ANSI_Q, cmdKey, kHotKeyQuit);
  }

  static void holdHotKey(EventHotKeyRef& ref, bool want, UInt32 key, UInt32 mods, UInt32 id) {
    if (want && !ref) {
      const EventHotKeyID hid{'nano', id};
      if (RegisterEventHotKey(key, mods, hid, GetApplicationEventTarget(), 0, &ref) != noErr) ref = nullptr;
    } else if (!want && ref) {
      UnregisterEventHotKey(ref);
      ref = nullptr;
    }
  }

  static OSStatus onHotKey(EventHandlerCallRef, EventRef event, void* ctx) {
    EventHotKeyID hid{};
    GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, nullptr, sizeof(hid),
                      nullptr, &hid);
    if (hid.id == kHotKeyQuit) self(ctx)->quitRequested();
    else self(ctx)->killOutputs();
    return noErr;
  }

  /** Every output off NOW, here — no round trip — then the page is told. */
  void killOutputs() {
    killed_ = true;
    for (auto& [pid, o] : outs_) closeOut(o);
    outs_.clear();
    rePace();
    syncHotKey();
    pushEvent({{"type", "disableOutput"}});
  }

  bool openOut(const Want& w) {
    NSScreen* screen = nil;
    if (!w.window) {
      const auto s = nsScreens_.find(w.screenUuid);
      if (s == nsScreens_.end()) return false;
      screen = s->second;
    }
    ensureApp();
    Out o;
    o.want = w;
    NSRect frame;
    if (w.window) {
      NSScreen* main = [NSScreen mainScreen] ?: [NSScreen screens].firstObject;
      const NSRect vf = main.visibleFrame;
      const NSRect def = NSMakeRect(NSMidX(vf) - 480, NSMidY(vf) - 270, 960, 540);
      const NSRect content = frameFromJson(w.windowFrame, def);
      o.win = [[NSWindow alloc] initWithContentRect:content
                                          styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                    NSWindowStyleMaskResizable |
                                                    NSWindowStyleMaskMiniaturizable
                                            backing:NSBackingStoreBuffered
                                              defer:NO];
      o.win.title = [NSString stringWithFormat:@"%s — Nano Modules", w.name.c_str()];
      o.win.releasedWhenClosed = NO;
      // Never constrain the aspect here: a {0,0} contentAspectRatio makes
      // AppKit's live resize divide 0/0 and trap (SIGTRAP mid-drag).
      o.win.contentMinSize = NSMakeSize(160, 90);
      frame = content;
    } else {
      frame = screen.frame;
      o.win = [[NanoFullscreenWindow alloc] initWithContentRect:frame
                                                      styleMask:NSWindowStyleMaskBorderless
                                                        backing:NSBackingStoreBuffered
                                                          defer:NO];
      o.win.level = NSStatusWindowLevel;  // over the menu bar and the Dock
      o.win.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                 NSWindowCollectionBehaviorStationary |
                                 NSWindowCollectionBehaviorIgnoresCycle |
                                 NSWindowCollectionBehaviorFullScreenAuxiliary;
      o.win.ignoresMouseEvents = YES;
      o.win.releasedWhenClosed = NO;
      o.win.hasShadow = NO;
      [o.win setFrame:frame display:NO];
    }
    o.win.backgroundColor = NSColor.blackColor;
    o.win.opaque = YES;
    o.view = [[NanoOutputView alloc] initWithFrame:NSMakeRect(0, 0, frame.size.width, frame.size.height)];
    o.view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    o.win.contentView = o.view;

    o.delegate = [NanoOutputDelegate new];
    const std::string pid = w.placementId;
    MacDisplayWindows* me = this;
    o.delegate.onClose = ^{ me->viewerClosed(pid); };
    o.delegate.onGeometry = ^(BOOL moved) { me->geometryChanged(pid, moved); };
    o.win.delegate = o.delegate;

    [o.win orderFrontRegardless];
    outs_[w.placementId] = o;
    updateSurface(outs_[w.placementId]);
    return true;
  }

  void closeOut(Out& o) {
    o.win.delegate = nil;
    [o.win orderOut:nil];
    [o.win close];
    std::lock_guard<std::mutex> lk(mu_);
    auto s = surfaces_.find(o.want.placementId);
    if (s != surfaces_.end()) {
      retired_.push_back({s->second.layer, nowSec()});
      surfaces_.erase(s);
    }
  }

  /// The layer's drawable follows its view's size in pixels.
  void updateSurface(Out& o) {
    CAMetalLayer* layer = (CAMetalLayer*)o.view.layer;
    if (![layer isKindOfClass:[CAMetalLayer class]]) return;
    const CGFloat scale = o.win.backingScaleFactor;
    const NSSize pts = o.view.bounds.size;
    const int w = std::max(1, (int)std::lround(pts.width * scale));
    const int h = std::max(1, (int)std::lround(pts.height * scale));
    layer.contentsScale = scale;
    if (layer.drawableSize.width != w || layer.drawableSize.height != h) {
      layer.drawableSize = CGSizeMake(w, h);
    }
    std::lock_guard<std::mutex> lk(mu_);
    surfaces_[o.want.placementId] = {layer, w, h};
  }

  void viewerClosed(const std::string& pid) {
    auto it = outs_.find(pid);
    if (it == outs_.end()) return;
    dismissed_.insert(pid);
    closeOut(it->second);
    outs_.erase(it);
    rePace();
    syncHotKey();
    pushEvent({{"type", "closed"}, {"placementId", pid}});
  }

  void geometryChanged(const std::string& pid, bool moved) {
    auto it = outs_.find(pid);
    if (it == outs_.end()) return;
    updateSurface(it->second);
    if (!moved || !it->second.want.window) return;
    const NSRect c = [it->second.win contentRectForFrameRect:it->second.win.frame];
    pushEvent({{"type", "moved"}, {"slotId", it->second.want.slotId},
               {"frame", {{"x", c.origin.x}, {"y", c.origin.y}, {"w", c.size.width},
                          {"h", c.size.height}}}});
  }

  /// The first output up paces the render loop.
  void rePace() {
    NanoOutputView* master = outs_.empty() ? nil : outs_.begin()->second.view;
    if (master == linkView_) return;
    [link_ invalidate];
    link_ = nil;
    linkView_ = master;
    if (!master) {
      std::lock_guard<std::mutex> lk(vmu_);
      linkActive_ = false;
      vcv_.notify_all();
      return;
    }
    if (!linkTarget_) {
      linkTarget_ = [NanoLinkTarget new];
      MacDisplayWindows* me = this;
      linkTarget_.onTick = ^(CADisplayLink* link) { me->onVsync(link); };
    }
    link_ = [master displayLinkWithTarget:linkTarget_ selector:@selector(tick:)];
    const float hz = (float)std::max(1.0, maxHz_);
    link_.preferredFrameRateRange = CAFrameRateRangeMake(hz / 2, hz, hz);
    [link_ addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
    std::lock_guard<std::mutex> lk(vmu_);
    linkActive_ = true;
    lastTarget_ = 0;
  }

  void onVsync(CADisplayLink* link) {
    std::lock_guard<std::mutex> lk(vmu_);
    const double t = link.targetTimestamp;
    vsyncDt_ = lastTarget_ > 0 ? std::clamp(t - lastTarget_, 0.0, 0.25) : link.duration;
    lastTarget_ = t;
    vsyncSeq_++;
    vcv_.notify_all();
  }

  void showIdentify(const std::string& label, const std::string& uuid, bool window) {
    NSRect area;
    if (window) {
      NSWindow* target = nil;
      for (auto& [pid, o] : outs_) {
        if (o.want.window && o.want.name == label) target = o.win;
      }
      NSScreen* main = [NSScreen mainScreen] ?: [NSScreen screens].firstObject;
      area = target ? target.frame : main.frame;
    } else {
      const auto s = nsScreens_.find(uuid);
      if (s == nsScreens_.end()) return;
      area = s->second.frame;
    }
    ensureApp();
    std::string screenName;
    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& s : screens_) {
        if (s.uuid == uuid) screenName = s.name;
      }
    }
    const NSRect box = NSMakeRect(NSMidX(area) - 360, NSMidY(area) - 140, 720, 280);
    NSWindow* w = [[NSWindow alloc] initWithContentRect:box styleMask:NSWindowStyleMaskBorderless
                                                backing:NSBackingStoreBuffered defer:NO];
    w.level = NSScreenSaverWindowLevel;
    w.opaque = NO;
    w.backgroundColor = NSColor.clearColor;
    w.ignoresMouseEvents = YES;
    w.releasedWhenClosed = NO;
    w.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                           NSWindowCollectionBehaviorIgnoresCycle;
    // Layers only — no drawRect. The scrim drew but an NSTextField's text never
    // did (this process pumps events by hand, and a view's draw pass isn't
    // guaranteed to run); a CATextLayer is drawn by Core Animation at commit.
    NSView* bg = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, box.size.width, box.size.height)];
    bg.wantsLayer = YES;
    bg.layer.backgroundColor = [NSColor colorWithWhite:0 alpha:0.8].CGColor;
    bg.layer.cornerRadius = 24;
    const CGFloat scale = [NSScreen screens].firstObject.backingScaleFactor ?: 2;
    auto line = [&](NSString* str, CGFloat size, CGFloat y, CGFloat h, CGFloat alpha) {
      CATextLayer* t = [CATextLayer layer];
      t.string = str;
      t.font = (__bridge CFTypeRef)[NSFont boldSystemFontOfSize:size];
      t.fontSize = size;
      t.foregroundColor = [NSColor colorWithWhite:1 alpha:alpha].CGColor;
      t.alignmentMode = kCAAlignmentCenter;
      t.truncationMode = kCATruncationEnd;
      t.contentsScale = scale;
      t.frame = CGRectMake(20, y, box.size.width - 40, h);
      [bg.layer addSublayer:t];
    };
    line([NSString stringWithUTF8String:label.c_str()], 72, screenName.empty() ? 96 : 120, 90, 1.0);
    if (!screenName.empty()) {
      line([NSString stringWithUTF8String:screenName.c_str()], 30, 60, 44, 0.7);
    }
    w.contentView = bg;
    [w orderFrontRegardless];
    identifyWindows_.push_back(w);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kIdentifySec * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     [w orderOut:nil];
                     auto& v = this->identifyWindows_;
                     v.erase(std::remove(v.begin(), v.end(), w), v.end());
                   });
  }

  NanoDisplayProvider provider_{};

  // Guarded by mu_: what the render thread reads, and the want it last sent.
  std::mutex mu_;
  std::vector<Screen> screens_;
  uint64_t screensVersion_ = 1;
  std::vector<Want> pendingWants_;
  std::map<std::string, Surface> surfaces_;
  std::vector<Retired> retired_;
  json events_ = json::array();

  // Main thread only.
  bool appStarted_ = false;
  std::map<std::string, NSScreen*> nsScreens_;
  std::map<std::string, Out> outs_;
  std::set<std::string> dismissed_;
  std::vector<NSWindow*> identifyWindows_;
  EventHotKeyRef hotKey_ = nullptr;   // ⌘⇧D
  EventHotKeyRef quitKey_ = nullptr;  // ⌘Q (a fullscreen output over the main screen)
  static constexpr UInt32 kHotKeyDisable = 1;
  static constexpr UInt32 kHotKeyQuit = 2;
  id keyMonitor_ = nil;  // ⌘Q while one of our windows is in front
  EventHandlerRef hotKeyHandler_ = nullptr;
  bool killed_ = false;  // ⌘⇧D pressed; cleared once the page sends no wants
  CADisplayLink* link_ = nil;
  NanoOutputView* linkView_ = nil;
  NanoLinkTarget* linkTarget_ = nil;
  double maxHz_ = 60;

  // The pacing display link → the render thread.
  std::mutex vmu_;
  std::condition_variable vcv_;
  bool linkActive_ = false;
  uint64_t vsyncSeq_ = 0;
  uint64_t vsyncSeen_ = 0;
  double vsyncDt_ = 1.0 / 60;
  double lastTarget_ = 0;
};

}  // namespace

std::unique_ptr<DisplayWindows> DisplayWindows::create(double maxHz) {
  return std::make_unique<MacDisplayWindows>(maxHz);
}

}  // namespace compositor
