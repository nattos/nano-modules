// barrel_probe_tex_metal.mm — the Metal half of barrel_probe_tex.h.

#include "barrel_probe_tex.h"

#import <Metal/Metal.h>

namespace barrel_probe {

void* createTexture(void* device, int w, int h) {
  id<MTLDevice> dev = (__bridge id<MTLDevice>)device;
  if (!dev || w <= 0 || h <= 0) return nullptr;
  MTLTextureDescriptor* d =
      [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                         width:(NSUInteger)w
                                                        height:(NSUInteger)h
                                                     mipmapped:NO];
  // Same three uses the D3D11 side asks for: sampled, compute-written,
  // rasterized into.
  d.usage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite |
            MTLTextureUsageRenderTarget;
  d.storageMode = MTLStorageModeShared;
  id<MTLTexture> tex = [dev newTextureWithDescriptor:d];
  if (!tex) return nullptr;
  return (void*)CFBridgingRetain(tex);
}

void releaseTexture(void* texture) {
  if (texture) CFRelease(texture);
}

void fillTexture(void* device, void* texture, int w, int h,
                 uint8_t b, uint8_t g, uint8_t r, uint8_t a) {
  (void)device;
  id<MTLTexture> tex = (__bridge id<MTLTexture>)texture;
  if (!tex || w <= 0 || h <= 0) return;
  std::vector<uint8_t> px((size_t)w * h * 4);
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = a;
  }
  [tex replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)w, (NSUInteger)h)
         mipmapLevel:0
           withBytes:px.data()
         bytesPerRow:(NSUInteger)(w * 4)];
}

void uploadTexture(void* device, void* texture, int w, int h, const uint8_t* bgra) {
  (void)device;
  id<MTLTexture> tex = (__bridge id<MTLTexture>)texture;
  if (!tex || !bgra || w <= 0 || h <= 0) return;
  [tex replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)w, (NSUInteger)h)
         mipmapLevel:0
           withBytes:bgra
         bytesPerRow:(NSUInteger)(w * 4)];
}

bool readTexture(void* device, void* texture, int w, int h,
                 std::vector<uint8_t>& outRgba) {
  (void)device;
  id<MTLTexture> tex = (__bridge id<MTLTexture>)texture;
  if (!tex || w <= 0 || h <= 0) return false;
  std::vector<uint8_t> bgra((size_t)w * h * 4);
  [tex getBytes:bgra.data()
    bytesPerRow:(NSUInteger)(w * 4)
     fromRegion:MTLRegionMake2D(0, 0, (NSUInteger)w, (NSUInteger)h)
    mipmapLevel:0];
  outRgba.assign(bgra.size(), 0);
  for (size_t i = 0; i + 3 < bgra.size(); i += 4) {
    outRgba[i + 0] = bgra[i + 2];
    outRgba[i + 1] = bgra[i + 1];
    outRgba[i + 2] = bgra[i + 0];
    outRgba[i + 3] = bgra[i + 3];
  }
  return true;
}

}  // namespace barrel_probe
