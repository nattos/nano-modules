#pragma once

// InteropTexture — one texture that both the host's OpenGL pipeline and the
// engine's graphics API can see, with no copy between them.
//
// This is the barrel's entire reason for existing in the shape it has. FFGL
// hands a plugin GL texture handles and expects GL texture handles back, while
// the engine renders in Metal or D3D11. Rather than read pixels out of one API
// and push them into the other twice a frame, both APIs are pointed at the SAME
// storage: an IOSurface-backed CVPixelBuffer on macOS, a D3D11 texture
// registered through WGL_NV_DX_interop2 on Windows.
//
// The two platforms differ in one way that matters to callers. IOSurface
// sharing is implicit — the GL texture and the MTLTexture are simply both
// valid. NV_DX_interop is explicit: the object must be LOCKED before GL touches
// it and UNLOCKED before D3D does, and doing it the other way round is
// undefined rather than merely slow. So every GL access goes between
// lockForGL() and unlockForGL(), which cost nothing on macOS.
//
// Everything on the engine side of this class is covered by
// tests/test_barrel_render.cpp, which drives the same ABI with textures it made
// itself. The share is the part no headless test can reach.

#include <memory>

#ifdef _WIN32
#include <GL/glew.h>
#else
#include <OpenGL/gl3.h>
#endif

class InteropTexture {
 public:
  virtual ~InteropTexture() = default;

  int getWidth() const { return width_; }
  int getHeight() const { return height_; }

  /// An FBO with this texture as COLOR_ATTACHMENT0, for glBlitFramebuffer in
  /// either direction. 0 if the share failed.
  virtual GLuint getOpenGLFBO() const = 0;
  virtual GLuint getOpenGLTexture() const = 0;

  /// The engine-side handle: `id<MTLTexture>` on Metal, `ID3D11Texture2D*` on
  /// D3D11 — whatever GPUBackend::adoptExternalTexture takes.
  virtual void* getNativeTexture() const = 0;

  /// Bracket every GL use of this texture. No-ops where the share is implicit.
  virtual void lockForGL() {}
  virtual void unlockForGL() {}

  /// False if construction failed; the caller should fall back to presenting
  /// the host's input rather than blitting from nothing.
  virtual bool valid() const = 0;

 protected:
  InteropTexture(int width, int height) : width_(width), height_(height) {}
  int width_ = 0;
  int height_ = 0;
};

/// A BGRA8 interop texture on `device` — the runtime's own device, as
/// bridge_rt_gpu_device returns it. Never null; check valid().
std::unique_ptr<InteropTexture> createInteropTexture(void* device, int width,
                                                     int height);
