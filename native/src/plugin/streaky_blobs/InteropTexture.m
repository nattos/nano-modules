/*
Implemenation of class representing a texture shared between OpenGL and Metal
*/
#import "InteropTexture.h"
#include <iostream>

typedef struct AAPLTextureFormatInfo {
  int cvPixelFormat;
  MTLPixelFormat mtlFormat;
  GLuint glInternalFormat;
  GLuint glFormat;
  GLuint glType;
} AAPLTextureFormatInfo;

// Table of equivalent formats across CoreVideo, Metal, and OpenGL
static const AAPLTextureFormatInfo AAPLInteropFormatTable[] = {
    // Core Video Pixel Format,               Metal Pixel Format,            GL
    // internalformat, GL format,   GL type
    {kCVPixelFormatType_32BGRA, MTLPixelFormatBGRA8Unorm, GL_RGBA, GL_BGRA_EXT,
     GL_UNSIGNED_INT_8_8_8_8_REV},
#if TARGET_IOS
    {kCVPixelFormatType_32BGRA, MTLPixelFormatBGRA8Unorm_sRGB, GL_RGBA,
     GL_BGRA_EXT, GL_UNSIGNED_INT_8_8_8_8_REV},
#else
    {kCVPixelFormatType_ARGB2101010LEPacked, MTLPixelFormatBGR10A2Unorm,
     GL_RGB10_A2, GL_BGRA, GL_UNSIGNED_INT_2_10_10_10_REV},
    {kCVPixelFormatType_32BGRA, MTLPixelFormatBGRA8Unorm_sRGB, GL_SRGB8_ALPHA8,
     GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV},
    {kCVPixelFormatType_64RGBAHalf, MTLPixelFormatRGBA16Float, GL_RGBA, GL_RGBA,
     GL_HALF_FLOAT},
#endif
};

static const NSUInteger AAPLNumInteropFormats =
    sizeof(AAPLInteropFormatTable) / sizeof(AAPLTextureFormatInfo);

const AAPLTextureFormatInfo *const
textureFormatInfoFromMetalPixelFormat(MTLPixelFormat pixelFormat) {
  for (int i = 0; i < AAPLNumInteropFormats; i++) {
    if (pixelFormat == AAPLInteropFormatTable[i].mtlFormat) {
      return &AAPLInteropFormatTable[i];
    }
  }
  return NULL;
}

InteropTexture::InteropTexture(id<MTLDevice> mtlDevice,
                               PlatformGLContext *glContext,
                               bool createOpenGLFBO,
                               MTLPixelFormat mtlPixelFormat, int width,
                               int height)
    : _metalDevice(mtlDevice), _openGLContext(glContext),
      _createOpenGLFBO(createOpenGLFBO), _width(width), _height(height) {
  _formatInfo = textureFormatInfoFromMetalPixelFormat(mtlPixelFormat);
  if (!_formatInfo) {
    std::cerr << "Metal Format supplied not supported in this sample"
              << std::endl;
    return;
  }

  _CGLPixelFormat = _openGLContext.pixelFormat.CGLPixelFormatObj;

  NSDictionary *cvBufferProperties = @{
    (__bridge NSString *)kCVPixelBufferOpenGLCompatibilityKey : @YES,
    (__bridge NSString *)kCVPixelBufferMetalCompatibilityKey : @YES,
    (__bridge NSString *)kCVPixelBufferIOSurfaceOpenGLFBOCompatibilityKey :
        @YES, // Important for FBO
    (__bridge NSString *)
    kCVPixelBufferIOSurfaceOpenGLTextureCompatibilityKey : @YES,
  };

  CVReturn cvret = CVPixelBufferCreate(
      kCFAllocatorDefault, width, height, _formatInfo->cvPixelFormat,
      (__bridge CFDictionaryRef)cvBufferProperties, &_CVPixelBuffer);

  if (cvret != kCVReturnSuccess) {
    std::cerr << "Failed to create CVPixelBuffer: " << cvret << std::endl;
    return;
  }

  createGLTexture();
  createMetalTexture();
}

