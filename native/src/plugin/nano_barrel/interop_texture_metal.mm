// interop_texture_metal.mm — the Apple InteropTexture: one IOSurface-backed
// CVPixelBuffer, seen as a GL_TEXTURE_RECTANGLE by OpenGL and as an MTLTexture
// by Metal. Derived from Apple's MixedRenderingSample; the lock/unlock pair the
// interface defines is a no-op here because IOSurface sharing is implicit.

#include "interop_texture.h"

#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <AppKit/AppKit.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl.h>
#import <OpenGL/gl3.h>

#include <cstdio>

namespace {

class MetalInteropTexture : public InteropTexture {
 public:
  MetalInteropTexture(id<MTLDevice> device, NSOpenGLContext* glContext,
                      int width, int height)
      : InteropTexture(width, height), device_(device), glContext_(glContext) {
    NSDictionary* props = @{
      (__bridge NSString*)kCVPixelBufferOpenGLCompatibilityKey : @YES,
      (__bridge NSString*)kCVPixelBufferMetalCompatibilityKey : @YES,
      // Load-bearing: without the FBO key the texture cannot be a colour
      // attachment, which is the only way we ever touch it from GL.
      (__bridge NSString*)kCVPixelBufferIOSurfaceOpenGLFBOCompatibilityKey : @YES,
      (__bridge NSString*)kCVPixelBufferIOSurfaceOpenGLTextureCompatibilityKey : @YES,
    };
    CVReturn cvret = CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                                         kCVPixelFormatType_32BGRA,
                                         (__bridge CFDictionaryRef)props,
                                         &pixelBuffer_);
    if (cvret != kCVReturnSuccess) {
      std::fprintf(stderr, "[interop] CVPixelBufferCreate failed: %d\n", cvret);
      return;
    }
    createGLTexture();
    createMetalTexture();
  }

  ~MetalInteropTexture() override {
    if (fbo_) glDeleteFramebuffers(1, &fbo_);
    metalTexture_ = nil;
    if (cvMtlTexture_) CFRelease(cvMtlTexture_);
    if (cvMtlCache_) CFRelease(cvMtlCache_);
    if (cvGlTexture_) CFRelease(cvGlTexture_);
    if (cvGlCache_) CFRelease(cvGlCache_);
    if (pixelBuffer_) CVPixelBufferRelease(pixelBuffer_);
  }

  GLuint getOpenGLFBO() const override { return fbo_; }
  GLuint getOpenGLTexture() const override { return glTexture_; }
  void* getNativeTexture() const override { return (__bridge void*)metalTexture_; }
  bool valid() const override { return fbo_ != 0 && metalTexture_ != nil; }

 private:
  void createGLTexture() {
    CVReturn cvret = CVOpenGLTextureCacheCreate(
        kCFAllocatorDefault, nil, glContext_.CGLContextObj,
        glContext_.pixelFormat.CGLPixelFormatObj, nil, &cvGlCache_);
    if (cvret != kCVReturnSuccess) {
      std::fprintf(stderr, "[interop] GL texture cache failed: %d\n", cvret);
      return;
    }
    cvret = CVOpenGLTextureCacheCreateTextureFromImage(
        kCFAllocatorDefault, cvGlCache_, pixelBuffer_, nil, &cvGlTexture_);
    if (cvret != kCVReturnSuccess) {
      std::fprintf(stderr, "[interop] GL texture from image failed: %d\n", cvret);
      return;
    }
    glTexture_ = CVOpenGLTextureGetName(cvGlTexture_);

    GLint prevDraw = 0, prevRead = 0;
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
    glGenFramebuffers(1, &fbo_);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo_);
    // RECTANGLE, not 2D: that is what CVOpenGLTextureCache hands back on macOS,
    // because an IOSurface-backed texture cannot be GL_TEXTURE_2D in legacy GL.
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                           GL_TEXTURE_RECTANGLE, glTexture_, 0);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
  }

  void createMetalTexture() {
    CVReturn cvret = CVMetalTextureCacheCreate(kCFAllocatorDefault, nil,
                                               device_, nil, &cvMtlCache_);
    if (cvret != kCVReturnSuccess) {
      std::fprintf(stderr, "[interop] Metal texture cache failed: %d\n", cvret);
      return;
    }
    // ShaderWrite has to be asked for. The default (nil attributes) is
    // ShaderRead | RenderTarget, under which a compute kernel's
    // `outputTex[gid] = ...` fails SILENTLY — black output with no error, which
    // is exactly how this first showed up.
    NSDictionary* attrs = @{
      (NSString*)kCVMetalTextureUsage : @(MTLTextureUsageShaderRead |
                                          MTLTextureUsageShaderWrite |
                                          MTLTextureUsageRenderTarget),
    };
    cvret = CVMetalTextureCacheCreateTextureFromImage(
        kCFAllocatorDefault, cvMtlCache_, pixelBuffer_,
        (__bridge CFDictionaryRef)attrs, MTLPixelFormatBGRA8Unorm,
        width_, height_, 0, &cvMtlTexture_);
    if (cvret != kCVReturnSuccess) {
      std::fprintf(stderr, "[interop] Metal texture from image failed: %d\n", cvret);
      return;
    }
    metalTexture_ = CVMetalTextureGetTexture(cvMtlTexture_);
  }

  id<MTLDevice> device_ = nil;
  NSOpenGLContext* glContext_ = nil;
  CVPixelBufferRef pixelBuffer_ = nullptr;
  CVOpenGLTextureCacheRef cvGlCache_ = nullptr;
  CVOpenGLTextureRef cvGlTexture_ = nullptr;
  CVMetalTextureCacheRef cvMtlCache_ = nullptr;
  CVMetalTextureRef cvMtlTexture_ = nullptr;
  id<MTLTexture> metalTexture_ = nil;
  GLuint glTexture_ = 0;
  GLuint fbo_ = 0;
};

}  // namespace

std::unique_ptr<InteropTexture> createInteropTexture(void* device, int width,
                                                     int height) {
  return std::make_unique<MetalInteropTexture>(
      (__bridge id<MTLDevice>)device, [NSOpenGLContext currentContext],
      width, height);
}
