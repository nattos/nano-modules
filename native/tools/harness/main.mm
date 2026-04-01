#import <Cocoa/Cocoa.h>
#import <OpenGL/gl3.h>

#include <chrono>
#include <fstream>
#include <vector>

#include "bridge/bridge_api.h"
#include "canvas/canvas_renderer.h"
#include "canvas/draw_list.h"
#include "plugin/bridge_loader.h"
#include "plugin/synth.h"

#ifndef BRIDGE_DYLIB_PATH
#error "BRIDGE_DYLIB_PATH must be defined"
#endif

#ifndef NANOLOOPER_WASM_PATH
#error "NANOLOOPER_WASM_PATH must be defined"
#endif

static std::vector<uint8_t> load_file(const char* path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg();
  f.seekg(0);
  std::vector<uint8_t> buf(size);
  f.read(reinterpret_cast<char*>(buf.data()), size);
  return buf;
}

// --- Param IDs (must match looper module) ---

enum ParamID {
  PID_TRIGGER_1 = 0,
  PID_TRIGGER_2, PID_TRIGGER_3, PID_TRIGGER_4,
  PID_DELETE, PID_MUTE, PID_UNDO, PID_REDO,
  PID_RECORD, PID_SHOW_OVERLAY, PID_SYNTH, PID_SYNTH_GAIN,
  PID_COUNT,
};

// --- OpenGL View ---

@interface HarnessGLView : NSOpenGLView {
  plugin::BridgeLoader _loader;
  BridgeHandle _bridge;
  int32_t _wasmModule;
  canvas::CanvasRenderer* _renderer;
  Synth* _synth;

  GLuint _inputTex;
  BOOL _glReady;
  BOOL _synthEnabled;

  std::chrono::steady_clock::time_point _startTime;
  std::chrono::steady_clock::time_point _lastTick;
  double _elapsed;
}
@end

@implementation HarnessGLView

- (instancetype)initWithFrame:(NSRect)frame {
  NSOpenGLPixelFormatAttribute attrs[] = {
    NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
    NSOpenGLPFAColorSize, 24,
    NSOpenGLPFAAlphaSize, 8,
    NSOpenGLPFADoubleBuffer,
    NSOpenGLPFAAccelerated,
    0
  };
  NSOpenGLPixelFormat* pf = [[NSOpenGLPixelFormat alloc] initWithAttributes:attrs];
  self = [super initWithFrame:frame pixelFormat:pf];
  if (self) {
    [self setWantsBestResolutionOpenGLSurface:YES];
    _bridge = nullptr;
    _wasmModule = -1;
    _renderer = nullptr;
    _synth = nullptr;
    _elapsed = 0;
  }
  return self;
}

static void audio_callback(int channel, void* userdata) {
  auto* synth = static_cast<Synth*>(userdata);
  if (synth && synth->is_enabled())
    synth->trigger(channel);
}

- (void)prepareOpenGL {
  [super prepareOpenGL];

  GLint swapInt = 1;
  [[self openGLContext] setValues:&swapInt forParameter:NSOpenGLContextParameterSwapInterval];

  // Create input texture (dark gradient)
  glGenTextures(1, &_inputTex);
  glBindTexture(GL_TEXTURE_2D, _inputTex);
  int tw = 256, th = 256;
  std::vector<uint8_t> pixels(tw * th * 4);
  for (int y = 0; y < th; ++y) {
    for (int x = 0; x < tw; ++x) {
      int i = (y * tw + x) * 4;
      pixels[i + 0] = (uint8_t)(x * 40 / tw);
      pixels[i + 1] = (uint8_t)(20 + y * 30 / th);
      pixels[i + 2] = (uint8_t)(40 + x * 20 / tw);
      pixels[i + 3] = 255;
    }
  }
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, tw, th, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glBindTexture(GL_TEXTURE_2D, 0);

  // Load bridge dylib
  if (!_loader.load(BRIDGE_DYLIB_PATH)) {
    NSLog(@"Failed to load bridge dylib from %s", BRIDGE_DYLIB_PATH);
    return;
  }
  _bridge = _loader.bridge_init();
  if (!_bridge) {
    NSLog(@"bridge_init() failed");
    return;
  }

  // Load WASM module
  auto bytecode = load_file(NANOLOOPER_WASM_PATH);
  if (bytecode.empty()) {
    NSLog(@"Failed to load WASM from %s", NANOLOOPER_WASM_PATH);
    return;
  }
  _wasmModule = _loader.bridge_load_wasm(_bridge, bytecode.data(), (uint32_t)bytecode.size());
  if (_wasmModule < 0) {
    NSLog(@"bridge_load_wasm failed");
    return;
  }
  NSLog(@"WASM module loaded (id=%d, %zu bytes)", _wasmModule, bytecode.size());

  // Init renderer and synth
  _renderer = new canvas::CanvasRenderer();
  _renderer->init();

  _synth = new Synth();
  _synth->init();

  // Set audio callback
  if (_loader.bridge_set_audio_callback) {
    _loader.bridge_set_audio_callback(_bridge, _wasmModule, audio_callback, _synth);
  }

  // Call WASM init
  _loader.bridge_call_wasm(_bridge, _wasmModule, "init");

  _startTime = std::chrono::steady_clock::now();
  _lastTick = _startTime;
  _elapsed = 0;
  _glReady = YES;

  // 60Hz timer
  NSTimer* timer = [NSTimer timerWithTimeInterval:1.0/60.0
                                           target:self
                                         selector:@selector(timerFired:)
                                         userInfo:nil
                                          repeats:YES];
  [[NSRunLoop currentRunLoop] addTimer:timer forMode:NSRunLoopCommonModes];
}

