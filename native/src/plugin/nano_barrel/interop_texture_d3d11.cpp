// interop_texture_d3d11.cpp — the Windows InteropTexture: one D3D11 texture
// registered with the GL driver through WGL_NV_DX_interop2, so the engine
// renders into it as an ID3D11Texture2D and the host blits it as a GL texture.
//
// THIS IS THE ONE PART OF THE WINDOWS PORT THAT CANNOT BE TESTED HERE.
// CrossOver's OpenGL and its D3D11 are two separate translation layers over
// Metal (wined3d -> SPIR-V -> MoltenVK), with no shared-resource path between
// them, so wglDXOpenDeviceNV is not going to succeed under wine whatever we
// write. Everything on either side of it is covered:
// tests/test_barrel_render.cpp drives the full engine ABI with a texture made
// exactly the way this one is made, and the GL blits around it are the same
// code paths macOS runs. What is unproven is the share itself.
//
// Consequences for whoever runs this on real hardware first:
//   * Every entry point below is resolved through GLEW, which means glewInit()
//     must have run — the FFGL SDK does that in its own InitGL, before ours.
//   * If WGL_NV_DX_interop2 is absent (it is not, on any NVIDIA/AMD/Intel
//     driver of the last decade, but a remote desktop or a software rasterizer
//     may not offer it), valid() is false and the barrel presents its input
//     rather than drawing garbage.
//   * The lock/unlock discipline is not advisory. GL may only touch the
//     texture while it is locked, D3D only while it is not. Getting that
//     backwards does not fail loudly — it reads stale or torn pixels.

#include <windows.h>
// wglew.h is separate from glew.h and is where the WGL_NV_DX_interop2 entry
// points live. It needs windows.h's HANDLE/HDC, hence the order.
#include <GL/glew.h>
#include <GL/wglew.h>

#include "interop_texture.h"
#include "interop_texture_desc_d3d11.h"

#include <d3d11.h>

#include <cstdio>
#include <map>
#include <mutex>

namespace {

// wglDXOpenDeviceNV is per (GL context, D3D device), not per texture. The
// barrel has one of each and two textures that are rebuilt on every viewport
// resize, so opening it per texture would leak a device handle per resize.
// Keyed by D3D device; the GL context is whatever was current when the first
// texture for that device was built, which for the barrel is the host's.
HANDLE shareDeviceFor(ID3D11Device* device) {
  static std::mutex mu;
  static std::map<ID3D11Device*, HANDLE> byDevice;
  std::lock_guard<std::mutex> lk(mu);
  auto it = byDevice.find(device);
  if (it != byDevice.end()) return it->second;

  if (!WGLEW_NV_DX_interop2) {
    std::fprintf(stderr, "[interop] WGL_NV_DX_interop2 not supported by this "
                         "GL driver — the barrel cannot share textures\n");
    byDevice[device] = nullptr;
    return nullptr;
  }
  HANDLE h = wglDXOpenDeviceNV(device);
  if (!h) std::fprintf(stderr, "[interop] wglDXOpenDeviceNV failed\n");
  byDevice[device] = h;
  return h;
}

class D3D11InteropTexture : public InteropTexture {
 public:
  D3D11InteropTexture(ID3D11Device* device, int width, int height)
      : InteropTexture(width, height), device_(device) {
    if (!device_) return;

    const D3D11_TEXTURE2D_DESC td = nanoInteropTextureDesc(width, height);
    if (FAILED(device_->CreateTexture2D(&td, nullptr, &texture_))) {
      std::fprintf(stderr, "[interop] CreateTexture2D(%dx%d) failed\n", width, height);
      return;
    }

    shareDevice_ = shareDeviceFor(device_);
    if (!shareDevice_) return;

    // Generate the name only — no glTexImage2D. Registration is what gives the
    // GL texture its storage, and a name that already has storage is rejected.
    glGenTextures(1, &glTexture_);
    object_ = wglDXRegisterObjectNV(shareDevice_, texture_, glTexture_,
                                    GL_TEXTURE_2D, WGL_ACCESS_READ_WRITE_NV);
    if (!object_) {
      std::fprintf(stderr, "[interop] wglDXRegisterObjectNV failed\n");
      return;
    }

    // The FBO attachment has to be made while the object is locked: outside a
    // lock the GL texture has no storage and the framebuffer is incomplete.
    lockForGL();
    GLint prevDraw = 0, prevRead = 0;
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
    glGenFramebuffers(1, &fbo_);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo_);
    // GL_TEXTURE_2D, unlike the Apple side's GL_TEXTURE_RECTANGLE — a
    // registered D3D11 texture is a plain 2D texture here.
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                           GL_TEXTURE_2D, glTexture_, 0);
    const GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
    unlockForGL();

    if (status != GL_FRAMEBUFFER_COMPLETE) {
      std::fprintf(stderr, "[interop] shared FBO incomplete (0x%04x)\n",
                   (unsigned)status);
      glDeleteFramebuffers(1, &fbo_);
      fbo_ = 0;
    }
  }

  ~D3D11InteropTexture() override {
    // Unlock before unregistering: an object destroyed while locked leaves the
    // GL driver holding a reference to a D3D resource that is about to go.
    unlockForGL();
    if (object_ && shareDevice_) wglDXUnregisterObjectNV(shareDevice_, object_);
    if (fbo_) glDeleteFramebuffers(1, &fbo_);
    if (glTexture_) glDeleteTextures(1, &glTexture_);
    if (texture_) texture_->Release();
    // shareDevice_ is shared and outlives us deliberately — see shareDeviceFor.
  }

  GLuint getOpenGLFBO() const override { return fbo_; }
  GLuint getOpenGLTexture() const override { return glTexture_; }
  void* getNativeTexture() const override { return texture_; }
  bool valid() const override { return fbo_ != 0 && texture_ != nullptr; }

  void lockForGL() override {
    if (locked_ || !object_ || !shareDevice_) return;
    locked_ = wglDXLockObjectsNV(shareDevice_, 1, &object_) == TRUE;
  }

  void unlockForGL() override {
    if (!locked_ || !object_ || !shareDevice_) return;
    wglDXUnlockObjectsNV(shareDevice_, 1, &object_);
    locked_ = false;
  }

 private:
  ID3D11Device* device_ = nullptr;          // borrowed; the runtime owns it
  ID3D11Texture2D* texture_ = nullptr;
  HANDLE shareDevice_ = nullptr;            // shared, not owned
  HANDLE object_ = nullptr;
  GLuint glTexture_ = 0;
  GLuint fbo_ = 0;
  bool locked_ = false;
};

}  // namespace

std::unique_ptr<InteropTexture> createInteropTexture(void* device, int width,
                                                     int height) {
  return std::make_unique<D3D11InteropTexture>(
      static_cast<ID3D11Device*>(device), width, height);
}
