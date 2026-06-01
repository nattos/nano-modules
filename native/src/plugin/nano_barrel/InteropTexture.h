/*
Implemenation of class representing a texture shared between OpenGL and Metal
*/

#pragma once

#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl.h>
#import <OpenGL/gl3.h>

#import <AppKit/AppKit.h>
#define PlatformGLContext NSOpenGLContext

struct AAPLTextureFormatInfo;

class InteropTexture {
public:
  InteropTexture(id<MTLDevice> mtlDevice, PlatformGLContext *glContext,
                 bool createOpenGLFBO, MTLPixelFormat mtlPixelFormat, int width,
                 int height);
  ~InteropTexture();

  id<MTLTexture> getMetalTexture() const { return _metalTexture; }
  GLuint getOpenGLTexture() const { return _openGLTexture; }
  GLuint getOpenGLFBO() const { return _openGLFBO; }
  int getWidth() const { return _width; }
  int getHeight() const { return _height; }

private:
  void createGLTexture();
  void createMetalTexture();

  id<MTLDevice> _metalDevice = nil;
  PlatformGLContext *_openGLContext = nil;

  int _width;
  int _height;
  bool _createOpenGLFBO;

  id<MTLTexture> _metalTexture = nil;
  GLuint _openGLTexture = 0;
  GLuint _openGLFBO = 0;

  // Internal resources
  const AAPLTextureFormatInfo *_formatInfo = nullptr;
  CVPixelBufferRef _CVPixelBuffer = nullptr;
  CVMetalTextureRef _CVMTLTexture = nullptr;
  CVMetalTextureCacheRef _CVMTLTextureCache = nullptr;

  CVOpenGLTextureCacheRef _CVGLTextureCache = nullptr;
  CVOpenGLTextureRef _CVGLTexture = nullptr;
  CGLPixelFormatObj _CGLPixelFormat = nullptr;
};
