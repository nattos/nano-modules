// diag_gl.cpp — a hidden-window OpenGL context, because on this side of the
// seam nano_diag has to be the host.
//
// Resolume creates the GL context and the FFGL plugin inherits it. Nothing in
// the tree has ever had to make one on Windows, so this is the first code that
// does. It deliberately asks for as little as possible: a plain
// wglCreateContext, which every driver answers with its highest COMPATIBILITY
// profile -- the same shape of context an FFGL host hands out. Asking for a
// core 3.3 context here would test a configuration Resolume never produces.

#include <windows.h>
#include <GL/glew.h>
#include <GL/wglew.h>

#include "diag.h"

#include <cstdio>

namespace diag {

namespace {
constexpr const char* kClassName = "NanoDiagGLWindow";
}

GLContext::GLContext() {
  WNDCLASSA wc = {};
  wc.style = CS_OWNDC;   // the DC must outlive each BeginPaint; GL demands it
  wc.lpfnWndProc = DefWindowProcA;
  wc.hInstance = GetModuleHandleA(nullptr);
  wc.lpszClassName = kClassName;
  // A duplicate registration is fine -- one process, possibly two contexts.
  RegisterClassA(&wc);

  HWND hwnd = CreateWindowExA(0, kClassName, "nano_diag", WS_OVERLAPPEDWINDOW,
                              CW_USEDEFAULT, CW_USEDEFAULT, 64, 64,
                              nullptr, nullptr, wc.hInstance, nullptr);
  if (!hwnd) { error_ = "CreateWindowEx failed"; return; }
  hwnd_ = hwnd;
  // Never shown: ShowWindow is not called. A hidden window still owns a real
  // pixel format and a real driver context.

  HDC hdc = GetDC(hwnd);
  if (!hdc) { error_ = "GetDC failed"; return; }
  hdc_ = hdc;

  PIXELFORMATDESCRIPTOR pfd = {};
  pfd.nSize = sizeof(pfd);
  pfd.nVersion = 1;
  pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
  pfd.iPixelType = PFD_TYPE_RGBA;
  pfd.cColorBits = 32;
  pfd.cAlphaBits = 8;
  pfd.cDepthBits = 24;
  pfd.cStencilBits = 8;
  pfd.iLayerType = PFD_MAIN_PLANE;

  const int pf = ChoosePixelFormat(hdc, &pfd);
  if (pf == 0) { error_ = "ChoosePixelFormat found no RGBA8 format"; return; }
  if (!SetPixelFormat(hdc, pf, &pfd)) { error_ = "SetPixelFormat failed"; return; }

  HGLRC rc = wglCreateContext(hdc);
  if (!rc) {
    char buf[128];
    snprintf(buf, sizeof(buf), "wglCreateContext failed (GetLastError=%lu)",
             (unsigned long)GetLastError());
    error_ = buf;
    return;
  }
  hglrc_ = rc;
  if (!wglMakeCurrent(hdc, rc)) { error_ = "wglMakeCurrent failed"; return; }

  glewExperimental = GL_TRUE;
  const GLenum ge = glewInit();
  if (ge != GLEW_OK) {
    error_ = std::string("glewInit failed: ") +
             (const char*)glewGetErrorString(ge);
    return;
  }
  // GLEW's first extension query leaves GL_INVALID_ENUM behind on a core
  // profile. Harmless, and it would otherwise be the first thing a probe
  // reports.
  while (glGetError() != GL_NO_ERROR) { }
  glew_ready_ = true;
  ok_ = true;
}

GLContext::~GLContext() {
  if (hglrc_) {
    wglMakeCurrent(nullptr, nullptr);
    wglDeleteContext((HGLRC)hglrc_);
  }
  if (hdc_ && hwnd_) ReleaseDC((HWND)hwnd_, (HDC)hdc_);
  if (hwnd_) DestroyWindow((HWND)hwnd_);
}

bool glErrorsClear(const char* where) {
  bool clean = true;
  for (GLenum e = glGetError(); e != GL_NO_ERROR; e = glGetError()) {
    clean = false;
    logf("      GL error 0x%04x after %s\n", (unsigned)e, where);
  }
  return clean;
}

}  // namespace diag
