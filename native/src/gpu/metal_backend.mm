#include "gpu/gpu_backend.h"

#import <Metal/Metal.h>
#import <MetalPerformanceShaders/MetalPerformanceShaders.h>
#include <map>
#include <string>
#include <cstdio>
#include <cstring>
#include <unordered_map>
#include <vector>

namespace gpu {

enum class ResourceType { Buffer, Texture, Library, ComputePSO, RenderPSO,
                          Sampler };

struct Resource {
  ResourceType type;
  id obj = nil;
  // Encode-generation of the last time this resource was bound into GPU work
  // (see encodeGen_). Lets writeBuffer/writeTexture detect a CPU write racing
  // encoded-but-uncommitted work that references the resource.
  uint64_t lastBoundGen = 0;
};

class MetalBackend : public GPUBackend {
public:
  MetalBackend(id<MTLDevice> device)
      : device_(device), queue_([device newCommandQueue]) {}

  ~MetalBackend() override {
    resources_.clear();
  }

  int32_t getBackend() override { return 0; } // Metal

  // --- Resource creation ---

  int32_t createShaderModule(const std::string& source) override {
    @autoreleasepool {
      NSError* error = nil;
      NSString* src = [NSString stringWithUTF8String:source.c_str()];
      MTLCompileOptions* opts = [[MTLCompileOptions alloc] init];
      id<MTLLibrary> lib = [device_ newLibraryWithSource:src options:opts error:&error];
      if (!lib) {
        NSLog(@"Metal shader compile error: %@", error);
        return -1;
      }
      int32_t handle = alloc(ResourceType::Library, lib);
      // Parse function-constant declarations so PSO-creation can set
      // them by NAME (matching the C++-side gpu::Constants::set(name, …))
      // even though spirv-cross emits them with anonymous numeric
      // indices like `TILE_SIZE_tmp [[function_constant(0)]]`.
      shaderConstIndices_[handle] = parseFunctionConstants(source);
      // Compute threadgroup size (from the spvToMsl hint) so dispatch matches
      // the shader's [numthreads], not a hardcoded 8×8×1.
      shaderThreadgroup_[handle] = parseThreadgroup(source);
      return handle;
    }
  }

  int32_t createBuffer(uint64_t size, int32_t usage) override {
    (void)usage; // Metal doesn't need usage hints at creation
    id<MTLBuffer> buf = [device_ newBufferWithLength:(NSUInteger)size
                                             options:MTLResourceStorageModeShared];
    if (!buf) return -1;
    return alloc(ResourceType::Buffer, buf);
  }

  // Decode a wire TextureFormat code (wasm_modules/include/gpu.h) to MTL.
  // 2 (Surface) → the currently bound surface's format; 6 (SketchDefault) →
  // the sketch working format set via setDefaultTextureFormat (1 or 3).
  MTLPixelFormat pixelFormatFromCode(int32_t format) const {
    switch (format) {
      case 0:  return MTLPixelFormatBGRA8Unorm;
      case 1:  return MTLPixelFormatRGBA8Unorm;
      case 2:  return surfaceFormat_;
      case 3:  return MTLPixelFormatRGBA16Float;
      case 4:  return MTLPixelFormatR32Float;
      case 5:  return MTLPixelFormatRGBA32Float;
      case 6: {
        int32_t c = defaultTextureFormatCode_;
        if (c == 2 || c == 6) c = 1;  // never self/surface-referential
        return pixelFormatFromCode(c);
      }
      case 7:  return MTLPixelFormatRGBA8Unorm_sRGB;
      default: return MTLPixelFormatRGBA8Unorm;
    }
  }

  void setDefaultTextureFormat(int32_t code) override {
    defaultTextureFormatCode_ = (code == 2 || code == 6) ? 1 : code;
    // Seed the surface format so Surface-format PSOs created at effect init
    // (before any set_surface this frame) match the sketch's intermediates.
    surfaceFormat_ = pixelFormatFromCode(defaultTextureFormatCode_);
  }

  int32_t createTexture(uint32_t w, uint32_t h, int32_t format) override {
    MTLPixelFormat pf = pixelFormatFromCode(format);
    MTLTextureDescriptor* desc = [[MTLTextureDescriptor alloc] init];
    desc.width = w;
    desc.height = h;
    desc.pixelFormat = pf;
    // ShaderWrite is required for storage-texture writes (the storageTex2d
    // bindings in modern effects). Add it unconditionally — it's a no-op
    // if the shader doesn't write to the texture. Exception: sRGB formats
    // don't support shader writes (matching WebGPU, which forbids sRGB
    // storage textures outright) — they're render+sample only.
    desc.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    if (pf != MTLPixelFormatRGBA8Unorm_sRGB && pf != MTLPixelFormatBGRA8Unorm_sRGB) {
      desc.usage |= MTLTextureUsageShaderWrite;
    }
    desc.storageMode = MTLStorageModeShared; // CPU-readable for readback
    id<MTLTexture> tex = [device_ newTextureWithDescriptor:desc];
    if (!tex) return -1;
    return alloc(ResourceType::Texture, tex);
  }

  int32_t createTexture3D(uint32_t w, uint32_t h, uint32_t d,
                          int32_t format) override {
    // 3D LUTs are typically rgba8unorm.
    MTLPixelFormat pf = pixelFormatFromCode(format);
    MTLTextureDescriptor* desc = [[MTLTextureDescriptor alloc] init];
    desc.textureType = MTLTextureType3D;
    desc.width  = w;
    desc.height = h;
    desc.depth  = d;
    desc.pixelFormat = pf;
    // ShaderWrite enables storage-texture writes (the init pass fills the LUT
    // via a texture_storage_3d binding); ShaderRead for the sampled lookup.
    // RenderTarget isn't needed for a volume texture.
    desc.usage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite;
    desc.storageMode = MTLStorageModeShared;  // CPU-readable for readback
    id<MTLTexture> tex = [device_ newTextureWithDescriptor:desc];
    if (!tex) return -1;
    return alloc(ResourceType::Texture, tex);
  }

  int32_t createTextureArray(uint32_t w, uint32_t h,
                             int32_t format, int32_t layers) override {
    MTLPixelFormat pf = pixelFormatFromCode(format);
    MTLTextureDescriptor* desc = [[MTLTextureDescriptor alloc] init];
    desc.textureType = MTLTextureType2DArray;
    desc.width = w;
    desc.height = h;
    desc.arrayLength = layers > 0 ? (NSUInteger)layers : 1;
    desc.pixelFormat = pf;
    desc.usage = MTLTextureUsageShaderRead;
    desc.storageMode = MTLStorageModeShared;  // CPU per-layer upload
    id<MTLTexture> tex = [device_ newTextureWithDescriptor:desc];
    if (!tex) return -1;
    return alloc(ResourceType::Texture, tex);
  }

  void writeTextureLayer(int32_t textureHandle, int32_t layer,
                         uint32_t w, uint32_t h,
                         const uint8_t* bytes, uint32_t byteCount) override {
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (!tex || !bytes) return;
    if (byteCount < w * h * 4) return;
    [tex replaceRegion:MTLRegionMake2D(0, 0, w, h)
           mipmapLevel:0
                 slice:(NSUInteger)layer
             withBytes:bytes
           bytesPerRow:w * 4
         bytesPerImage:(NSUInteger)w * h * 4];
  }

  int32_t createComputePSO(int32_t shaderHandle, const std::string& entryPoint) override {
    @autoreleasepool {
      id<MTLLibrary> lib = getAs<id<MTLLibrary>>(shaderHandle);
      if (!lib) return -1;
      NSString* name = [NSString stringWithUTF8String:entryPoint.c_str()];
      id<MTLFunction> func = [lib newFunctionWithName:name];
      if (!func) return -1;
      NSError* error = nil;
      id<MTLComputePipelineState> pso = [device_ newComputePipelineStateWithFunction:func error:&error];
      if (!pso) {
        NSLog(@"Metal compute PSO error: %@", error);
        return -1;
      }
      int32_t psoHandle = alloc(ResourceType::ComputePSO, pso);
      recordPsoThreadgroup(psoHandle, shaderHandle);
      return psoHandle;
    }
  }

