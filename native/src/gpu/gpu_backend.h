#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace gpu {

class GPUBackend {
public:
  virtual ~GPUBackend() = default;

  virtual int32_t getBackend() = 0; // 0=Metal, 1=WebGPU

  // Resource creation
  virtual int32_t createShaderModule(const std::string& source) = 0;
  virtual int32_t createBuffer(uint32_t size, int32_t usage) = 0;
  virtual int32_t createTexture(uint32_t w, uint32_t h, int32_t format) = 0;
  virtual int32_t createComputePSO(int32_t shaderHandle, const std::string& entryPoint) = 0;
  virtual int32_t createRenderPSO(int32_t vsHandle, const std::string& vsEntry,
                                   int32_t fsHandle, const std::string& fsEntry,
                                   int32_t format) = 0;

  // Buffer operations
  virtual void writeBuffer(int32_t bufHandle, uint32_t offset,
                           const uint8_t* data, uint32_t len) = 0;

  // Compute pass
  virtual int32_t beginComputePass() = 0;
  virtual void computeSetPSO(int32_t pass, int32_t pso) = 0;
  virtual void computeSetBuffer(int32_t pass, int32_t buf, uint32_t offset, int32_t slot) = 0;
  virtual void computeSetTexture(int32_t pass, int32_t textureHandle, int32_t slot, int32_t access) = 0;
  virtual void computeDispatch(int32_t pass, uint32_t x, uint32_t y, uint32_t z) = 0;
  virtual void endComputePass(int32_t pass) = 0;

  // Render pass
  virtual int32_t beginRenderPass(int32_t textureHandle,
                                   float cr, float cg, float cb, float ca) = 0;
  virtual void renderSetPSO(int32_t pass, int32_t pso) = 0;
  virtual void renderSetVertexBuffer(int32_t pass, int32_t buf,
                                     uint32_t offset, int32_t slot) = 0;
  virtual void renderDraw(int32_t pass, uint32_t vertexCount, uint32_t instanceCount) = 0;
  virtual void endRenderPass(int32_t pass) = 0;

  // Submit + present
  virtual void submit() = 0;

  // Surface / render target
  virtual void setSurface(int32_t textureHandle, uint32_t w, uint32_t h) = 0;
  virtual int32_t getSurfaceTexture() = 0;
  virtual int32_t getSurfaceWidth() = 0;
  virtual int32_t getSurfaceHeight() = 0;

  // Readback for testing
  virtual std::vector<uint8_t> readbackTexture(int32_t textureHandle,
                                                uint32_t w, uint32_t h) = 0;

  // Cleanup
  virtual void release(int32_t handle) = 0;
};

// Factory
std::unique_ptr<GPUBackend> createMetalBackend();

} // namespace gpu
