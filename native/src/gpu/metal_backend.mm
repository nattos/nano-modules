#include "gpu/gpu_backend.h"

#import <Metal/Metal.h>
#include <map>
#include <string>
#include <cstring>

namespace gpu {

enum class ResourceType { Buffer, Texture, Library, ComputePSO, RenderPSO };

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
      return alloc(ResourceType::Library, lib);
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
    MTLTextureDescriptor* desc = [[MTLTextureDescriptor alloc] init];
    desc.width = w;
    desc.height = h;
    desc.pixelFormat = (format == 0) ? MTLPixelFormatBGRA8Unorm : MTLPixelFormatRGBA8Unorm;
    desc.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    desc.storageMode = MTLStorageModeShared; // CPU-readable for readback
    id<MTLTexture> tex = [device_ newTextureWithDescriptor:desc];
    if (!tex) return -1;
    return alloc(ResourceType::Texture, tex);
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

  // --- Buffer operations ---

  void writeBuffer(int32_t bufHandle, uint32_t offset,
                   const uint8_t* data, uint32_t len) override {
    id<MTLBuffer> buf = getAs<id<MTLBuffer>>(bufHandle);
    if (!buf) return;
    memcpy((uint8_t*)[buf contents] + offset, data, len);
  }

  // --- Compute pass ---

  int32_t beginComputePass() override {
    cmdBuffer_ = [queue_ commandBuffer];
    computeEncoder_ = [cmdBuffer_ computeCommandEncoder];
    return 1;
  }

  void computeSetPSO(int32_t pass, int32_t pso) override {
    (void)pass;
    id<MTLComputePipelineState> p = getAs<id<MTLComputePipelineState>>(pso);
    if (p && computeEncoder_) [computeEncoder_ setComputePipelineState:p];
    currentComputePSO_ = p;
  }

  void computeSetBuffer(int32_t pass, int32_t buf, uint32_t offset, int32_t slot) override {
    (void)pass;
    id<MTLBuffer> b = getAs<id<MTLBuffer>>(buf);
    if (b && computeEncoder_) [computeEncoder_ setBuffer:b offset:offset atIndex:slot];
  }

  void computeDispatch(int32_t pass, uint32_t x, uint32_t y, uint32_t z) override {
    (void)pass;
    if (!computeEncoder_ || !currentComputePSO_) return;
    NSUInteger tw = [currentComputePSO_ threadExecutionWidth];
    MTLSize threadsPerGroup = MTLSizeMake(tw, 1, 1);
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
    if (!cmdBuffer_) cmdBuffer_ = [queue_ commandBuffer];

    MTLRenderPassDescriptor* desc = [MTLRenderPassDescriptor renderPassDescriptor];
    desc.colorAttachments[0].texture = tex;
    desc.colorAttachments[0].loadAction = MTLLoadActionClear;
    desc.colorAttachments[0].storeAction = MTLStoreActionStore;
    desc.colorAttachments[0].clearColor = MTLClearColorMake(cr, cg, cb, ca);

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