InteropTexture::~InteropTexture() {
  if (_openGLFBO) {
    glDeleteFramebuffers(1, &_openGLFBO);
  }

  if (_metalTexture) {
    _metalTexture =
        nil; // ARC will handle this? Yes for ObjC properties, but raw pointers?
             // Wait, members are id<MTLTexture>, so ARC handles them.
  }

  // Release CoreVideo resources explicitly!
  if (_CVMTLTexture)
    CFRelease(_CVMTLTexture);
  if (_CVMTLTextureCache)
    CFRelease(_CVMTLTextureCache);

  if (_CVGLTexture)
    CFRelease(_CVGLTexture);
  if (_CVGLTextureCache)
    CFRelease(_CVGLTextureCache);

  if (_CVPixelBuffer)
    CVPixelBufferRelease(_CVPixelBuffer);
}

/**
 On macOS, create an OpenGL texture and retrieve an OpenGL texture name using
 the following steps, and as annotated in the code listings below:
 */
void InteropTexture::createGLTexture() {
  CVReturn cvret;
  // 1. Create an OpenGL CoreVideo texture cache from the pixel buffer.
  cvret = CVOpenGLTextureCacheCreate(kCFAllocatorDefault, nil,
                                     _openGLContext.CGLContextObj,
                                     _CGLPixelFormat, nil, &_CVGLTextureCache);

  if (cvret != kCVReturnSuccess) {
    std::cerr << "Failed to create OpenGL Texture Cache" << std::endl;
    return;
  }

  // 2. Create a CVPixelBuffer-backed OpenGL texture image from the texture
  // cache.
  cvret = CVOpenGLTextureCacheCreateTextureFromImage(
      kCFAllocatorDefault, _CVGLTextureCache, _CVPixelBuffer, nil,
      &_CVGLTexture);

  if (cvret != kCVReturnSuccess) {
    std::cerr << "Failed to create OpenGL Texture From Image" << std::endl;
    return;
  }

  // 3. Get an OpenGL texture name from the CVPixelBuffer-backed OpenGL texture
  // image.
  _openGLTexture = CVOpenGLTextureGetName(_CVGLTexture);

  if (_createOpenGLFBO) {
    GLint previousDrawFboID;
    GLint previosReadFboID;
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &previousDrawFboID);
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &previosReadFboID);

    glGenFramebuffers(1, &_openGLFBO);
    glBindFramebuffer(GL_FRAMEBUFFER, _openGLFBO);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                           GL_TEXTURE_RECTANGLE, _openGLTexture, 0);

    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, previousDrawFboID);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, previosReadFboID);
  }
}

/**
 Create a Metal texture from the CoreVideo pixel buffer using the following
 steps, and as annotated in the code listings below:
 */
void InteropTexture::createMetalTexture() {
  CVReturn cvret;
  // 1. Create a Metal Core Video texture cache from the pixel buffer.
  cvret = CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, _metalDevice, nil,
                                    &_CVMTLTextureCache);

  if (cvret != kCVReturnSuccess) {
    std::cerr << "Failed to create Metal texture cache" << std::endl;
    return;
  }

  // 2. Create a CoreVideo pixel buffer backed Metal texture image from the
  // texture cache.

  cvret = CVMetalTextureCacheCreateTextureFromImage(
      kCFAllocatorDefault, _CVMTLTextureCache, _CVPixelBuffer, nil,
      _formatInfo->mtlFormat, _width, _height, 0, &_CVMTLTexture);

  if (cvret != kCVReturnSuccess) {
    std::cerr << "Failed to create CoreVideo Metal texture from image"
              << std::endl;
    return;
  }

  // 3. Get a Metal texture using the CoreVideo Metal texture reference.
  _metalTexture = CVMetalTextureGetTexture(_CVMTLTexture);

  if (!_metalTexture) {
    std::cerr << "Failed to create Metal texture CoreVideo Metal Texture"
              << std::endl;
  }
}
