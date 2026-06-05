/*
 * blitz_metal.mm — native GPU (Metal) end-to-end of the Blitz complex-layout
 * mode, the "for realz" pixel path:
 *
 *   HTML/CSS ──tb_layout──► pre-shaped runs ──Engine::layoutGlyphs──►
 *   GlyphQuads + BoxQuads + MSDF atlas ──[Metal compute compositor]──► RGBA
 *
 * This is blitz_dump's twin, but instead of the CPU golden Engine::rasterize it
 * runs the SAME compositor math on the GPU via the MSL kernel in
 * src/text/shaders/text_composite_msl.h — the exact native code path the
 * `text.render` host impl will use inside the FFGL plugin. metal_parity.sh diffs
 * this composite against the CPU golden to prove the Metal compositor reproduces
 * the reference pixels (perceptual tolerance: GPU bilinear differs a few LSB,
 * same as the WebGPU path).
 *
 *   blitz_metal <doc.html>   (env TE_FONT, TE_FALLBACK, TE_W, TE_H, TE_PNG, TE_RAW)
 */

#import <Metal/Metal.h>
#import <Foundation/Foundation.h>

#include "text_blitz.h"
#include "text_engine.h"
#include "png_write.h"
#include "shaders/text_composite_msl.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static_assert(sizeof(text_engine::GlyphQuad) == 96, "GlyphQuad must be 96 bytes (6x float4)");
static_assert(sizeof(text_engine::BoxQuad) == 112, "BoxQuad must be 112 bytes (7x float4)");

// 48-byte uniform block, byte-identical to the WGSL `U` struct (and the JS
// DataView packing in text-engine.ts render()).
struct UBO {
  uint32_t canvas_w, canvas_h, glyph_count, atlas_w, atlas_h;
  float    origin_x, origin_y;
  uint32_t atlas_kind;
  float    atlas_px_range;
  uint32_t box_count;
  float    _p1, _p2;
};
static_assert(sizeof(UBO) == 48, "uniform block must be 48 bytes");

static std::vector<uint8_t> readFile(const char* path) {
  std::vector<uint8_t> out;
  if (FILE* f = std::fopen(path, "rb")) {
    std::fseek(f, 0, SEEK_END); long n = std::ftell(f); std::fseek(f, 0, SEEK_SET);
    out.resize(n);
    if (std::fread(out.data(), 1, n, f) != (size_t)n) out.clear();
    std::fclose(f);
  }
  return out;
}

static const char* kSampleHtml =
  "<!DOCTYPE html><html><head><style>"
  "body{margin:0;font-family:sans-serif;color:#fff;}"
  ".wrap{display:flex;gap:16px;padding:24px;}"
  "h1{font-size:40px;font-weight:700;margin:0 0 8px;}"
  "p{font-size:18px;line-height:1.4;width:320px;}"
  ".badge{font-size:14px;font-weight:700;color:#6cf;}"
  "</style></head><body><div class=\"wrap\"><div>"
  "<h1>Blitz layout</h1>"
  "<p>Real CSS flexbox and text wrapping, shaped by parley, emitted as "
  "positioned glyph runs for the MSDF atlas.</p>"
  "<span class=\"badge\">PARITY \xc2\xb7 MSDF \xc2\xb7 GPU</span>"
  "</div></div></body></html>";