  int32_t createComputePSOWithConstants(int32_t shaderHandle,
                                         const std::string& entryPoint,
                                         const std::vector<SpecConstant>& constants) override {
    @autoreleasepool {
      id<MTLLibrary> lib = getAs<id<MTLLibrary>>(shaderHandle);
      if (!lib) return -1;
      NSString* name = [NSString stringWithUTF8String:entryPoint.c_str()];
      MTLFunctionConstantValues* values =
          [[MTLFunctionConstantValues alloc] init];
      // spirv-cross emits Metal function constants with anonymous
      // `_tmp`-suffixed names and exposes them by numeric index
      // (`[[function_constant(N)]]`). setConstantValue:withName: would
      // look for the post-suffix name we'd never know — bind by INDEX
      // using the name→index map parsed at createShaderModule time.
      // All current spec constants are int (TILE_SIZE, CHROMA_ENABLED,
      // NEIGHBOR_TEX_MIP, PYRAMID_NBR_RADIUS); pass as MTLDataTypeInt.
      auto idxIt = shaderConstIndices_.find(shaderHandle);
      const auto* idxMap = (idxIt != shaderConstIndices_.end())
                            ? &idxIt->second : nullptr;
      for (const auto& c : constants) {
        if (idxMap) {
          auto it = idxMap->find(c.name);
          if (it != idxMap->end()) {
            // Pack the value at the constant's declared MSL type so
            // Metal accepts the binding. Mixed uint/int constants are
            // common (e.g. motion_blur uses both).
            switch (it->second.type) {
              case MTLDataTypeUInt: {
                uint32_t v = (uint32_t)c.value;
                [values setConstantValue:&v type:MTLDataTypeUInt
                                  atIndex:(NSUInteger)it->second.index];
                break;
              }
              case MTLDataTypeBool: {
                bool v = c.value != 0.0;
                [values setConstantValue:&v type:MTLDataTypeBool
                                  atIndex:(NSUInteger)it->second.index];
                break;
              }
              case MTLDataTypeFloat: {
                float v = (float)c.value;
                [values setConstantValue:&v type:MTLDataTypeFloat
                                  atIndex:(NSUInteger)it->second.index];
                break;
              }
              case MTLDataTypeInt:
              default: {
                int v = (int)c.value;
                [values setConstantValue:&v type:MTLDataTypeInt
                                  atIndex:(NSUInteger)it->second.index];
                break;
              }
            }
            continue;
          }
        }
        // Fallback: by-name as int (rare path).
        int intValue = (int)c.value;
        NSString* nsName = [NSString stringWithUTF8String:c.name.c_str()];
        [values setConstantValue:&intValue type:MTLDataTypeInt
                        withName:nsName];
      }
      NSError* error = nil;
      id<MTLFunction> func = [lib newFunctionWithName:name
                                       constantValues:values
                                                error:&error];
      if (!func) {
        NSLog(@"Metal newFunctionWithName (constants) error: %@", error);
        return -1;
      }
      id<MTLComputePipelineState> pso =
          [device_ newComputePipelineStateWithFunction:func error:&error];
      if (!pso) {
        NSLog(@"Metal compute PSO (constants) error: %@", error);
        return -1;
      }
      int32_t psoHandle = alloc(ResourceType::ComputePSO, pso);
      recordPsoThreadgroup(psoHandle, shaderHandle);
      return psoHandle;
    }
  }

  int32_t createTextureWithMips(uint32_t w, uint32_t h,
                                 int32_t format, int32_t mipCount) override {
    MTLPixelFormat pf = pixelFormatFromCode(format);
    MTLTextureDescriptor* desc = [[MTLTextureDescriptor alloc] init];
    desc.width = w;
    desc.height = h;
    desc.mipmapLevelCount = mipCount > 0 ? (NSUInteger)mipCount : 1;
    desc.pixelFormat = pf;
    desc.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead
               | MTLTextureUsageShaderWrite;
    // Private storage for mip textures — they're GPU-only intermediates
    // (the pyramid in motion_blur). CPU readback isn't needed.
    desc.storageMode = MTLStorageModePrivate;
    id<MTLTexture> tex = [device_ newTextureWithDescriptor:desc];
    if (!tex) return -1;
    return alloc(ResourceType::Texture, tex);
  }

  void computeSetTextureMip(int32_t pass, int32_t textureHandle,
                            int32_t slot, int32_t /*access*/,
                            int32_t mipLevel) override {
    (void)pass;
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (!tex || !computeEncoder_) return;
    // Bind a single-mip view (newTextureViewWithPixelFormat: textureType:
    // levels:slices:) so the GPU rejects accesses outside that mip and
    // the validation layer is happy about pyramid read+write of the
    // same texture across passes.
    id<MTLTexture> view = [tex newTextureViewWithPixelFormat:[tex pixelFormat]
                                                  textureType:MTLTextureType2D
                                                       levels:NSMakeRange((NSUInteger)mipLevel, 1)
                                                       slices:NSMakeRange(0, 1)];
    [computeEncoder_ setTexture:view atIndex:slot];
  }

  int32_t createSampler(const SamplerDesc& sd) override {
    MTLSamplerDescriptor* desc = [[MTLSamplerDescriptor alloc] init];
    const auto minMag = [](int32_t f) {
      return f == 1 ? MTLSamplerMinMagFilterLinear : MTLSamplerMinMagFilterNearest;
    };
    const auto addr = [](int32_t a) {
      switch (a) {
        case 1:  return MTLSamplerAddressModeRepeat;
        case 2:  return MTLSamplerAddressModeMirrorRepeat;
        default: return MTLSamplerAddressModeClampToEdge;
      }
    };
    desc.minFilter = minMag(sd.minFilter);
    desc.magFilter = minMag(sd.magFilter);
    // Explicit — was hardcoded Linear here while web followed mag_filter
    // (the mip-filter divergence the SamplerDesc contract closes).
    desc.mipFilter = sd.mipFilter == 1 ? MTLSamplerMipFilterLinear
                                       : MTLSamplerMipFilterNearest;
    desc.sAddressMode = addr(sd.addressU);
    desc.tAddressMode = addr(sd.addressV);
    desc.rAddressMode = addr(sd.addressW);
    desc.maxAnisotropy = (NSUInteger)std::min(std::max(sd.maxAnisotropy, 1), 16);
    desc.lodMinClamp = sd.lodMinClamp;
    desc.lodMaxClamp = sd.lodMaxClamp;
    id<MTLSamplerState> sampler = [device_ newSamplerStateWithDescriptor:desc];
    if (!sampler) return -1;
    return alloc(ResourceType::Sampler, sampler);
  }

  void computeSetSampler(int32_t pass, int32_t samplerHandle,
                         int32_t slot) override {
    (void)pass;
    id<MTLSamplerState> s = getAs<id<MTLSamplerState>>(samplerHandle);
    if (s && computeEncoder_) [computeEncoder_ setSamplerState:s atIndex:slot];
  }

  void clearTexture(int32_t textureHandle,
                    float r, float g, float b, float a) override {
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (!tex) return;
    if (!cmdBuffer_) cmdBuffer_ = [queue_ commandBuffer];
    MTLRenderPassDescriptor* desc = [MTLRenderPassDescriptor renderPassDescriptor];
    desc.colorAttachments[0].texture = tex;
    desc.colorAttachments[0].loadAction = MTLLoadActionClear;
    desc.colorAttachments[0].storeAction = MTLStoreActionStore;
    desc.colorAttachments[0].clearColor = MTLClearColorMake(r, g, b, a);
    id<MTLRenderCommandEncoder> enc =
        [cmdBuffer_ renderCommandEncoderWithDescriptor:desc];
    [enc endEncoding];
  }

