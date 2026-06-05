#include "gpu/gpu_backend.h"

#import <Metal/Metal.h>
#import <MetalPerformanceShaders/MetalPerformanceShaders.h>
#include <map>
#include <string>
#include <cstring>
#include <unordered_map>
#include <vector>

namespace gpu {

enum class ResourceType { Buffer, Texture, Library, ComputePSO, RenderPSO,
                          Sampler };

struct Resource {
  ResourceType type;
  id obj = nil;
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
      return handle;
    }
  }

  int32_t createBuffer(uint32_t size, int32_t usage) override {
    (void)usage; // Metal doesn't need usage hints at creation
    id<MTLBuffer> buf = [device_ newBufferWithLength:size
                                             options:MTLResourceStorageModeShared];
    if (!buf) return -1;
    return alloc(ResourceType::Buffer, buf);
  }

  int32_t createTexture(uint32_t w, uint32_t h, int32_t format) override {
    // TextureFormat enum (from wasm_modules/include/gpu.h):
    //   0=BGRA8, 1=RGBA8, 3=RGBA16F, 4=R32F.
    MTLPixelFormat pf;
    switch (format) {
      case 0:  pf = MTLPixelFormatBGRA8Unorm;  break;
      case 1:  pf = MTLPixelFormatRGBA8Unorm;  break;
      case 3:  pf = MTLPixelFormatRGBA16Float; break;
      case 4:  pf = MTLPixelFormatR32Float;    break;
      default: pf = MTLPixelFormatRGBA8Unorm;  break;
    }
    MTLTextureDescriptor* desc = [[MTLTextureDescriptor alloc] init];
    desc.width = w;
    desc.height = h;
    desc.pixelFormat = pf;
    // ShaderWrite is required for storage-texture writes (the storageTex2d
    // bindings in modern effects). Add it unconditionally — it's a no-op
    // if the shader doesn't write to the texture.
    desc.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead
               | MTLTextureUsageShaderWrite;
    desc.storageMode = MTLStorageModeShared; // CPU-readable for readback
    id<MTLTexture> tex = [device_ newTextureWithDescriptor:desc];
    if (!tex) return -1;
    return alloc(ResourceType::Texture, tex);
  }

  int32_t createTextureArray(uint32_t w, uint32_t h,
                             int32_t format, int32_t layers) override {
    MTLPixelFormat pf;
    switch (format) {
      case 0:  pf = MTLPixelFormatBGRA8Unorm;  break;
      case 1:  pf = MTLPixelFormatRGBA8Unorm;  break;
      case 3:  pf = MTLPixelFormatRGBA16Float; break;
      case 4:  pf = MTLPixelFormatR32Float;    break;
      default: pf = MTLPixelFormatRGBA8Unorm;  break;
    }
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
      return alloc(ResourceType::ComputePSO, pso);
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
      return alloc(ResourceType::ComputePSO, pso);
    }
  }

  int32_t createTextureWithMips(uint32_t w, uint32_t h,
                                 int32_t format, int32_t mipCount) override {
    MTLPixelFormat pf;
    switch (format) {
      case 0:  pf = MTLPixelFormatBGRA8Unorm;  break;
      case 1:  pf = MTLPixelFormatRGBA8Unorm;  break;
      case 3:  pf = MTLPixelFormatRGBA16Float; break;
      case 4:  pf = MTLPixelFormatR32Float;    break;
      default: pf = MTLPixelFormatRGBA8Unorm;  break;
    }
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

  int32_t createSampler(int32_t filterMode, int32_t addressMode) override {
    MTLSamplerDescriptor* desc = [[MTLSamplerDescriptor alloc] init];
    desc.minFilter = (filterMode == 1) ? MTLSamplerMinMagFilterLinear
                                        : MTLSamplerMinMagFilterNearest;
    desc.magFilter = desc.minFilter;
    MTLSamplerAddressMode am;
    switch (addressMode) {
      case 0:  am = MTLSamplerAddressModeClampToEdge;     break;
      case 1:  am = MTLSamplerAddressModeRepeat;          break;
      case 2:  am = MTLSamplerAddressModeMirrorRepeat;    break;
      default: am = MTLSamplerAddressModeClampToEdge;     break;
    }
    desc.sAddressMode = am;
    desc.tAddressMode = am;
    desc.rAddressMode = am;
    desc.mipFilter = MTLSamplerMipFilterLinear;  // for pyramid sampling
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

  void copyTexture(int32_t src, int32_t dst) override {
    id<MTLTexture> s = getAs<id<MTLTexture>>(src);
    id<MTLTexture> d = getAs<id<MTLTexture>>(dst);
    if (!s || !d) return;
    if (!cmdBuffer_) cmdBuffer_ = [queue_ commandBuffer];
    id<MTLBlitCommandEncoder> blit = [cmdBuffer_ blitCommandEncoder];
    [blit copyFromTexture:s sourceSlice:0 sourceLevel:0
                sourceOrigin:MTLOriginMake(0, 0, 0)
                  sourceSize:MTLSizeMake([s width], [s height], 1)
                   toTexture:d destinationSlice:0 destinationLevel:0
            destinationOrigin:MTLOriginMake(0, 0, 0)];
    [blit endEncoding];
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

      MTLPixelFormat fmt = (format == 0) ? MTLPixelFormatBGRA8Unorm :
                           (format == 1) ? MTLPixelFormatRGBA8Unorm : surfaceFormat_;
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

      // TextureFormat enum: 0=BGRA8, 1=RGBA8, 2=Surface, 3=RGBA16F, 4=R32F.
      MTLPixelFormat fmt;
      switch (format) {
        case 0:  fmt = MTLPixelFormatBGRA8Unorm;  break;
        case 1:  fmt = MTLPixelFormatRGBA8Unorm;  break;
        case 3:  fmt = MTLPixelFormatRGBA16Float; break;
        case 4:  fmt = MTLPixelFormatR32Float;    break;
        case 2:  default: fmt = surfaceFormat_;   break;  // Surface
      }

      MTLRenderPipelineDescriptor* desc = [[MTLRenderPipelineDescriptor alloc] init];
      desc.vertexFunction = vsFunc;
      desc.fragmentFunction = fsFunc;
      // No vertexDescriptor: the vertex shader synthesizes geometry from
      // [[vertex_id]] / [[instance_id]] + storage buffers (instanced quads).
      desc.colorAttachments[0].pixelFormat = fmt;
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
                                       int32_t targetCount, const int32_t* targetFormats) override {
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
      for (int i = 0; i < targetCount && i < 8; ++i) {
        MTLPixelFormat fmt;
        switch (targetFormats[i]) {
          case 0:  fmt = MTLPixelFormatBGRA8Unorm;  break;
          case 1:  fmt = MTLPixelFormatRGBA8Unorm;  break;
          case 3:  fmt = MTLPixelFormatRGBA16Float; break;
          case 4:  fmt = MTLPixelFormatR32Float;    break;
          case 2:  default: fmt = surfaceFormat_;   break;  // Surface
        }
        desc.colorAttachments[i].pixelFormat = fmt;
        desc.colorAttachments[i].blendingEnabled = YES;
        desc.colorAttachments[i].sourceRGBBlendFactor = MTLBlendFactorSourceAlpha;
        desc.colorAttachments[i].destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
        desc.colorAttachments[i].sourceAlphaBlendFactor = MTLBlendFactorOne;
        desc.colorAttachments[i].destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
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
    id<MTLBuffer> buf = getAs<id<MTLBuffer>>(bufHandle);
    if (!buf) return;
    memcpy((uint8_t*)[buf contents] + offset, data, len);
  }

  void* bufferContents(int32_t bufHandle) override {
    id<MTLBuffer> buf = getAs<id<MTLBuffer>>(bufHandle);
    return buf ? [buf contents] : nullptr;
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
  }

  void computeSetBuffer(int32_t pass, int32_t buf, uint32_t offset, int32_t slot) override {
    (void)pass;
    id<MTLBuffer> b = getAs<id<MTLBuffer>>(buf);
    if (debugLog_) NSLog(@"[metal_backend] setBuffer handle=%d slot=%d buf=%p",
                          buf, slot, b);
    if (b && computeEncoder_) [computeEncoder_ setBuffer:b offset:offset atIndex:slot];
  }

  void computeSetTexture(int32_t pass, int32_t textureHandle, int32_t slot, int32_t access) override {
    (void)pass; (void)access;
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (debugLog_) NSLog(@"[metal_backend] setTexture handle=%d slot=%d tex=%p w=%lu h=%lu fmt=%lu",
                          textureHandle, slot, tex,
                          tex ? (unsigned long)[tex width] : 0,
                          tex ? (unsigned long)[tex height] : 0,
                          tex ? (unsigned long)[tex pixelFormat] : 0);
    if (tex && computeEncoder_) [computeEncoder_ setTexture:tex atIndex:slot];
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
    // Threads-per-group must match the shader's [numthreads(...)].
    // All effects in the modules tree use [numthreads(8, 8, 1)], so
    // hardcode here. The old 1D test shader (test_gpu_metal) over-
    // dispatches but writes the same value to every slot, so it still
    // passes. If we add effects with different threadgroup sizes,
    // we'll need per-PSO threadgroup tracking — read [numthreads]
    // from the MSL source at PSO creation, or expose an explicit
    // setter on the GPU API.
    MTLSize threadsPerGroup = MTLSizeMake(8, 8, 1);
    MTLSize threadgroups = MTLSizeMake(x, y, z);
    [computeEncoder_ dispatchThreadgroups:threadgroups threadsPerThreadgroup:threadsPerGroup];
  }

  void endComputePass(int32_t pass) override {
    (void)pass;
    if (computeEncoder_) {
      [computeEncoder_ endEncoding];
      computeEncoder_ = nil;
      currentComputePSO_ = nil;
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
    return 1;
  }

  int32_t beginRenderPassMRT(int32_t count, const int32_t* texHandles,
                             const float* clears) override {
    if (count <= 0) return -1;
    if (!cmdBuffer_) cmdBuffer_ = [queue_ commandBuffer];
    MTLRenderPassDescriptor* desc = [MTLRenderPassDescriptor renderPassDescriptor];
    for (int i = 0; i < count && i < 8; ++i) {
      id<MTLTexture> tex = getAs<id<MTLTexture>>(texHandles[i]);
      if (!tex) return -1;
      desc.colorAttachments[i].texture = tex;
      desc.colorAttachments[i].loadAction = MTLLoadActionClear;
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
    if (b && renderEncoder_) [renderEncoder_ setVertexBuffer:b offset:offset atIndex:slot];
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
  }

  void renderDraw(int32_t pass, uint32_t vertexCount, uint32_t instanceCount) override {
    (void)pass;
    if (!renderEncoder_) return;
    [renderEncoder_ drawPrimitives:MTLPrimitiveTypeTriangle
                       vertexStart:0
                       vertexCount:vertexCount
                     instanceCount:instanceCount];
  }

  void endRenderPass(int32_t pass) override {
    (void)pass;
    if (renderEncoder_) {
      [renderEncoder_ endEncoding];
      renderEncoder_ = nil;
    }
  }

  // --- Submit ---

  void submit() override {
    if (cmdBuffer_) {
      [cmdBuffer_ commit];
      [cmdBuffer_ waitUntilCompleted];
      // Surface command-buffer errors loudly. A Metal validation
      // failure during compute dispatch (e.g. binding mismatch, dead
      // PSO) commits silently and leaves status==Error with no other
      // signal — the dispatch just doesn't write, producing black
      // output.
      if ([cmdBuffer_ status] == MTLCommandBufferStatusError) {
        NSError* err = [cmdBuffer_ error];
        NSLog(@"[metal_backend] command buffer FAILED: %@",
              err ? [err localizedDescription] : @"(unknown)");
      }
      cmdBuffer_ = nil;
    }
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

  // --- Readback ---

  std::vector<uint8_t> readbackTexture(int32_t textureHandle,
                                        uint32_t w, uint32_t h) override {
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (!tex) return {};

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
        scaler_ = [[MPSImageBilinearScale alloc] initWithDevice:device_];
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
      std::function<void(std::vector<uint8_t>)> callback) override {
    id<MTLTexture> src = getAs<id<MTLTexture>>(textureHandle);
    if (!src || dstW == 0 || dstH == 0 || !callback) return;

    @autoreleasepool {
      id<MTLTexture> dst = nextAsyncScratchScaleTarget(dstW, dstH);
      if (!dst) return;
      if (!scaler_) {
        scaler_ = [[MPSImageBilinearScale alloc] initWithDevice:device_];
      }

      // If a batch is open, encode into the shared cmd buffer and
      // accumulate the (dst, callback) pair so commitPreviewBatch can
      // service them all from one completion handler. Otherwise fall
      // back to the per-call cmd buffer (legacy behavior).
      if (async_batch_cb_) {
        [scaler_ encodeToCommandBuffer:async_batch_cb_
                         sourceTexture:src
                    destinationTexture:dst];
        async_batch_pending_.push_back({dst, dstW, dstH, std::move(callback)});
        return;
      }

      id<MTLCommandBuffer> cb = [queue_ commandBuffer];
      [scaler_ encodeToCommandBuffer:cb
                       sourceTexture:src
                  destinationTexture:dst];

      // The block runs on a Metal-owned thread once the GPU work
      // completes. `dst` is retained by the block (ARC); the scratch
      // pool keeps it valid across frames anyway. dstW/dstH/callback
      // are captured by value. getBytes is a tight memcpy on UMA, so
      // the window in which dst could be reused for the next frame's
      // encode is small — and we have a pool of `kAsyncScratchPoolSize`
      // scratches to widen it further.
      __block auto cb_callback = std::move(callback);
      [cb addCompletedHandler:^(id<MTLCommandBuffer> finished) {
        if ([finished status] == MTLCommandBufferStatusError) return;
        std::vector<uint8_t> pixels((size_t)dstW * dstH * 4);
        [dst getBytes:pixels.data()
          bytesPerRow:dstW * 4
           fromRegion:MTLRegionMake2D(0, 0, dstW, dstH)
          mipmapLevel:0];
        cb_callback(std::move(pixels));
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
    // Ping-pong: this frame uses one pool, next frame the other. Within
    // this batch, the cursor walks 0..N as readbacks are added; the
    // pool grows on demand. The OTHER pool was used in the previous
    // frame and its completion handler may still be running getBytes,
    // so we don't touch it.
    async_batch_pool_index_ ^= 1;
    for (auto& [_, set] : asyncScaleScratchPools_) {
      set.pools[async_batch_pool_index_].cursor = 0;
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
      [cb addCompletedHandler:^(id<MTLCommandBuffer> finished) {
        if ([finished status] == MTLCommandBufferStatusError) return;
        for (auto& p : *pending) {
          std::vector<uint8_t> pixels((size_t)p.dstW * p.dstH * 4);
          [p.dst getBytes:pixels.data()
              bytesPerRow:p.dstW * 4
               fromRegion:MTLRegionMake2D(0, 0, p.dstW, p.dstH)
              mipmapLevel:0];
          p.callback(std::move(pixels));
        }
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
  // We use a two-pool ping-pong per (w,h): each frame's batch picks one
  // pool (alternates), grows it on demand within the batch (so case
  // (a) is impossible), and resets its cursor for the next time that
  // pool is picked. By then ~2 frames have elapsed, well past the
  // microseconds the handler needs.
  struct AsyncScratchPool {
    std::vector<id<MTLTexture>> textures;
    size_t cursor = 0;
  };
  struct AsyncScratchPoolSet {
    AsyncScratchPool pools[2];
  };
  size_t async_batch_pool_index_ = 0;
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

public:

  // --- Upload ---

  void writeTexture(int32_t textureHandle,
                    uint32_t w, uint32_t h,
                    const uint8_t* bytes, uint32_t byteCount) override {
    id<MTLTexture> tex = getAs<id<MTLTexture>>(textureHandle);
    if (!tex || !bytes) return;
    if (byteCount < w * h * 4) return;
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

  id<MTLDevice> device_;
  id<MTLCommandQueue> queue_;
  std::map<int32_t, Resource> resources_;
  int32_t nextHandle_ = 1;

  MTLPixelFormat surfaceFormat_ = MTLPixelFormatRGBA8Unorm;
  int32_t surfaceHandle_ = -1;
  int32_t surfaceW_ = 0, surfaceH_ = 0;

  id<MTLCommandBuffer> cmdBuffer_ = nil;
  id<MTLComputeCommandEncoder> computeEncoder_ = nil;
  id<MTLComputePipelineState> currentComputePSO_ = nil;
  id<MTLRenderCommandEncoder> renderEncoder_ = nil;

  // Bilinear downscale used by readbackTextureScaled. Lazily created so
  // backends that never preview pay nothing.
  MPSImageBilinearScale* scaler_ = nil;
  // Destination textures keyed by ((w << 32) | h). Read+write-only;
  // never published through `resources_` because no caller outside this
  // class needs handles to them. Sync-path uses one scratch per size;
  // async-path needs a small per-size pool so a frame's completion
  // handler doesn't race the next frame's encode.
  std::unordered_map<uint64_t, id<MTLTexture>> scaleScratchTextures_;
  std::unordered_map<uint64_t, AsyncScratchPoolSet> asyncScaleScratchPools_;

  // Preview-batch state. When beginPreviewBatch opens a cmd buffer all
  // subsequent readbackTextureScaledAsync calls encode into it; the
  // matching commitPreviewBatch drains the per-call records through a
  // single completion handler. Strictly render-thread only.
  struct BatchPendingReadback {
    id<MTLTexture> dst;
    uint32_t dstW, dstH;
    std::function<void(std::vector<uint8_t>)> callback;
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
