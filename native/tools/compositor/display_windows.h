// display_windows.h — the nano_compositor process's DISPLAY windows: where the
// arrangement's display devices land (the runtime's DisplaySurfaces, reached
// through bridge_api.h's NanoDisplayProvider).
//
//   - Fullscreen: a borderless window over its screen's whole frame (menu bar
//     included), never key, never in the window cycle.
//   - Window mode (rehearsal): a normal titled, resizable window. Closing it
//     turns the display off (a `closed` event); moving it is remembered (a
//     `moved` event).
//   - Identify: a big label over the screen for a few seconds.
//   - ⌘⇧D ("Disable Output", as in Resolume): while any output is up, a system
//     hotkey closes them all at once and reports `disableOutput`; nothing
//     reopens until the page has switched its master output off.
//   - ⌘Q with one of these windows in front — or, as a system hotkey, while a
//     fullscreen output covers the MAIN screen (the editor's): outputs off at
//     once, then the parent app is asked to quit ("nano_compositor quit").
//
// THREADS. The provider's callbacks run on the RENDER thread and never wait on
// the main thread: they read a mutex-guarded snapshot and queue work. The main
// thread (pumpMainThread) owns every window. It stays HEADLESS — no
// NSApplication, no Dock icon — until the first window is wanted, then starts
// an Accessory app (no Dock icon, no menu bar).
//
// PACING. While any output is up, the first one's display link paces the
// render loop (waitVsync); otherwise the caller keeps its own clock.
//
// macOS only; create() returns null elsewhere.

#pragma once

#include <memory>

#include "bridge/bridge_api.h"

namespace compositor {

class DisplayWindows {
 public:
  /// `maxHz`: the render loop's own rate — a display link is asked for no
  /// more than this (a 120 Hz laptop screen rehearsing still renders at 60).
  static std::unique_ptr<DisplayWindows> create(double maxHz);
  virtual ~DisplayWindows() = default;

  /// For bridge_comp_set_display_provider. Valid for this object's lifetime.
  virtual const NanoDisplayProvider* provider() = 0;
  /// Main thread only: run the run loop (and, once windows exist, AppKit's
  /// event loop) for up to `sec`.
  virtual void pumpMainThread(double sec) = 0;
  /// Render thread: block until the pacing display's next vsync, up to
  /// `timeoutSec`. True with `*dt` = the time between its last two frames;
  /// false at once when nothing is up (or on a timeout: a sleeping screen).
  virtual bool waitVsync(double timeoutSec, double* dt) = 0;
};

}  // namespace compositor