  // A blit copies BYTES. Metal happily blits between two formats of the same
  // bytes/pixel, so copying BGRA8 → RGBA8 (or back) silently SWAPS R and B —
  // blue comes out orange. That boundary is real: the barrel's FFGL interop
  // textures are BGRA8 while the executor's intermediates are RGBA8, and any
  // effect that calls gpu::Device::copy (the is_identity passthroughs —
  // util.dashboard, control.barrel_macros, sketch_output, sidechannel_out)
  // straddles it. So: same channel order → blit (the fast path); different →
  // a compute copy, which reads and writes THROUGH the pixel formats and thus
  // channel-orders both sides correctly.
  void copyTexture(int32_t src, int32_t dst) override {
    id<MTLTexture> s = getAs<id<MTLTexture>>(src);
    id<MTLTexture> d = getAs<id<MTLTexture>>(dst);
    if (!s || !d) return;
    if (!cmdBuffer_) cmdBuffer_ = [queue_ commandBuffer];

    if ([s pixelFormat] != [d pixelFormat]) {
      if (id<MTLComputePipelineState> pso = formatCopyPSO()) {
        const NSUInteger w = std::min([s width], [d width]);
        const NSUInteger h = std::min([s height], [d height]);
        id<MTLComputeCommandEncoder> enc = [cmdBuffer_ computeCommandEncoder];
        [enc setComputePipelineState:pso];
        [enc setTexture:s atIndex:0];
        [enc setTexture:d atIndex:1];
        [enc dispatchThreadgroups:MTLSizeMake((w + 7) / 8, (h + 7) / 8, 1)
            threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
        [enc endEncoding];
        markBound(src);
        markBound(dst);
        return;
      }
      // PSO failed to build: fall through to the blit rather than drop the
      // frame — a channel-swapped image beats a black one, and it's logged.
    }

    id<MTLBlitCommandEncoder> blit = [cmdBuffer_ blitCommandEncoder];
    [blit copyFromTexture:s sourceSlice:0 sourceLevel:0
                sourceOrigin:MTLOriginMake(0, 0, 0)
                  sourceSize:MTLSizeMake([s width], [s height], 1)
                   toTexture:d destinationSlice:0 destinationLevel:0
            destinationOrigin:MTLOriginMake(0, 0, 0)];
    [blit endEncoding];
    markBound(src);
    markBound(dst);
  }

  // Lazily built, then cached for the backend's lifetime.
  id<MTLComputePipelineState> formatCopyPSO() {
    if (formatCopyPso_) return formatCopyPso_;
    NSString* src =
        @"#include <metal_stdlib>\n"
         "using namespace metal;\n"
         "kernel void nano_format_copy(\n"
         "    texture2d<float, access::read>  src [[texture(0)]],\n"
         "    texture2d<float, access::write> dst [[texture(1)]],\n"
         "    uint2 gid [[thread_position_in_grid]]) {\n"
         "  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;\n"
         "  if (gid.x >= src.get_width() || gid.y >= src.get_height()) return;\n"
         "  dst.write(src.read(gid), gid);\n"
         "}\n";
    NSError* err = nil;
    id<MTLLibrary> lib = [device_ newLibraryWithSource:src options:nil error:&err];
    if (!lib) {
      NSLog(@"Metal format-copy library error: %@", err);
      return nil;
    }
    id<MTLFunction> fn = [lib newFunctionWithName:@"nano_format_copy"];
    if (!fn) return nil;
    formatCopyPso_ = [device_ newComputePipelineStateWithFunction:fn error:&err];
    if (!formatCopyPso_) NSLog(@"Metal format-copy PSO error: %@", err);
    return formatCopyPso_;
  }

  int32_t createRenderPSO(int32_t vsHandle, const std::string& vsEntry,
                           int32_t fsHandle, const std::string& fsEntry,
                           int32_t format) override {
    @autoreleasepool {
      id<MTLLibrary> vsLib = getAs<id<MTLLibrary>>(vsHandle);
      id<MTLLibrary> fsLib = getAs<id<MTLLibrary>>(fsHandle);
      if (!vsLib || !fsLib) return -1;

      id<MTLFunction> vsFunc = [vsLib newFunctionWithName:
          [NSString stringWithUTF8String:vsEntry.c_str()]];
      id<MTLFunction> fsFunc = [fsLib newFunctionWithName:
          [NSString stringWithUTF8String:fsEntry.c_str()]];
      if (!vsFunc || !fsFunc) return -1;

      MTLRenderPipelineDescriptor* desc = [[MTLRenderPipelineDescriptor alloc] init];
      desc.vertexFunction = vsFunc;
      desc.fragmentFunction = fsFunc;

      MTLPixelFormat fmt = pixelFormatFromCode(format);
      desc.colorAttachments[0].pixelFormat = fmt;
      desc.colorAttachments[0].blendingEnabled = YES;
      desc.colorAttachments[0].sourceRGBBlendFactor = MTLBlendFactorSourceAlpha;
      desc.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
      desc.colorAttachments[0].sourceAlphaBlendFactor = MTLBlendFactorOne;
      desc.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;

      // Vertex descriptor: float2 pos + float4 color = 24 bytes
      MTLVertexDescriptor* vd = [[MTLVertexDescriptor alloc] init];
      vd.attributes[0].format = MTLVertexFormatFloat2;
      vd.attributes[0].offset = 0;
      vd.attributes[0].bufferIndex = 0;
      vd.attributes[1].format = MTLVertexFormatFloat4;
      vd.attributes[1].offset = 8;
      vd.attributes[1].bufferIndex = 0;
      vd.layouts[0].stride = 24;
      vd.layouts[0].stepFunction = MTLVertexStepFunctionPerVertex;
      desc.vertexDescriptor = vd;

      NSError* error = nil;
      id<MTLRenderPipelineState> pso = [device_ newRenderPipelineStateWithDescriptor:desc error:&error];
      if (!pso) {
        NSLog(@"Metal render PSO error: %@", error);
        return -1;
      }
      return alloc(ResourceType::RenderPSO, pso);
    }
  }

  int32_t createInstancedRenderPSO(int32_t vsHandle, const std::string& vsEntry,
                                    int32_t fsHandle, const std::string& fsEntry,
                                    int32_t format, int32_t blendMode) override {
    @autoreleasepool {
      id<MTLLibrary> vsLib = getAs<id<MTLLibrary>>(vsHandle);
      id<MTLLibrary> fsLib = getAs<id<MTLLibrary>>(fsHandle);
      if (!vsLib || !fsLib) return -1;

      id<MTLFunction> vsFunc = [vsLib newFunctionWithName:
          [NSString stringWithUTF8String:vsEntry.c_str()]];
      id<MTLFunction> fsFunc = [fsLib newFunctionWithName:
          [NSString stringWithUTF8String:fsEntry.c_str()]];
      if (!vsFunc || !fsFunc) return -1;

      MTLPixelFormat fmt = pixelFormatFromCode(format);

      MTLRenderPipelineDescriptor* desc = [[MTLRenderPipelineDescriptor alloc] init];
      desc.vertexFunction = vsFunc;
      desc.fragmentFunction = fsFunc;
      // No vertexDescriptor: the vertex shader synthesizes geometry from
      // [[vertex_id]] / [[instance_id]] + storage buffers (instanced quads).
      desc.colorAttachments[0].pixelFormat = fmt;
      if (blendMode == 2) {  // replace: no blending, fragment overwrites dst
        desc.colorAttachments[0].blendingEnabled = NO;
      } else {
        desc.colorAttachments[0].blendingEnabled = YES;
        desc.colorAttachments[0].sourceRGBBlendFactor = MTLBlendFactorSourceAlpha;
        desc.colorAttachments[0].sourceAlphaBlendFactor = MTLBlendFactorOne;
        if (blendMode == 1) {  // additive: src*src.a + dst
          desc.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOne;
          desc.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOne;
        } else {               // alpha-over: src*src.a + dst*(1 - src.a)
          desc.colorAttachments[0].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
          desc.colorAttachments[0].destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
        }
      }

      NSError* error = nil;
      id<MTLRenderPipelineState> pso = [device_ newRenderPipelineStateWithDescriptor:desc error:&error];
      if (!pso) {
        NSLog(@"Metal instanced render PSO error: %@", error);
        return -1;
      }
      return alloc(ResourceType::RenderPSO, pso);
    }
  }

  int32_t createInstancedRenderPSOMRT(int32_t vsHandle, const std::string& vsEntry,
                                       int32_t fsHandle, const std::string& fsEntry,
                                       int32_t targetCount, const int32_t* targetFormats,
                                       const int32_t* targetBlends) override {
    @autoreleasepool {
      id<MTLLibrary> vsLib = getAs<id<MTLLibrary>>(vsHandle);
      id<MTLLibrary> fsLib = getAs<id<MTLLibrary>>(fsHandle);
      if (!vsLib || !fsLib) return -1;

      id<MTLFunction> vsFunc = [vsLib newFunctionWithName:
          [NSString stringWithUTF8String:vsEntry.c_str()]];
      id<MTLFunction> fsFunc = [fsLib newFunctionWithName:
          [NSString stringWithUTF8String:fsEntry.c_str()]];
      if (!vsFunc || !fsFunc) return -1;

      MTLRenderPipelineDescriptor* desc = [[MTLRenderPipelineDescriptor alloc] init];
      desc.vertexFunction = vsFunc;
      desc.fragmentFunction = fsFunc;
      // One color attachment per target; fragment @location(i) → target i.
      // Per-target blend equation (same 3-mode set as the single-target PSO).
      for (int i = 0; i < targetCount && i < 8; ++i) {
        MTLPixelFormat fmt = pixelFormatFromCode(targetFormats[i]);
        const int32_t blend = targetBlends ? targetBlends[i] : 0;
        desc.colorAttachments[i].pixelFormat = fmt;
        if (blend == 2) {  // replace: fragment output overwrites dst
          desc.colorAttachments[i].blendingEnabled = NO;
          continue;
        }
        desc.colorAttachments[i].blendingEnabled = YES;
        desc.colorAttachments[i].sourceRGBBlendFactor = MTLBlendFactorSourceAlpha;
        desc.colorAttachments[i].sourceAlphaBlendFactor = MTLBlendFactorOne;
        if (blend == 1) {  // additive: src*src.a + dst
          desc.colorAttachments[i].destinationRGBBlendFactor = MTLBlendFactorOne;
          desc.colorAttachments[i].destinationAlphaBlendFactor = MTLBlendFactorOne;
        } else {           // alpha-over
          desc.colorAttachments[i].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
          desc.colorAttachments[i].destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
        }
      }

      NSError* error = nil;
      id<MTLRenderPipelineState> pso = [device_ newRenderPipelineStateWithDescriptor:desc error:&error];
      if (!pso) {
        NSLog(@"Metal MRT render PSO error: %@", error);
        return -1;
      }
      return alloc(ResourceType::RenderPSO, pso);
    }
  }

  // --- Buffer operations ---

  void writeBuffer(int32_t bufHandle, uint32_t offset,
                   const uint8_t* data, uint32_t len) override {
    auto it = resources_.find(bufHandle);
    if (it == resources_.end()) return;
    id<MTLBuffer> buf = (id<MTLBuffer>)it->second.obj;
    if (!buf) return;
    // Version-on-write-after-bind: a CPU write is immediate, but encoded work
    // in the open command buffer executes later — a write to a buffer that
    // already has encoded readers this generation would be seen by ALL of them
    // (last-write-wins; effect-called submit() is a no-op inside the frame
    // batch on native, unlike web where it really flushes). Paper over the
    // platform difference by swapping in a fresh backing buffer: the encoded
    // work keeps the old MTLBuffer (the command buffer retains it), future
    // encodes and this write see the new one. Semantics on both platforms
    // become "each dispatch reads the latest write that preceded its encode".
    if (cmdBuffer_ && it->second.lastBoundGen == encodeGen_) {
      id<MTLBuffer> nb = [device_ newBufferWithLength:[buf length]
                                              options:MTLResourceStorageModeShared];
      if (nb) {
        memcpy([nb contents], [buf contents], [buf length]);
        it->second.obj = nb;
        it->second.lastBoundGen = 0;
        if (versionLogCount_ < 16) {
          NSLog(@"[metal_backend] buffer %d written after being bound to encoded "
                @"GPU work this frame — versioned the backing buffer (%u bytes). "
                @"Prefer one buffer per dispatch.%s",
                bufHandle, (uint32_t)[buf length],
                ++versionLogCount_ == 16 ? " (further notes suppressed)" : "");
        }
        buf = nb;
      }
    }
    memcpy((uint8_t*)[buf contents] + offset, data, len);
  }

  void* bufferContents(int32_t bufHandle) override {
    id<MTLBuffer> buf = getAs<id<MTLBuffer>>(bufHandle);
    return buf ? [buf contents] : nullptr;
  }

  int readBuffer(int32_t bufHandle, uint32_t offset, void* dst, uint32_t len) override {
    id<MTLBuffer> buf = getAs<id<MTLBuffer>>(bufHandle);
    if (!buf || !dst) return 0;
    // A CPU read needs the producing GPU work COMPLETE, not just scheduled. When
    // the last flush only waited for scheduling (the FFGL fast path), block on
    // its completion here — same idiom as readbackTexture.
    if (lastCommitted_) {
      [lastCommitted_ waitUntilCompleted];
      lastCommitted_ = nil;
    }
    if (offset + len > (uint32_t)[buf length]) return 0;
    memcpy(dst, (const uint8_t*)[buf contents] + offset, len);
    return (int)len;
  }

  // --- Compute pass ---

  int32_t beginComputePass() override {
    // Reuse cmdBuffer_ across compute/render/blit passes within a
    // single submit() cycle. Allocating a fresh command buffer per
    // pass would orphan any work already encoded into the previous
    // one (since submit() only commits the *current* cmdBuffer_),
    // which silently drops earlier passes' writes.
    if (!cmdBuffer_) cmdBuffer_ = [queue_ commandBuffer];
    computeEncoder_ = [cmdBuffer_ computeCommandEncoder];
    passBinds_.clear();
    if (debugLog_) NSLog(@"[metal_backend] beginComputePass enc=%p cmd=%p",
                          computeEncoder_, cmdBuffer_);
    return 1;
  }

  void computeSetPSO(int32_t pass, int32_t pso) override {
    (void)pass;
    id<MTLComputePipelineState> p = getAs<id<MTLComputePipelineState>>(pso);
    if (debugLog_) NSLog(@"[metal_backend] setPSO handle=%d pso=%p enc=%p",
                          pso, p, computeEncoder_);
    if (p && computeEncoder_) [computeEncoder_ setComputePipelineState:p];
    currentComputePSO_ = p;
    auto it = psoThreadgroup_.find(pso);
    currentComputeThreadgroup_ =
        (it != psoThreadgroup_.end()) ? it->second : MTLSizeMake(8, 8, 1);
  }

  void computeSetBuffer(int32_t pass, int32_t buf, uint32_t offset, int32_t slot) override {
    (void)pass;
    id<MTLBuffer> b = getAs<id<MTLBuffer>>(buf);
    if (debugLog_) NSLog(@"[metal_backend] setBuffer handle=%d slot=%d buf=%p",
                          buf, slot, b);
    if (b && computeEncoder_) {
      [computeEncoder_ setBuffer:b offset:offset atIndex:slot];
      passBinds_.push_back(buf);
    }
  }

  void computeSetTexture(int32_t pass, int32_t textureHandle, int32_t slot, int32_t access) override {
    (void)pass; (void)access;
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (debugLog_) NSLog(@"[metal_backend] setTexture handle=%d slot=%d tex=%p w=%lu h=%lu fmt=%lu",
                          textureHandle, slot, tex,
                          tex ? (unsigned long)[tex width] : 0,
                          tex ? (unsigned long)[tex height] : 0,
                          tex ? (unsigned long)[tex pixelFormat] : 0);
    if (tex && computeEncoder_) {
      [computeEncoder_ setTexture:tex atIndex:slot];
      passBinds_.push_back(textureHandle);
    }
  }

  void computeDispatch(int32_t pass, uint32_t x, uint32_t y, uint32_t z) override {
    (void)pass;
    if (debugLog_) NSLog(@"[metal_backend] dispatch %ux%ux%u enc=%p pso=%p",
                          x, y, z, computeEncoder_, currentComputePSO_);
    if (!computeEncoder_ || !currentComputePSO_) {
      if (debugLog_) NSLog(@"[metal_backend] dispatch SKIPPED (enc=%p pso=%p)",
                            computeEncoder_, currentComputePSO_);
      return;
    }
    // Threads-per-group must match the shader's [numthreads(...)]. MSL
    // doesn't encode it, so it rides along as a `// nano_threadgroup:` hint
    // (spvToMsl) parsed into per-PSO sizes; computeSetPSO binds the current
    // one here. Defaults to 8×8×1 for raw-MSL kernels with no hint.
    MTLSize threadsPerGroup = currentComputeThreadgroup_;
    MTLSize threadgroups = MTLSizeMake(x, y, z);
    [computeEncoder_ dispatchThreadgroups:threadgroups threadsPerThreadgroup:threadsPerGroup];
    // Only NOW are the pass's bindings actually read by encoded work — marking
    // at bind time would falsely version the legit set→write→dispatch order.
    for (int32_t h : passBinds_) markBound(h);
  }

  void computeDispatchIndirect(int32_t pass, int32_t argsBuf,
                               uint64_t offset) override {
    (void)pass;
    id<MTLBuffer> args = getAs<id<MTLBuffer>>(argsBuf);
    if (!computeEncoder_ || !currentComputePSO_ || !args) return;
    // Args layout = MTLDispatchThreadgroupsIndirectArguments (3 × u32
    // threadgroup counts) — identical to WebGPU's dispatchWorkgroupsIndirect.
    [computeEncoder_ dispatchThreadgroupsWithIndirectBuffer:args
                                       indirectBufferOffset:(NSUInteger)offset
                                      threadsPerThreadgroup:currentComputeThreadgroup_];
    markBound(argsBuf);
    for (int32_t h : passBinds_) markBound(h);
  }

  void endComputePass(int32_t pass) override {
    (void)pass;
    if (computeEncoder_) {
      [computeEncoder_ endEncoding];
      computeEncoder_ = nil;
      currentComputePSO_ = nil;
      passBinds_.clear();
    }
  }

  // --- Render pass ---

  int32_t beginRenderPass(int32_t textureHandle,
                           float cr, float cg, float cb, float ca) override {
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (!tex) return -1;
    // Reuse cmdBuffer_ — see beginComputePass for the reasoning.
    if (!cmdBuffer_) cmdBuffer_ = [queue_ commandBuffer];

    MTLRenderPassDescriptor* desc = [MTLRenderPassDescriptor renderPassDescriptor];
    desc.colorAttachments[0].texture = tex;
    desc.colorAttachments[0].loadAction = MTLLoadActionClear;
    desc.colorAttachments[0].storeAction = MTLStoreActionStore;
    desc.colorAttachments[0].clearColor = MTLClearColorMake(cr, cg, cb, ca);

    renderEncoder_ = [cmdBuffer_ renderCommandEncoderWithDescriptor:desc];
    passBinds_.clear();
    markBound(textureHandle);   // the clear/store writes it even with no draws
    return 1;
  }

  int32_t beginRenderPassLoad(int32_t textureHandle) override {
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (!tex) return -1;
    if (!cmdBuffer_) cmdBuffer_ = [queue_ commandBuffer];

    MTLRenderPassDescriptor* desc = [MTLRenderPassDescriptor renderPassDescriptor];
    desc.colorAttachments[0].texture = tex;
    desc.colorAttachments[0].loadAction = MTLLoadActionLoad;   // keep existing pixels
    desc.colorAttachments[0].storeAction = MTLStoreActionStore;

    renderEncoder_ = [cmdBuffer_ renderCommandEncoderWithDescriptor:desc];
    passBinds_.clear();
    markBound(textureHandle);
    return 1;
  }

  int32_t beginRenderPassMRT(int32_t count, const int32_t* texHandles,
                             const float* clears, const int32_t* loads) override {
    if (count <= 0) return -1;
    if (!cmdBuffer_) cmdBuffer_ = [queue_ commandBuffer];
    MTLRenderPassDescriptor* desc = [MTLRenderPassDescriptor renderPassDescriptor];
    for (int i = 0; i < count && i < 8; ++i) {
      id<MTLTexture> tex = getAs<id<MTLTexture>>(texHandles[i]);
      if (!tex) return -1;
      desc.colorAttachments[i].texture = tex;
      desc.colorAttachments[i].loadAction =
          (loads && loads[i]) ? MTLLoadActionLoad : MTLLoadActionClear;
      desc.colorAttachments[i].storeAction = MTLStoreActionStore;
      desc.colorAttachments[i].clearColor = MTLClearColorMake(
          clears[i * 4 + 0], clears[i * 4 + 1],
          clears[i * 4 + 2], clears[i * 4 + 3]);
    }
    renderEncoder_ = [cmdBuffer_ renderCommandEncoderWithDescriptor:desc];
    return 1;
  }

  void renderSetPSO(int32_t pass, int32_t pso) override {
    (void)pass;
    id<MTLRenderPipelineState> p = getAs<id<MTLRenderPipelineState>>(pso);
    if (p && renderEncoder_) [renderEncoder_ setRenderPipelineState:p];
  }

  void renderSetVertexBuffer(int32_t pass, int32_t buf,
                             uint32_t offset, int32_t slot) override {
    (void)pass;
    id<MTLBuffer> b = getAs<id<MTLBuffer>>(buf);
    if (b && renderEncoder_) {
      [renderEncoder_ setVertexBuffer:b offset:offset atIndex:slot];
      passBinds_.push_back(buf);
    }
  }

  void renderSetBuffer(int32_t pass, int32_t buf, int32_t slot) override {
    (void)pass;
    id<MTLBuffer> b = getAs<id<MTLBuffer>>(buf);
    if (!b || !renderEncoder_) return;
    // WGSL bind groups are stage-unified; bind to both Metal stage tables
    // so [[buffer(slot)]] resolves whether the vertex or fragment shader
    // reads it. Unused bindings on a stage are harmless.
    [renderEncoder_ setVertexBuffer:b offset:0 atIndex:slot];
    [renderEncoder_ setFragmentBuffer:b offset:0 atIndex:slot];
    passBinds_.push_back(buf);
  }

  void renderSetTexture(int32_t pass, int32_t textureHandle, int32_t slot,
                        int32_t access) override {
    (void)pass; (void)access;
    id<MTLTexture> t = getAs<id<MTLTexture>>(textureHandle);
    if (t && renderEncoder_) {
      [renderEncoder_ setFragmentTexture:t atIndex:slot];
      passBinds_.push_back(textureHandle);
    }
  }

  void renderSetSampler(int32_t pass, int32_t samplerHandle, int32_t slot) override {
    (void)pass;
    id<MTLSamplerState> s = getAs<id<MTLSamplerState>>(samplerHandle);
    if (s && renderEncoder_) [renderEncoder_ setFragmentSamplerState:s atIndex:slot];
  }

  void renderDraw(int32_t pass, uint32_t vertexCount, uint32_t instanceCount) override {
    (void)pass;
    if (!renderEncoder_) return;
    [renderEncoder_ drawPrimitives:MTLPrimitiveTypeTriangle
                       vertexStart:0
                       vertexCount:vertexCount
                     instanceCount:instanceCount];
    for (int32_t h : passBinds_) markBound(h);   // see computeDispatch
  }

  void renderDrawIndirect(int32_t pass, int32_t argsBuf, uint64_t offset) override {
    (void)pass;
    id<MTLBuffer> args = getAs<id<MTLBuffer>>(argsBuf);
    if (!renderEncoder_ || !args) return;
    // Args layout = MTLDrawPrimitivesIndirectArguments (4 × u32: vertexCount,
    // instanceCount, vertexStart, baseInstance) — identical to WebGPU's
    // drawIndirect.
    [renderEncoder_ drawPrimitives:MTLPrimitiveTypeTriangle
                    indirectBuffer:args
              indirectBufferOffset:(NSUInteger)offset];
    markBound(argsBuf);
    for (int32_t h : passBinds_) markBound(h);
  }

  void endRenderPass(int32_t pass) override {
    (void)pass;
    if (renderEncoder_) {
      [renderEncoder_ endEncoding];
      renderEncoder_ = nil;
      passBinds_.clear();
    }
  }

  // --- Submit ---

  void beginSubmitBatch() override { deferSubmit_ = true; }
  void endSubmitBatch() override {
    deferSubmit_ = false;
    if (!cmdBuffer_) return;
    // Error logging for the scheduled-only path must be registered BEFORE
    // commit (addCompletedHandler asserts otherwise); the blocking path checks
    // status synchronously instead.
    if (!waitCompleted_) attachErrorLogger(cmdBuffer_);
    [cmdBuffer_ commit];
    // The FFGL host consumes this frame's output through an IOSurface-backed
    // GL texture. On a single GPU the driver orders cross-API IOSurface access
    // by SUBMISSION, so the host's GL blit that reads our output only needs the
    // command buffer SCHEDULED (enqueued on the GPU), not finished — the host's
    // glFlush around the GL blit completes the cross-API ordering.
    // waitUntilScheduled returns the instant the buffer is queued, so the render
    // thread (Resolume's) overlaps with the GPU instead of parking on the whole
    // chain's execution. CPU pixel consumers (test/preview readback) can't rely
    // on scheduling alone, so readbackTexture() waits on lastCommitted_.
    // (Override with NANO_WAIT_COMPLETED to A/B against the old blocking flush.)
    if (waitCompleted_) {
      [cmdBuffer_ waitUntilCompleted];
      logCmdBufferError(cmdBuffer_);
      lastCommitted_ = nil;
    } else {
      [cmdBuffer_ waitUntilScheduled];
      lastCommitted_ = cmdBuffer_;
    }
    cmdBuffer_ = nil;
    ++encodeGen_;   // binds recorded against the committed buffer are no longer hazards
  }

  void submit() override {
    // Inside a host submit-batch, defer: every effect's render() calls submit()
    // expecting a flush, but we accumulate all of their encoders into one
    // command buffer (the queue is serial + Metal hazard-tracks within a buffer,
    // so stage N+1 correctly reads stage N's output) and commit once at
    // endSubmitBatch() instead of blocking per stage.
    if (deferSubmit_) return;
    if (cmdBuffer_) {
      // Standalone submit (no host batch open): keep the blocking flush — the
      // caller may be a test / tool that reads pixels back right after.
      [cmdBuffer_ commit];
      [cmdBuffer_ waitUntilCompleted];
      logCmdBufferError(cmdBuffer_);
      lastCommitted_ = nil;
      cmdBuffer_ = nil;
      ++encodeGen_;
    }
  }

  // Synchronous error check (call after waitUntilCompleted). A Metal validation
  // failure during dispatch (binding mismatch, dead PSO) commits silently and
  // leaves status==Error with no other signal — the dispatch just doesn't
  // write, producing black output — so surface it loudly.
  static void logCmdBufferError(id<MTLCommandBuffer> cb) {
    if ([cb status] == MTLCommandBufferStatusError) {
      NSError* err = [cb error];
      NSLog(@"[metal_backend] command buffer FAILED: %@",
            err ? [err localizedDescription] : @"(unknown)");
    }
  }
  // Async equivalent for the scheduled-only path, where status isn't known
  // until the GPU finishes well after we've returned to the caller.
  static void attachErrorLogger(id<MTLCommandBuffer> cb) {
    [cb addCompletedHandler:^(id<MTLCommandBuffer> done) {
      if ([done status] == MTLCommandBufferStatusError) {
        NSError* err = [done error];
        NSLog(@"[metal_backend] command buffer FAILED (async): %@",
              err ? [err localizedDescription] : @"(unknown)");
      }
    }];
  }

  // --- Surface ---

  void setSurface(int32_t textureHandle, uint32_t w, uint32_t h) override {
    surfaceHandle_ = textureHandle;
    surfaceW_ = w;
    surfaceH_ = h;
    // Determine format from texture
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (tex) surfaceFormat_ = [tex pixelFormat];
  }

  int32_t getSurfaceTexture() override { return surfaceHandle_; }
  int32_t getSurfaceWidth() override { return surfaceW_; }
  int32_t getSurfaceHeight() override { return surfaceH_; }

  int32_t getTextureWidth(int32_t textureHandle) override {
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    return tex ? (int32_t)[tex width] : 0;
  }
  int32_t getTextureHeight(int32_t textureHandle) override {
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    return tex ? (int32_t)[tex height] : 0;
  }
  int32_t getTextureFormat(int32_t textureHandle) override {
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (!tex) return -1;
    switch ([tex pixelFormat]) {
      case MTLPixelFormatBGRA8Unorm:      return 0;
      case MTLPixelFormatRGBA8Unorm:      return 1;
      case MTLPixelFormatRGBA16Float:     return 3;
      case MTLPixelFormatR32Float:        return 4;
      case MTLPixelFormatRGBA32Float:     return 5;
      // sRGB variants report code 7 like the web host — a missing case here
      // made Device::textureFormat() call an sRGB texture plain RGBA8 on
      // native only (a decode/encode-skipping divergence for any effect that
      // branches on precision/encoding).
      case MTLPixelFormatRGBA8Unorm_sRGB: return 7;
      case MTLPixelFormatBGRA8Unorm_sRGB: return 7;
      default:                            return 1;
    }
  }

  // --- Readback ---

  std::vector<uint8_t> readbackTexture(int32_t textureHandle,
                                        uint32_t w, uint32_t h) override {
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (!tex) return {};

    // getBytes is a CPU read — it needs the producing GPU work COMPLETE, not
    // just scheduled. When the last frame flush only waited for scheduling
    // (the FFGL fast path), block on its completion here.
    if (lastCommitted_) {
      [lastCommitted_ waitUntilCompleted];
      lastCommitted_ = nil;
    }

    std::vector<uint8_t> pixels(w * h * 4);
    [tex getBytes:pixels.data()
      bytesPerRow:w * 4
       fromRegion:MTLRegionMake2D(0, 0, w, h)
      mipmapLevel:0];
    return pixels;
  }

  std::vector<uint8_t> readbackTextureScaled(int32_t textureHandle,
                                              uint32_t srcW, uint32_t srcH,
                                              uint32_t dstW, uint32_t dstH) override {
    id<MTLTexture> src = getAs<id<MTLTexture>>(textureHandle);
    if (!src || dstW == 0 || dstH == 0) return {};

    // Fast path: same size — skip the scaler, getBytes directly. Also
    // covers any caller that wants a copy without resampling.
    if (srcW == dstW && srcH == dstH) {
      return readbackTexture(textureHandle, dstW, dstH);
    }

    @autoreleasepool {
      id<MTLTexture> dst = getOrCreateScratchScaleTarget(dstW, dstH);
      if (!dst) return {};

      if (!scaler_) {
        scaler_ = [[MPSImageLanczosScale alloc] initWithDevice:device_];
      }

      // Use a dedicated command buffer so this doesn't tangle with
      // mid-frame encoders the caller may still be building. The barrel
      // calls this AFTER its main submit(), so cmdBuffer_ is nil here in
      // practice; on a fresh buffer we don't have to care either way.
      id<MTLCommandBuffer> cb = [queue_ commandBuffer];
      [scaler_ encodeToCommandBuffer:cb
                       sourceTexture:src
                  destinationTexture:dst];
      [cb commit];
      [cb waitUntilCompleted];

      std::vector<uint8_t> pixels((size_t)dstW * dstH * 4);
      [dst getBytes:pixels.data()
        bytesPerRow:dstW * 4
         fromRegion:MTLRegionMake2D(0, 0, dstW, dstH)
        mipmapLevel:0];
      return pixels;
    }
  }

  void readbackTextureScaledAsync(
      int32_t textureHandle,
      uint32_t srcW, uint32_t srcH,
      uint32_t dstW, uint32_t dstH,
      std::function<void(const uint8_t*, size_t)> callback) override {
    id<MTLTexture> src = getAs<id<MTLTexture>>(textureHandle);
    if (!src || dstW == 0 || dstH == 0 || !callback) return;

    @autoreleasepool {
      id<MTLTexture> dst = nextAsyncScratchScaleTarget(dstW, dstH);
      if (!dst) return;
      if (!scaler_) {
        scaler_ = [[MPSImageLanczosScale alloc] initWithDevice:device_];
      }

      // If a batch is open, encode into the shared cmd buffer and
      // accumulate the (dst, callback) pair so commitPreviewBatch can
      // service them all from one completion handler. Otherwise fall
      // back to the per-call cmd buffer (legacy behavior).
      if (async_batch_cb_) {
        [scaler_ encodeToCommandBuffer:async_batch_cb_
                         sourceTexture:src
                    destinationTexture:dst];
        id<MTLBuffer> buf = encodeReadbackBlit(async_batch_cb_, dst, dstW, dstH);
        async_batch_pending_.push_back({dst, buf, dstW, dstH, std::move(callback)});
        return;
      }

      id<MTLCommandBuffer> cb = [queue_ commandBuffer];
      [scaler_ encodeToCommandBuffer:cb
                       sourceTexture:src
                  destinationTexture:dst];
      id<MTLBuffer> buf = encodeReadbackBlit(cb, dst, dstW, dstH);

      // The completed handler runs on Metal's per-queue SERIAL completion
      // dispatch queue — the same queue that retires every command buffer
      // on queue_. Doing the pixel copy + consumer callback there stalled
      // command-buffer retirement behind megabytes of memcpy, which blocked
      // the render thread's next waitUntilScheduled for >100ms per preview
      // tick (the "editor open tanks Resolume FPS" bug). The handler now
      // only hops to our own serial readback queue; Metal's completion
      // queue is released in microseconds. `dst`/`buf` stay valid: the
      // block retains them (ARC) and the scratch ring won't re-encode them
      // for kAsyncPoolRing batches.
      __block auto cb_callback = std::move(callback);
      [cb addCompletedHandler:^(id<MTLCommandBuffer> finished) {
        if ([finished status] == MTLCommandBufferStatusError) return;
        dispatch_async(previewReadbackQueue(), ^{
          const size_t byteCount = (size_t)dstW * dstH * 4;
          if (buf) {
            cb_callback((const uint8_t*)[buf contents], byteCount);
          } else {
            std::vector<uint8_t> pixels(byteCount);
            [dst getBytes:pixels.data()
              bytesPerRow:dstW * 4
               fromRegion:MTLRegionMake2D(0, 0, dstW, dstH)
              mipmapLevel:0];
            cb_callback(pixels.data(), byteCount);
          }
        });
      }];
      [cb commit];
    }
  }

  void beginPreviewBatch() override {
    if (async_batch_cb_) return;  // already open — defensive
    // ARC: the strong async_batch_cb_ member retains the cmd buffer, so it
    // outlives any autoreleasepool drain between begin and commit. Cleared
    // (released) in commitPreviewBatch.
    async_batch_cb_ = [queue_ commandBuffer];
    // Ring: this batch uses the next pool. Within the batch, the cursor
    // walks 0..N as readbacks are added; the pool grows on demand. The
    // other ring slots were used by the previous batches and their
    // readbacks may still be pending on previewReadbackQueue(), so we
    // don't touch them.
    async_batch_pool_index_ = (async_batch_pool_index_ + 1) % kAsyncPoolRing;
    for (auto& [_, set] : asyncScaleScratchPools_) {
      set.pools[async_batch_pool_index_].cursor = 0;
    }
    for (auto& [_, set] : asyncReadbackBufferPools_) {
      set.pools[async_batch_pool_index_].cursor = 0;
    }
  }

  void drainPreviewReadbacks() override {
    if (preview_readback_queue_) {
      dispatch_sync(preview_readback_queue_, ^{});
    }
  }

  void commitPreviewBatch() override {
    if (!async_batch_cb_) return;
    if (async_batch_pending_.empty()) {
      // Nothing to do — drop the cmd buffer (ARC releases).
      async_batch_cb_ = nil;
      return;
    }
    @autoreleasepool {
      // Hand the pending records to the block by move. The shared_ptr
      // wrapper is so the block can hold them without slicing or
      // copying the std::function members.
      auto pending = std::make_shared<std::vector<BatchPendingReadback>>(
          std::move(async_batch_pending_));
      async_batch_pending_.clear();
      id<MTLCommandBuffer> cb = async_batch_cb_;
      async_batch_cb_ = nil;
      // Completed handlers run on Metal's per-queue SERIAL completion
      // dispatch queue — the same one that retires EVERY command buffer on
      // queue_. Keep it free: hop the readbacks (getBytes memcpy + consumer
      // callbacks, megabytes for a large edit preview) onto our own serial
      // queue. Doing them inline here backed up command-buffer retirement
      // and stalled the render thread's next waitUntilScheduled >100ms per
      // preview tick. Our queue is serial → batches drain in commit order,
      // so the send-side latest-wins logic never sees stale-after-fresh.
      // NANO_PREVIEW_TS: latency-diagnosis logging (see barrel_runtime.mm).
      // Splits the encode→pixels-on-CPU span into GPU/scheduling vs memcpy.
      static const bool kPreviewTsLog = [] {
        const char* e = getenv("NANO_PREVIEW_TS");
        return e && *e && strcmp(e, "0") != 0;
      }();
      const double tCommit = kPreviewTsLog
          ? std::chrono::duration<double, std::milli>(
                std::chrono::system_clock::now().time_since_epoch()).count()
          : 0.0;
      [cb addCompletedHandler:^(id<MTLCommandBuffer> finished) {
        if ([finished status] == MTLCommandBufferStatusError) return;
        const double tDone = kPreviewTsLog
            ? std::chrono::duration<double, std::milli>(
                  std::chrono::system_clock::now().time_since_epoch()).count()
            : 0.0;
        dispatch_async(previewReadbackQueue(), ^{
          const auto nowMs = [] {
            return std::chrono::duration<double, std::milli>(
                std::chrono::system_clock::now().time_since_epoch()).count();
          };
          const double tHop = kPreviewTsLog ? nowMs() : 0.0;
          std::vector<uint8_t> staging;  // only for the no-buffer fallback
          for (auto& p : *pending) {
            const size_t byteCount = (size_t)p.dstW * p.dstH * 4;
            const double ti0 = kPreviewTsLog ? nowMs() : 0.0;
            if (p.buf) {
              p.callback((const uint8_t*)[p.buf contents], byteCount);
            } else {
              staging.resize(byteCount);
              [p.dst getBytes:staging.data()
                  bytesPerRow:p.dstW * 4
                   fromRegion:MTLRegionMake2D(0, 0, p.dstW, p.dstH)
                  mipmapLevel:0];
              p.callback(staging.data(), byteCount);
            }
            if (kPreviewTsLog && byteCount > 1000000) {
              fprintf(stderr,
                  "[preview_ts] item %ux%u buf=%d cb %.2f ms\n",
                  p.dstW, p.dstH, p.buf ? 1 : 0, nowMs() - ti0);
            }
          }
          if (kPreviewTsLog) {
            fprintf(stderr,
                "[preview_ts] batch n=%zu gpu+sched %.2f ms, queue-hop %.2f ms, "
                "copy+cb %.2f ms\n",
                pending->size(), tDone - tCommit, tHop - tDone, nowMs() - tHop);
          }
        });
      }];
      [cb commit];
      // ARC: `cb` (local strong) and the Metal queue both held refs; the
      // queue keeps its own until completion, ARC drops ours at scope end.
    }
  }

private:
  // Reuse a single scratch texture per destination size across frames
  // (used by the SYNC readback path — sender waits for completion, so
  // one scratch per size is safe).
  id<MTLTexture> getOrCreateScratchScaleTarget(uint32_t w, uint32_t h) {
    uint64_t key = ((uint64_t)w << 32) | (uint64_t)h;
    auto it = scaleScratchTextures_.find(key);
    if (it != scaleScratchTextures_.end()) return it->second;

    MTLTextureDescriptor* desc = [[MTLTextureDescriptor alloc] init];
    desc.width = w;
    desc.height = h;
    desc.pixelFormat = MTLPixelFormatRGBA8Unorm;
    desc.usage = MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead;
    desc.storageMode = MTLStorageModeShared;
    id<MTLTexture> tex = [device_ newTextureWithDescriptor:desc];
    if (!tex) return nil;
    scaleScratchTextures_[key] = tex;
    return tex;
  }

  // For the ASYNC readback path we need scratch textures that:
  //   (a) don't alias within a single batched cmd buffer (multiple
  //       readbacks of the same dest size in one frame must each write
  //       a distinct texture, or the completion handler sees only the
  //       last write's pixels in every record), and
  //   (b) don't get overwritten by the NEXT frame's encode while the
  //       PREVIOUS frame's completion handler is still calling
  //       getBytes on them.
  //
  // We use a ring of pools per (w,h): each batch picks the next pool,
  // grows it on demand within the batch (so case (a) is impossible), and
  // resets its cursor for the next time that pool comes around. The
  // consumption (getBytes) now runs on previewReadbackQueue() a hop after
  // the completion handler, so it can lag the encode by a batch or two —
  // the ring is sized so a pool isn't re-encoded until kAsyncPoolRing
  // preview ticks later (~100ms at 30 Hz).
  struct AsyncScratchPool {
    std::vector<id<MTLTexture>> textures;
    size_t cursor = 0;
  };
  static constexpr size_t kAsyncPoolRing = 4;
  struct AsyncScratchPoolSet {
    AsyncScratchPool pools[kAsyncPoolRing];
  };
  // Linear readback buffers, same ring discipline as the scratch textures
  // (keyed by byte size). The scale result is blitted into one of these on
  // the GPU, so the CPU side is a plain memcpy from shared memory instead of
  // [MTLTexture getBytes] — which detiles the texture at ~140MB/s and was the
  // single largest stage of preview latency (~38-50ms for a 7MB frame).
  struct AsyncBufferPool {
    std::vector<id<MTLBuffer>> buffers;
    size_t cursor = 0;
  };
  struct AsyncBufferPoolSet {
    AsyncBufferPool pools[kAsyncPoolRing];
  };
  size_t async_batch_pool_index_ = 0;
  // Serial worker for preview readbacks — keeps heavyweight memcpys off
  // Metal's completion queue (see commitPreviewBatch). Lazy: most backend
  // instances (tests, web parity) never read back previews.
  dispatch_queue_t preview_readback_queue_ = nullptr;
  dispatch_queue_t previewReadbackQueue() {
    if (!preview_readback_queue_) {
      preview_readback_queue_ = dispatch_queue_create(
          "nano.preview.readback", DISPATCH_QUEUE_SERIAL);
    }
    return preview_readback_queue_;
  }
  id<MTLTexture> nextAsyncScratchScaleTarget(uint32_t w, uint32_t h) {
    uint64_t key = ((uint64_t)w << 32) | (uint64_t)h;
    auto& pool = asyncScaleScratchPools_[key]
                    .pools[async_batch_pool_index_];
    if (pool.cursor >= pool.textures.size()) {
      MTLTextureDescriptor* desc = [[MTLTextureDescriptor alloc] init];
      desc.width = w;
      desc.height = h;
      desc.pixelFormat = MTLPixelFormatRGBA8Unorm;
      desc.usage = MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead;
      desc.storageMode = MTLStorageModeShared;
      id<MTLTexture> t = [device_ newTextureWithDescriptor:desc];
      if (!t) return nil;
      pool.textures.push_back(t);
    }
    return pool.textures[pool.cursor++];
  }

  id<MTLBuffer> nextAsyncReadbackBuffer(size_t bytes) {
    auto& pool = asyncReadbackBufferPools_[(uint64_t)bytes]
                    .pools[async_batch_pool_index_];
    if (pool.cursor >= pool.buffers.size()) {
      id<MTLBuffer> b = [device_ newBufferWithLength:bytes
                                             options:MTLResourceStorageModeShared];
      if (!b) return nil;
      pool.buffers.push_back(b);
    }
    return pool.buffers[pool.cursor++];
  }

  // Encode a GPU blit of `tex` into a pooled linear buffer on `cb`. The GPU
  // handles detiling; the completion side memcpys from buffer contents.
  // Returns nil if the buffer allocation failed (caller falls back to
  // getBytes on the texture).
  id<MTLBuffer> encodeReadbackBlit(id<MTLCommandBuffer> cb, id<MTLTexture> tex,
                                   uint32_t w, uint32_t h) {
    id<MTLBuffer> buf = nextAsyncReadbackBuffer((size_t)w * h * 4);
    if (!buf) return nil;
    id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
    [blit copyFromTexture:tex
              sourceSlice:0
              sourceLevel:0
             sourceOrigin:MTLOriginMake(0, 0, 0)
               sourceSize:MTLSizeMake(w, h, 1)
                 toBuffer:buf
        destinationOffset:0
   destinationBytesPerRow:(NSUInteger)w * 4
 destinationBytesPerImage:(NSUInteger)w * 4 * h];
    [blit endEncoding];
    return buf;
  }

public:

  // --- Upload ---

  void writeTexture(int32_t textureHandle,
                    uint32_t w, uint32_t h,
                    const uint8_t* bytes, uint32_t byteCount) override {
    auto rit = resources_.find(textureHandle);
    id<MTLTexture> tex = rit != resources_.end() ? (id<MTLTexture>)rit->second.obj : nil;
    if (!tex || !bytes) return;
    if (byteCount < w * h * 4) return;
    // Same hazard writeBuffer versions away, but shadowing a texture is too
    // expensive to do silently — warn instead (last-write-wins: every encoded
    // reader this frame sees THIS upload, not the one preceding its encode).
    if (cmdBuffer_ && rit->second.lastBoundGen == encodeGen_ && versionLogCount_ < 16) {
      NSLog(@"[metal_backend] WARNING: texture %d rewritten after being bound to "
            @"encoded GPU work this frame — earlier encodes will read the NEW "
            @"pixels (last-write-wins). Upload to a fresh texture instead.%s",
            textureHandle,
            ++versionLogCount_ == 16 ? " (further notes suppressed)" : "");
    }
    [tex replaceRegion:MTLRegionMake2D(0, 0, w, h)
           mipmapLevel:0
             withBytes:bytes
           bytesPerRow:w * 4];
  }

  int32_t adoptExternalTexture(void* nativeTexture) override {
    // The caller hands us an id<MTLTexture> (cast through void*). We
    // store it in the resource table the same way locally-allocated
    // textures live. Effects' setTexture/textureForField calls then
    // bind this exact MTLTexture — no copy, the interop's pixels are
    // both read and written directly through the pipeline.
    if (!nativeTexture) return -1;
    id<MTLTexture> tex = (__bridge id<MTLTexture>)nativeTexture;
    return alloc(ResourceType::Texture, tex);
  }

  // --- Cleanup ---

  void release(int32_t handle) override {
    resources_.erase(handle);
  }

  int32_t liveResourceCount() const override {
    return (int32_t)resources_.size();
  }

private:
  int32_t alloc(ResourceType type, id obj) {
    int32_t h = nextHandle_++;
    resources_[h] = {type, obj};
    return h;
  }

  template <typename T>
  T getAs(int32_t handle) {
    auto it = resources_.find(handle);
    if (it == resources_.end()) return nil;
    return (T)it->second.obj;
  }

  // Record that `handle` was bound into the currently-open command buffer
  // (encode generation). writeBuffer versions on a write after this;
  // writeTexture warns.
  void markBound(int32_t handle) {
    auto it = resources_.find(handle);
    if (it != resources_.end()) it->second.lastBoundGen = encodeGen_;
  }

  id<MTLDevice> device_;
  id<MTLCommandQueue> queue_;
  std::map<int32_t, Resource> resources_;
  int32_t nextHandle_ = 1;
  // Bumped whenever the open command buffer is committed; a resource whose
  // lastBoundGen equals the current gen has encoded-but-uncommitted readers.
  uint64_t encodeGen_ = 1;
  int versionLogCount_ = 0;
  // Handles bound in the currently-open pass; marked as hazards only at
  // dispatch/draw (when encoded work actually reads them).
  std::vector<int32_t> passBinds_;

  MTLPixelFormat surfaceFormat_ = MTLPixelFormatRGBA8Unorm;
  int32_t surfaceHandle_ = -1;
  int32_t surfaceW_ = 0, surfaceH_ = 0;

  id<MTLCommandBuffer> cmdBuffer_ = nil;
  id<MTLComputeCommandEncoder> computeEncoder_ = nil;
  id<MTLComputePipelineState> formatCopyPso_ = nil;  // lazy; see copyTexture
  id<MTLComputePipelineState> currentComputePSO_ = nil;
  // Threads-per-threadgroup of the bound compute PSO (Metal supplies this at
  // dispatch, not from the shader). Defaults to 8×8×1 so raw-MSL kernels with
  // no `// nano_threadgroup:` hint behave as before.
  MTLSize currentComputeThreadgroup_ = MTLSizeMake(8, 8, 1);
  id<MTLRenderCommandEncoder> renderEncoder_ = nil;

  // When true (host opened a submit-batch), submit() defers — encoders pile
  // into one command buffer committed once at endSubmitBatch().
  bool deferSubmit_ = false;
  // endSubmitBatch waits only for SCHEDULING (GL consumes the output via
  // IOSurface, ordered by submission) unless this is set — forced on by
  // NANO_WAIT_COMPLETED for A/B benchmarking against the old blocking flush.
  bool waitCompleted_ = getenv("NANO_WAIT_COMPLETED") != nullptr;
  // Last command buffer committed scheduled-only; a CPU pixel consumer
  // (readbackTexture) waits on this for completion before getBytes. Nil once
  // a blocking flush has already guaranteed completion.
  id<MTLCommandBuffer> lastCommitted_ = nil;

  // Bilinear downscale used by readbackTextureScaled. Lazily created so
  // backends that never preview pay nothing.
  // Lanczos, not bilinear: previews are a ~15x linear minification (1920x1080 ->
  // 128x72), and a 2x2 bilinear tap at that ratio reads 4 of every ~225 source
  // texels — i.e. it degenerates to point sampling and pixel-level noise aliases
  // straight through. Lanczos is a windowed filter that actually integrates the
  // footprint. Same encodeToCommandBuffer: API, so it's a drop-in.
  MPSImageLanczosScale* scaler_ = nil;
  // Destination textures keyed by ((w << 32) | h). Read+write-only;
  // never published through `resources_` because no caller outside this
  // class needs handles to them. Sync-path uses one scratch per size;
  // async-path needs a small per-size pool so a frame's completion
  // handler doesn't race the next frame's encode.
  std::unordered_map<uint64_t, id<MTLTexture>> scaleScratchTextures_;
  std::unordered_map<uint64_t, AsyncScratchPoolSet> asyncScaleScratchPools_;
  std::unordered_map<uint64_t, AsyncBufferPoolSet> asyncReadbackBufferPools_;

  // Preview-batch state. When beginPreviewBatch opens a cmd buffer all
  // subsequent readbackTextureScaledAsync calls encode into it; the
  // matching commitPreviewBatch drains the per-call records through a
  // single completion handler. Strictly render-thread only.
  struct BatchPendingReadback {
    id<MTLTexture> dst;
    id<MTLBuffer> buf;   // linear GPU-blitted copy; nil → getBytes fallback
    uint32_t dstW, dstH;
    std::function<void(const uint8_t*, size_t)> callback;
  };
  id<MTLCommandBuffer> async_batch_cb_ = nil;
  std::vector<BatchPendingReadback> async_batch_pending_;

  // Per-shader spec-constant metadata: name → (numeric index, MSL type).
  // Populated by createShaderModule by scanning the MSL source so
  // createComputePSOWithConstants can both set by INDEX (spirv-cross
  // emits `[[function_constant(N)]]`, not named entries Metal can find
  // via setConstantValue:withName:) AND with the right MTLDataType
  // (uint vs int — types are mixed across motion_blur's constants).
  struct ConstInfo { int index; MTLDataType type; };
  std::map<int32_t, std::map<std::string, ConstInfo>> shaderConstIndices_;

  // Per-shader / per-PSO compute threadgroup size, parsed from the
  // `// nano_threadgroup: X Y Z` hint spvToMsl prepends (MSL can't express the
  // original [numthreads]/@workgroup_size). Library handle → size at
  // createShaderModule; copied to the PSO handle at createComputePSO; bound to
  // currentComputeThreadgroup_ at computeSetPSO and used by computeDispatch.
  std::map<int32_t, MTLSize> shaderThreadgroup_;
  std::map<int32_t, MTLSize> psoThreadgroup_;

  void recordPsoThreadgroup(int32_t psoHandle, int32_t shaderHandle) {
    auto it = shaderThreadgroup_.find(shaderHandle);
    psoThreadgroup_[psoHandle] =
        (it != shaderThreadgroup_.end()) ? it->second : MTLSizeMake(8, 8, 1);
  }

  static MTLSize parseThreadgroup(const std::string& msl) {
    // Default matches the historical hardcode (covers raw-MSL kernels).
    MTLSize tg = MTLSizeMake(8, 8, 1);
    const std::string tag = "// nano_threadgroup:";
    auto p = msl.find(tag);
    if (p == std::string::npos) {
      // SPV-translated kernels always carry the hint (spvToMsl prepends it).
      // A raw-MSL kernel authored with a non-8×8 layout that lands here runs
      // with the WRONG threadgroup shape on Metal only — silently, since
      // WebGPU reads @workgroup_size from the shader itself. Be loud so the
      // divergence is diagnosable; the 8×8 fallback still applies.
      if (msl.find("kernel ") != std::string::npos) {
        fprintf(stderr,
                "[gpu/metal] compute MSL lacks the '// nano_threadgroup:' hint;"
                " dispatching with the 8x8x1 fallback — a non-8x8 kernel will"
                " run WRONG on Metal only\n");
      }
      return tg;
    }
    unsigned x = 0, y = 0, z = 0;
    if (std::sscanf(msl.c_str() + p + tag.size(), "%u %u %u", &x, &y, &z) == 3
        && x && y && z) {
      tg = MTLSizeMake(x, y, z);
    }
    return tg;
  }

  static std::map<std::string, ConstInfo>
  parseFunctionConstants(const std::string& msl) {
    std::map<std::string, ConstInfo> out;
    const std::string marker = "[[function_constant(";
    size_t pos = 0;
    while ((pos = msl.find(marker, pos)) != std::string::npos) {
      // Walk back from `pos` to find the identifier preceding the
      // attribute — skip whitespace, then read [A-Za-z0-9_]+.
      size_t nameEnd = pos;
      while (nameEnd > 0 && std::isspace((unsigned char)msl[nameEnd - 1])) --nameEnd;
      size_t nameStart = nameEnd;
      while (nameStart > 0 && (std::isalnum((unsigned char)msl[nameStart - 1]) ||
                                msl[nameStart - 1] == '_')) {
        --nameStart;
      }
      std::string name = msl.substr(nameStart, nameEnd - nameStart);
      // Walk back past whitespace before the name → that's the type
      // token. e.g. `constant uint TILE_SIZE_tmp [[...]]`.
      size_t typeEnd = nameStart;
      while (typeEnd > 0 && std::isspace((unsigned char)msl[typeEnd - 1])) --typeEnd;
      size_t typeStart = typeEnd;
      while (typeStart > 0 && (std::isalnum((unsigned char)msl[typeStart - 1]) ||
                                msl[typeStart - 1] == '_')) {
        --typeStart;
      }
      std::string typeStr = msl.substr(typeStart, typeEnd - typeStart);

      size_t idxStart = pos + marker.size();
      size_t idxEnd = msl.find(')', idxStart);
      if (idxEnd == std::string::npos) break;
      int idx = std::atoi(msl.substr(idxStart, idxEnd - idxStart).c_str());

      if (name.size() > 4 &&
          name.compare(name.size() - 4, 4, "_tmp") == 0) {
        name.resize(name.size() - 4);
      }
      MTLDataType mt = MTLDataTypeInt;
      if (typeStr == "uint")        mt = MTLDataTypeUInt;
      else if (typeStr == "int")    mt = MTLDataTypeInt;
      else if (typeStr == "float")  mt = MTLDataTypeFloat;
      else if (typeStr == "bool")   mt = MTLDataTypeBool;
      out[name] = {idx, mt};
      pos = idxEnd + 1;
    }
    return out;
  }

  // Trace flag — flipped on by the StreakyBlobs plugin via the env
  // var NANO_METAL_DEBUG=1, so the dual-backend tests don't drown
  // in NSLogs but the in-Resolume diagnostic runs do.
  bool debugLog_ = (getenv("NANO_METAL_DEBUG") != nullptr);
};

// Factory function
std::unique_ptr<GPUBackend> createMetalBackend() {
  @autoreleasepool {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) return nullptr;
    return std::make_unique<MetalBackend>(device);
  }
}

} // namespace gpu
