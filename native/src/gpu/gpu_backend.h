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

  // Optional: compute PSO with Metal function-constant overrides
  // (== WebGPU spec constants). Backends that don't support spec
  // constants ignore the `constants` payload and behave like
  // createComputePSO. Constants vector is name→f64 value pairs.
  struct SpecConstant {
    std::string name;
    double value;
  };
  virtual int32_t createComputePSOWithConstants(
      int32_t shaderHandle, const std::string& entryPoint,
      const std::vector<SpecConstant>& constants) {
    (void)constants;
    return createComputePSO(shaderHandle, entryPoint);
  }

  // Optional: multi-mip texture creation. Default = single-mip
  // fallback; backends that support real mips override.
  virtual int32_t createTextureWithMips(uint32_t w, uint32_t h,
                                         int32_t format, int32_t mipCount) {
    (void)mipCount;
    return createTexture(w, h, format);
  }
  // Bind a SPECIFIC mip level of a multi-mip texture to a compute
  // slot. Required when one pass reads one mip and writes another of
  // the same texture (the default sampled view spans all mips and
  // overlaps the write subresource — WebGPU rejects that).
  virtual void computeSetTextureMip(int32_t pass, int32_t textureHandle,
                                    int32_t slot, int32_t access,
                                    int32_t mipLevel) {
    (void)mipLevel;
    computeSetTexture(pass, textureHandle, slot, access);
  }

  // Sampler support — filter + addressing mode → MTLSamplerState (or
  // backend equivalent). Slot-bound via computeSetSampler.
  virtual int32_t createSampler(int32_t filterMode, int32_t addressMode) {
    (void)filterMode; (void)addressMode;
    return -1;
  }
  virtual void computeSetSampler(int32_t pass, int32_t samplerHandle,
                                 int32_t slot) {
    (void)pass; (void)samplerHandle; (void)slot;
  }

  // Clear a renderable texture to a single color (defensive init for
  // accumulators / pyramid bases). Default = no-op.
  virtual void clearTexture(int32_t textureHandle,
                            float r, float g, float b, float a) {
    (void)textureHandle; (void)r; (void)g; (void)b; (void)a;
  }
  // Blit source texture into destination (same dimensions, same format).
  virtual void copyTexture(int32_t src, int32_t dst) {
    (void)src; (void)dst;
  }

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

  // Upload pixel bytes into a texture (for tests / FFGL input handoff
  // without going through a full render path). RGBA8 / BGRA8 in row-
  // major order; bytes.size() must be w*h*4. No-op for invalid handles.
  virtual void writeTexture(int32_t textureHandle,
                            uint32_t w, uint32_t h,
                            const uint8_t* bytes, uint32_t byteCount) {
    (void)textureHandle; (void)w; (void)h; (void)bytes; (void)byteCount;
  }

  // Cleanup
  virtual void release(int32_t handle) = 0;
};

// Factory
std::unique_ptr<GPUBackend> createMetalBackend();

} // namespace gpu