int main(int argc, char** argv) {
  @autoreleasepool {
    auto& eng = text_engine::Engine::instance();
    TbSession* sess = tb_create();

    // Primary font into BOTH engine (face 0) and Blitz (faceId 0) — same bytes,
    // same faceId, so GIDs agree. (Identical setup to blitz_dump.)
    const char* fontPath = std::getenv("TE_FONT");
    if (!fontPath) fontPath = "/System/Library/Fonts/Helvetica.ttc";
    std::vector<uint8_t> fb = readFile(fontPath);
    if (fb.empty()) { std::fprintf(stderr, "font load failed: %s\n", fontPath); return 1; }
    eng.setFont(fb.data(), (int)fb.size());
    tb_add_font(sess, nullptr, 0, 0, 0, fb.data(), (int)fb.size());

    if (const char* fbEnv = std::getenv("TE_FALLBACK")) {
      std::string list(fbEnv), path;
      for (size_t i = 0; i <= list.size(); i++) {
        if (i == list.size() || list[i] == ':') {
          if (!path.empty()) {
            const char* lang = path.find("-sc") != std::string::npos ? "zh-Hans"
                             : path.find("-tc") != std::string::npos ? "zh-Hant"
                             : path.find("-jp") != std::string::npos ? "ja"
                             : path.find("-kr") != std::string::npos ? "ko" : "";
            std::vector<uint8_t> cb = readFile(path.c_str());
            if (!cb.empty()) {
              eng.addFallbackFont(cb.data(), (int)cb.size(), lang, (int)std::strlen(lang));
              tb_add_font(sess, nullptr, 0, 0, 0, cb.data(), (int)cb.size());
            }
            path.clear();
          }
        } else path.push_back(list[i]);
      }
    }

    std::vector<uint8_t> html;
    if (argc > 1) html = readFile(argv[1]);
    if (html.empty()) html.assign(kSampleHtml, kSampleHtml + std::strlen(kSampleHtml));

    unsigned vw = std::getenv("TE_W") ? (unsigned)std::atoi(std::getenv("TE_W")) : 800;
    unsigned vh = std::getenv("TE_H") ? (unsigned)std::atoi(std::getenv("TE_H")) : 600;

    TbLayout* bl = tb_layout(sess, html.data(), (int)html.size(), vw, vh, 1.0f);
    if (!bl) { std::fprintf(stderr, "tb_layout failed\n"); return 1; }
    int runCount = tb_glyph_count(bl);
    const text_engine::PreGlyph* runs = tb_glyph_ptr(bl);
    int boxInCount = tb_box_count(bl);
    const text_engine::BoxQuad* boxesIn = tb_box_ptr(bl);

    // NB: not `id` — that's an Objective-C keyword; a local named `id` would
    // shadow it and make `id<MTLDevice>` parse as a comparison.
    int lid = eng.layoutGlyphs(runs, runCount, boxesIn, boxInCount);
    if (lid <= 0) { std::fprintf(stderr, "layoutGlyphs failed\n"); return 1; }

    text_engine::Metrics m; eng.measure(lid, m);

    // Pull the GPU draw records (the engine arrays ARE the GPU layout).
    int gcount = eng.glyphCount(lid);
    std::vector<text_engine::GlyphQuad> glyphs(gcount > 0 ? gcount : 1);
    int written = gcount > 0 ? eng.glyphs(lid, glyphs.data(), gcount) : 0;
    int bcount = eng.boxCount(lid);
    std::vector<text_engine::BoxQuad> boxes(bcount > 0 ? bcount : 1);
    int boxesWritten = bcount > 0 ? eng.boxes(lid, boxes.data(), bcount) : 0;

    int aw = eng.atlasWidth(), ah = eng.atlasHeight();
    int pageCount = eng.atlasPageCount();
    int layers = pageCount > 0 ? pageCount : 1;
    if (aw <= 0 || ah <= 0) { aw = 1; ah = 1; }

    int cw = (int)vw, ch = (int)vh;

    // --- Metal setup ---
    id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
    if (!dev) { std::fprintf(stderr, "no Metal device\n"); return 1; }

    NSError* err = nil;
    NSString* src = [NSString stringWithUTF8String:kTextCompositeMSL];
    id<MTLLibrary> lib = [dev newLibraryWithSource:src options:nil error:&err];
    if (!lib) { std::fprintf(stderr, "MSL compile failed: %s\n",
                             err.localizedDescription.UTF8String); return 1; }
    id<MTLFunction> fn = [lib newFunctionWithName:@"text_composite"];
    id<MTLComputePipelineState> pso = [dev newComputePipelineStateWithFunction:fn error:&err];
    if (!pso) { std::fprintf(stderr, "PSO failed: %s\n",
                             err.localizedDescription.UTF8String); return 1; }

    // Atlas: rgba8unorm 2D array, one layer per page, sampled LINEAR.
    MTLTextureDescriptor* ad =
      [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                                         width:aw height:ah mipmapped:NO];
    ad.textureType = MTLTextureType2DArray;
    ad.arrayLength = layers;
    ad.usage = MTLTextureUsageShaderRead;
    ad.storageMode = MTLStorageModeShared;
    id<MTLTexture> atlas = [dev newTextureWithDescriptor:ad];
    for (int p = 0; p < pageCount; p++) {
      const uint8_t* px = eng.atlasPagePixels(p);
      if (!px) continue;
      [atlas replaceRegion:MTLRegionMake2D(0, 0, aw, ah)
               mipmapLevel:0 slice:p withBytes:px
               bytesPerRow:(NSUInteger)aw * 4 bytesPerImage:(NSUInteger)aw * ah * 4];
    }

    // Background: 1x1 opaque black, sampled clamp → black everywhere.
    MTLTextureDescriptor* bd =
      [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                                         width:1 height:1 mipmapped:NO];
    bd.usage = MTLTextureUsageShaderRead; bd.storageMode = MTLStorageModeShared;
    id<MTLTexture> bg = [dev newTextureWithDescriptor:bd];
    uint8_t black[4] = {0, 0, 0, 255};
    [bg replaceRegion:MTLRegionMake2D(0, 0, 1, 1) mipmapLevel:0 withBytes:black bytesPerRow:4];

    // Output: rgba8unorm, shader-writable, shared so getBytes can read it back.
    MTLTextureDescriptor* od =
      [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                                         width:cw height:ch mipmapped:NO];
    od.usage = MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead;
    od.storageMode = MTLStorageModeShared;
    id<MTLTexture> out = [dev newTextureWithDescriptor:od];

    MTLSamplerDescriptor* sd = [[MTLSamplerDescriptor alloc] init];
    sd.minFilter = MTLSamplerMinMagFilterLinear;
    sd.magFilter = MTLSamplerMinMagFilterLinear;
    sd.sAddressMode = MTLSamplerAddressModeClampToEdge;
    sd.tAddressMode = MTLSamplerAddressModeClampToEdge;
    id<MTLSamplerState> samp = [dev newSamplerStateWithDescriptor:sd];

    id<MTLBuffer> glyphBuf =
      [dev newBufferWithBytes:glyphs.data()
                       length:std::max<size_t>(96, written * sizeof(text_engine::GlyphQuad))
                      options:MTLResourceStorageModeShared];
    id<MTLBuffer> boxBuf =
      [dev newBufferWithBytes:boxes.data()
                       length:std::max<size_t>(112, boxesWritten * sizeof(text_engine::BoxQuad))
                      options:MTLResourceStorageModeShared];

    UBO u{};
    u.canvas_w = (uint32_t)cw; u.canvas_h = (uint32_t)ch;
    u.glyph_count = (uint32_t)written;
    u.atlas_w = (uint32_t)aw; u.atlas_h = (uint32_t)ah;
    u.origin_x = 0.0f; u.origin_y = 0.0f;          // full viewport, doc top-left
    u.atlas_kind = (uint32_t)m.atlas_kind;
    u.atlas_px_range = m.atlas_px_range;
    u.box_count = (uint32_t)boxesWritten;
    id<MTLBuffer> uniBuf = [dev newBufferWithBytes:&u length:sizeof(UBO)
                                           options:MTLResourceStorageModeShared];

    id<MTLCommandQueue> q = [dev newCommandQueue];
    id<MTLCommandBuffer> cb = [q commandBuffer];
    id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
    [enc setComputePipelineState:pso];
    [enc setBuffer:glyphBuf offset:0 atIndex:0];
    [enc setBuffer:boxBuf  offset:0 atIndex:1];
    [enc setBuffer:uniBuf  offset:0 atIndex:2];
    [enc setTexture:atlas atIndex:0];
    [enc setTexture:bg    atIndex:1];
    [enc setTexture:out   atIndex:2];
    [enc setSamplerState:samp atIndex:0];
    MTLSize tg = MTLSizeMake(8, 8, 1);
    MTLSize groups = MTLSizeMake((cw + 7) / 8, (ch + 7) / 8, 1);
    [enc dispatchThreadgroups:groups threadsPerThreadgroup:tg];
    [enc endEncoding];
    [cb commit];
    [cb waitUntilCompleted];
    if (cb.error) { std::fprintf(stderr, "GPU error: %s\n",
                                 cb.error.localizedDescription.UTF8String); return 1; }

    std::vector<uint8_t> img((size_t)cw * ch * 4);
    [out getBytes:img.data() bytesPerRow:(NSUInteger)cw * 4
       fromRegion:MTLRegionMake2D(0, 0, cw, ch) mipmapLevel:0];

    uint32_t chash = 0x811c9dc5u;
    for (uint8_t v : img) { chash ^= v; chash *= 0x01000193u; }
    if (const char* p = std::getenv("TE_PNG"))  png_write::writeFile(p, img.data(), cw, ch);
    if (const char* rp = std::getenv("TE_RAW")) {
      if (FILE* rf = std::fopen(rp, "wb")) { std::fwrite(img.data(), 1, img.size(), rf); std::fclose(rf); }
    }

    std::printf("{\"runs\":%d,\"boxes\":%d,\"glyphs\":%d,\"pages\":%d,"
                "\"width\":%.3f,\"height\":%.3f,\"device\":\"%s\",\"composite\":%u}\n",
                runCount, boxInCount, written, pageCount, m.width, m.height,
                dev.name.UTF8String, chash);

    tb_free_layout(bl);
    tb_destroy(sess);
  }
  return 0;
}
