#include "image_loader.h"

#include <vector>

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

#ifdef __APPLE__
#include <OpenGL/gl3.h>
#endif

GLuint load_texture_from_url(const char* url, int* out_w, int* out_h) {
  @autoreleasepool {
    NSURL* nsurl = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
    if (!nsurl) return 0;

    NSData* data = [NSData dataWithContentsOfURL:nsurl];
    if (!data || [data length] == 0) return 0;

    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
    if (!provider) return 0;

    CGImageRef image = nullptr;

    // Try PNG first, then JPEG
    image = CGImageCreateWithPNGDataProvider(provider, nullptr, false, kCGRenderingIntentDefault);
    if (!image)
      image = CGImageCreateWithJPEGDataProvider(provider, nullptr, false, kCGRenderingIntentDefault);

    CGDataProviderRelease(provider);
    if (!image) return 0;

    int w = (int)CGImageGetWidth(image);
    int h = (int)CGImageGetHeight(image);
    if (out_w) *out_w = w;
    if (out_h) *out_h = h;

    // Render into RGBA bitmap
    std::vector<uint8_t> pixels(w * h * 4, 0);
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(
        pixels.data(), w, h, 8, w * 4, cs,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(cs);

    if (!ctx) {
      CGImageRelease(image);
      return 0;
    }

    CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), image);
    CGContextRelease(ctx);
    CGImageRelease(image);

    // Upload to GL
    GLuint tex = 0;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0,
                 GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glBindTexture(GL_TEXTURE_2D, 0);

    return tex;
  }
}