- (void)timerFired:(NSTimer*)timer {
  [self setNeedsDisplay:YES];
}

- (void)drawRect:(NSRect)dirtyRect {
  if (!_glReady || !_bridge || _wasmModule < 0) return;
  [[self openGLContext] makeCurrentContext];

  auto now = std::chrono::steady_clock::now();
  double dt = std::chrono::duration<double>(now - _lastTick).count();
  _lastTick = now;
  _elapsed += dt;

  NSRect backing = [self convertRectToBacking:[self bounds]];
  int vp_w = (int)backing.size.width;
  int vp_h = (int)backing.size.height;

  glViewport(0, 0, vp_w, vp_h);

  // Set frame state
  // Simulate bar phase: 4 beats at current BPM, 4/4 time
  double bpm = 120.0;
  double beats_per_sec = bpm / 60.0;
  double bar_phase = fmod(_elapsed * beats_per_sec / 4.0, 1.0);

  if (_loader.bridge_set_frame_state) {
    _loader.bridge_set_frame_state(_bridge, _wasmModule,
        _elapsed, dt, bar_phase, bpm, vp_w, vp_h);
  }

  // Tick
  _loader.bridge_tick(_bridge);
  if (_loader.bridge_call_tick) {
    _loader.bridge_call_tick(_bridge, _wasmModule, dt);
  }

  // Draw passthrough background
  _renderer->drawPassthrough(_inputTex, 0, 0, vp_w, vp_h);

  // Render WASM overlay
  if (_loader.bridge_render) {
    auto* dl = static_cast<canvas::DrawList*>(
        _loader.bridge_render(_bridge, _wasmModule, vp_w, vp_h));
    if (dl && !dl->empty()) {
      _renderer->execute(*dl, vp_w, vp_h);
    }
  }

  [[self openGLContext] flushBuffer];
}

- (BOOL)acceptsFirstResponder { return YES; }

static int paramForChar(unichar c) {
  switch (c) {
    case '1': return PID_TRIGGER_1;
    case '2': return PID_TRIGGER_2;
    case '3': return PID_TRIGGER_3;
    case '4': return PID_TRIGGER_4;
    case 'd': return PID_DELETE;
    case 'm': return PID_MUTE;
    case 'z': return PID_UNDO;
    case 'x': return PID_REDO;
    case 'r': return PID_RECORD;
    default:  return -1;
  }
}

- (void)keyDown:(NSEvent *)event {
  if ([event isARepeat]) return;

  NSString* chars = [event charactersIgnoringModifiers];
  if ([chars length] == 0) return;
  unichar c = [chars characterAtIndex:0];

  if (c == 'q' || c == 27) {
    [[NSApplication sharedApplication] terminate:nil];
    return;
  }

  if (c == 's') {
    _synthEnabled = !_synthEnabled;
    if (_synth) _synth->set_enabled(_synthEnabled);
    if (_loader.bridge_call_on_param)
      _loader.bridge_call_on_param(_bridge, _wasmModule, PID_SYNTH, _synthEnabled ? 1.0 : 0.0);
    return;
  }

  int pid = paramForChar(c);
  if (pid >= 0) {
    if (_loader.bridge_set_ffgl_param)
      _loader.bridge_set_ffgl_param(_bridge, _wasmModule, pid, 1.0);
    if (_loader.bridge_call_on_param)
      _loader.bridge_call_on_param(_bridge, _wasmModule, pid, 1.0);
  }
}

- (void)keyUp:(NSEvent *)event {
  NSString* chars = [event charactersIgnoringModifiers];
  if ([chars length] == 0) return;
  unichar c = [chars characterAtIndex:0];

  int pid = paramForChar(c);
  if (pid >= 0) {
    if (_loader.bridge_set_ffgl_param)
      _loader.bridge_set_ffgl_param(_bridge, _wasmModule, pid, 0.0);
    if (_loader.bridge_call_on_param)
      _loader.bridge_call_on_param(_bridge, _wasmModule, pid, 0.0);
  }
}

- (void)dealloc {
  if (_bridge && _loader.is_loaded()) {
    if (_wasmModule >= 0)
      _loader.bridge_unload_wasm(_bridge, _wasmModule);
    _loader.bridge_release(_bridge);
  }
  if (_synth) { _synth->deinit(); delete _synth; }
  if (_renderer) { _renderer->deinit(); delete _renderer; }
  if (_inputTex) glDeleteTextures(1, &_inputTex);
}

@end

// --- App Delegate ---

@interface HarnessAppDelegate : NSObject <NSApplicationDelegate>
@property (strong) NSWindow* window;
@end

@implementation HarnessAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  NSRect frame = NSMakeRect(100, 100, 640, 480);
  self.window = [[NSWindow alloc]
    initWithContentRect:frame
    styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable)
    backing:NSBackingStoreBuffered
    defer:NO];
  [self.window setTitle:@"NanoLooper WASM Harness"];
  [self.window setMinSize:NSMakeSize(400, 300)];

  HarnessGLView* glView = [[HarnessGLView alloc] initWithFrame:frame];
  [self.window setContentView:glView];
  [self.window makeFirstResponder:glView];
  [self.window makeKeyAndOrderFront:nil];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  return YES;
}

@end

// --- Main ---

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    NSApplication* app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];

    HarnessAppDelegate* delegate = [[HarnessAppDelegate alloc] init];
    [app setDelegate:delegate];
    [app activateIgnoringOtherApps:YES];
    [app run];
  }
  return 0;
}
