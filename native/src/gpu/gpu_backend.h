#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>
#include <functional>
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
  virtual int32_t createBuffer(uint64_t size, int32_t usage) = 0;
  virtual int32_t createTexture(uint32_t w, uint32_t h, int32_t format) = 0;
  virtual int32_t createComputePSO(int32_t shaderHandle, const std::string& entryPoint) = 0;
  virtual int32_t createRenderPSO(int32_t vsHandle, const std::string& vsEntry,
                                   int32_t fsHandle, const std::string& fsEntry,
                                   int32_t format) = 0;

  // Instanced render pipeline: a procedural vertex shader that pulls
  // geometry from storage buffers (no vertex descriptor / vertex buffer).
  // `format` is a TextureFormat enum value (2 = Surface). `blendMode`:
  // 0 = alpha-over (src*src.a + dst*(1-src.a)), 1 = additive
  // (src*src.a + dst), 2 = replace (no blending). Default unimplemented
  // (returns -1).
  virtual int32_t createInstancedRenderPSO(
      int32_t vsHandle, const std::string& vsEntry,
      int32_t fsHandle, const std::string& fsEntry,
      int32_t format, int32_t blendMode) {
    (void)vsHandle; (void)vsEntry; (void)fsHandle; (void)fsEntry;
    (void)format; (void)blendMode;
    return -1;
  }

  // Multi-render-target instanced pipeline: fragment @location(i) writes
  // color attachment i. `targetFormats` is `targetCount` TextureFormat
  // enum values; alpha-over blend on each. Default unimplemented.
  virtual int32_t createInstancedRenderPSOMRT(
      int32_t vsHandle, const std::string& vsEntry,
      int32_t fsHandle, const std::string& fsEntry,
      int32_t targetCount, const int32_t* targetFormats) {
    (void)vsHandle; (void)vsEntry; (void)fsHandle; (void)fsEntry;
    (void)targetCount; (void)targetFormats;
    return -1;
  }

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

  // Optional: 3D (volume) texture creation — w×h×d, one mip, sampled as
  // `texture3d` and (with write usage) bound as a `texture_storage_3d`. Used by
  // 3D-LUT effects. Default returns -1 (unsupported) so misuse is loud rather
  // than silently binding the wrong texture type.
  virtual int32_t createTexture3D(uint32_t w, uint32_t h, uint32_t d,
                                  int32_t format) {
    (void)w; (void)h; (void)d; (void)format;
    return -1;
  }

  // Optional: 2D-ARRAY texture creation (`layers` slices, all w×h, one mip),
  // sampled as `texture2d_array` in the shader. Used by the host text
  // compositor for the multi-page MSDF atlas. Default returns -1 (unsupported)
  // — binding a plain 2D texture where the shader declares an array would fail
  // validation, so misuse should be loud rather than silently wrong.
  virtual int32_t createTextureArray(uint32_t w, uint32_t h,
                                      int32_t format, int32_t layers) {
    (void)w; (void)h; (void)format; (void)layers;
    return -1;
  }
  // Upload tightly-packed RGBA8 (`w*h*4` bytes) into one array `layer`. No-op
  // on backends without array support / invalid handles.
  virtual void writeTextureLayer(int32_t textureHandle, int32_t layer,
                                 uint32_t w, uint32_t h,
                                 const uint8_t* bytes, uint32_t byteCount) {
    (void)textureHandle; (void)layer; (void)w; (void)h;
    (void)bytes; (void)byteCount;
  }
  // Dimensions of an existing texture handle. The host text compositor sizes
  // its dispatch off the *target* texture (mirroring the web path, which reads
  // GPUTexture.width/height) rather than the swapchain surface — generators
  // like source.text.plain render into an executor-bound output texture, not a surface,
  // so surface dims would be 0. Default 0 (unknown handle / unsupported).
  virtual int32_t getTextureWidth(int32_t textureHandle)  { (void)textureHandle; return 0; }
  virtual int32_t getTextureHeight(int32_t textureHandle) { (void)textureHandle; return 0; }
  // TextureFormat enum (0=BGRA8,1=RGBA8,3=RGBA16F,4=R32F) of an existing
  // texture, or -1 if unknown. Used by the text compositor to build a render
  // PSO whose color attachment matches the executor-bound output texture
  // (RGBA8 intermediates vs the BGRA8 output interop).
  virtual int32_t getTextureFormat(int32_t textureHandle) { (void)textureHandle; return -1; }
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

  // Sampler support → MTLSamplerState (or backend equivalent), slot-bound
  // via computeSetSampler. Mirrors the effect-facing gpu.h SamplerDesc
  // (already defaulted/validated by the host-import layer): filter/address
  // fields are the FilterMode/AddressMode enum ints.
  struct SamplerDesc {
    int32_t minFilter = 1, magFilter = 1, mipFilter = 1;  // 0=nearest 1=linear
    int32_t addressU = 0, addressV = 0, addressW = 0;     // 0=clamp 1=repeat 2=mirror
    int32_t maxAnisotropy = 1;
    float lodMinClamp = 0.0f, lodMaxClamp = 32.0f;
  };
  virtual int32_t createSampler(const SamplerDesc& desc) {
    (void)desc;
    return -1;
  }

  // Decode the effect-facing sized SamplerDesc wire layout (gpu.h): 10 × 4
  // bytes — struct_size, min/mag/mip filter, address u/v/w, max_anisotropy,
  // lod_min(f32), lod_max(f32). `avail` is the caller-validated byte count
  // (min of the sent struct_size and the buffer); fields beyond it keep the
  // defaults — the sized-struct growth contract.
  static SamplerDesc decodeSamplerDesc(const uint8_t* p, int32_t avail) {
    SamplerDesc d;
    const auto i32 = [&](int idx, int32_t* out) {
      if (avail >= (idx + 1) * 4) std::memcpy(out, p + idx * 4, 4);
    };
    const auto f32 = [&](int idx, float* out) {
      if (avail >= (idx + 1) * 4) std::memcpy(out, p + idx * 4, 4);
    };
    i32(1, &d.minFilter);
    i32(2, &d.magFilter);
    i32(3, &d.mipFilter);
    i32(4, &d.addressU);
    i32(5, &d.addressV);
    i32(6, &d.addressW);
    i32(7, &d.maxAnisotropy);
    f32(8, &d.lodMinClamp);
    f32(9, &d.lodMaxClamp);
    return d;
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
  // Return a CPU-readable pointer to the buffer's contents, or nullptr
  // if the backend doesn't support direct access (eg the buffer is
  // private/staging). Metal-backed buffers use MTLStorageModeShared by
  // default, so the pointer is valid for both read and write and is
  // immediately coherent with GPU access.
  virtual void* bufferContents(int32_t bufHandle) { (void)bufHandle; return nullptr; }

  // GPU→CPU readback of a small buffer region into `dst`. Returns bytes copied
  // (0 if unavailable). The default reads directly from `bufferContents` (valid
  // for CPU-coherent backends); a backend whose GPU writes aren't yet visible on
  // the CPU (eg Metal, where the producing command buffer must complete first)
  // overrides this to drain in-flight work before copying.
  virtual int readBuffer(int32_t bufHandle, uint32_t offset, void* dst, uint32_t len) {
    void* src = bufferContents(bufHandle);
    if (!src || !dst) return 0;
    memcpy(dst, static_cast<const uint8_t*>(src) + offset, len);
    return static_cast<int>(len);
  }

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
  // Begin a render pass that LOADS existing target contents (no clear) —
  // for blend-on-top raster (e.g. instanced particles over a pre-filled
  // texture). Default unimplemented (returns -1).
  virtual int32_t beginRenderPassLoad(int32_t textureHandle) {
    (void)textureHandle; return -1;
  }
  // Begin an MRT render pass — clears each of `count` targets to its
  // clears[i*4 .. i*4+3] RGBA color. Default unimplemented (returns -1).
  virtual int32_t beginRenderPassMRT(int32_t count, const int32_t* texHandles,
                                     const float* clears) {
    (void)count; (void)texHandles; (void)clears; return -1;
  }
  virtual void renderSetPSO(int32_t pass, int32_t pso) = 0;
  virtual void renderSetVertexBuffer(int32_t pass, int32_t buf,
                                     uint32_t offset, int32_t slot) = 0;
  // Bind a buffer at `slot` to BOTH vertex and fragment stages (WGSL bind
  // groups are stage-unified; spirv-cross emits [[buffer(slot)]] in
  // whichever stage uses it). Default no-op.
  virtual void renderSetBuffer(int32_t pass, int32_t buf, int32_t slot) {
    (void)pass; (void)buf; (void)slot;
  }
  // Bind a texture / sampler to the FRAGMENT stage of a render pass (the
  // vertex stage of our procedural-quad pipelines never samples). `access`
  // is accepted for symmetry with computeSetTexture but ignored (render
  // targets are read-only sampled here). Default no-op. Used by the quad
  // text compositor's MSDF/bg fragment shaders.
  virtual void renderSetTexture(int32_t pass, int32_t textureHandle, int32_t slot,
                                int32_t access) {
    (void)pass; (void)textureHandle; (void)slot; (void)access;
  }
  virtual void renderSetSampler(int32_t pass, int32_t samplerHandle, int32_t slot) {
    (void)pass; (void)samplerHandle; (void)slot;
  }
  virtual void renderDraw(int32_t pass, uint32_t vertexCount, uint32_t instanceCount) = 0;
  virtual void endRenderPass(int32_t pass) = 0;

  // Submit + present
  virtual void submit() = 0;

  // Frame-batching. When a host brackets a sequence of render stages with
  // beginSubmitBatch()/endSubmitBatch(), the backend MAY coalesce the per-stage
  // submit() calls into a single command buffer committed + waited once at
  // endSubmitBatch(). This removes the N-1 CPU<->GPU round-trips an N-stage
  // chain otherwise pays — every effect's render() ends in submit(), which by
  // default commits AND blocks on completion, so a 16-effect chain blocks the
  // CPU 16 times per frame. All GPU work is guaranteed complete when
  // endSubmitBatch() returns, so downstream consumers (readback, interop blit)
  // are unchanged. Nestable calls are NOT supported (one batch at a time).
  // Default: no-op — submit() keeps its commit+wait behavior.
  virtual void beginSubmitBatch() {}
  virtual void endSubmitBatch() {}

  // Surface / render target
  virtual void setSurface(int32_t textureHandle, uint32_t w, uint32_t h) = 0;
  virtual int32_t getSurfaceTexture() = 0;
  virtual int32_t getSurfaceWidth() = 0;
  virtual int32_t getSurfaceHeight() = 0;

  // Sketch working format: the TextureFormat code that SketchDefault (6)
  // resolves to at texture/PSO creation time. 1 = RGBA8 (default), 3 =
  // RGBA16F. Set by the executor once per execute() from the sketch's
  // outputFormat.bitDepth.
  virtual void setDefaultTextureFormat(int32_t code) { defaultTextureFormatCode_ = code; }
  virtual int32_t getDefaultTextureFormat() const { return defaultTextureFormatCode_; }

  // Readback for testing
  virtual std::vector<uint8_t> readbackTexture(int32_t textureHandle,
                                                uint32_t w, uint32_t h) = 0;

  // Bilinear-downscale a texture and read the result back as tightly-
  // packed RGBA8 bytes (`dstW * dstH * 4` bytes). The barrel uses this
  // every frame to publish preview thumbnails to the editor over the
  // WS bridge — downscaling on the GPU keeps the readback small (a
  // 1920×1080 frame → 128×72 thumbnail collapses ~8 MB into 37 kB).
  //
  // `srcW`/`srcH` are the source texture's native dimensions; the call
  // samples the full source. Implementations are free to cache per-
  // dest-size scratch textures internally — the caller is expected to
  // call this many times per frame with a small set of recurring sizes.
  //
  // Returns an empty vector on unsupported backends or invalid handles.
  virtual std::vector<uint8_t> readbackTextureScaled(int32_t textureHandle,
                                                      uint32_t srcW,
                                                      uint32_t srcH,
                                                      uint32_t dstW,
                                                      uint32_t dstH) {
    (void)textureHandle; (void)srcW; (void)srcH; (void)dstW; (void)dstH;
    return {};
  }

  // Async variant — the GPU work is committed but NOT waited on. The
  // backend invokes `callback(pixels, byteCount)` from a backend-owned
  // thread (a serial readback queue on Metal) once the readback finishes.
  // Critical for hosts that want to keep their render thread free —
  // the FFGL barrel uses this so it can publish previews without
  // blocking Resolume on a per-frame waitUntilCompleted.
  //
  // The pixel pointer is only valid for the duration of the callback —
  // consumers copy what they need (typically straight into their own
  // pooled wire-format buffer). A span instead of a std::vector because
  // allocating a fresh multi-MB vector per preview frame cost more than
  // the GPU readback itself (page faults + zero-fill ~14ms for 7MB).
  //
  // When wrapped between `beginPreviewBatch()` and `commitPreviewBatch()`,
  // multiple async readbacks coalesce into a single Metal command
  // buffer with one shared completion handler — turning N cmd-buffer
  // commits + N completion callbacks into 1 + 1. Without an active
  // batch the call commits its own per-readback cmd buffer (legacy).
  //
  // The default falls back to the synchronous path and invokes the
  // callback inline.
  virtual void readbackTextureScaledAsync(
      int32_t textureHandle,
      uint32_t srcW, uint32_t srcH,
      uint32_t dstW, uint32_t dstH,
      std::function<void(const uint8_t* pixels, size_t byteCount)> callback) {
    auto pixels = readbackTextureScaled(textureHandle, srcW, srcH,
                                         dstW, dstH);
    if (!pixels.empty() && callback) callback(pixels.data(), pixels.size());
  }

  // Batch helpers — wrap a sequence of `readbackTextureScaledAsync`
  // calls so they share one cmd buffer + one completion handler. No-op
  // on backends without batching support; they fall through to per-
  // call commits.
  virtual void beginPreviewBatch() {}
  virtual void commitPreviewBatch() {}
  // Block until every readback callback issued so far has run. Call before
  // destroying objects the callbacks capture (host teardown). No-op on
  // backends that run callbacks synchronously.
  virtual void drainPreviewReadbacks() {}

  // Upload pixel bytes into a texture (for tests / FFGL input handoff
  // without going through a full render path). RGBA8 / BGRA8 in row-
  // major order; bytes.size() must be w*h*4. No-op for invalid handles.
  virtual void writeTexture(int32_t textureHandle,
                            uint32_t w, uint32_t h,
                            const uint8_t* bytes, uint32_t byteCount) {
    (void)textureHandle; (void)w; (void)h; (void)bytes; (void)byteCount;
  }

  // Adopt an external native texture (Metal `id<MTLTexture>` cast to
  // void*; ignored by non-Metal backends) — returns a handle that
  // points at the EXACT same underlying texture. Lets the FFGL plugin
  // bridge IOSurface-backed InteropTexture into the runtime with zero
  // copy: effects read/write directly to the interop's pixels.
  // Default returns -1 (unsupported).
  virtual int32_t adoptExternalTexture(void* nativeTexture) {
    (void)nativeTexture;
    return -1;
  }

  // Cleanup
  virtual void release(int32_t handle) = 0;

  // Number of GPU resources (textures, buffers, ...) the backend is currently
  // holding. Introspection for leak tests — an effect that allocates per frame,
  // or fails to give its buffers back on destroy/bypass, shows up as a count that
  // only climbs. Default -1 = the backend doesn't track it.
  virtual int32_t liveResourceCount() const { return -1; }

  // Monotonic per-process instance identity. A process-global cache holding
  // resource HANDLES keyed by "the backend" (e.g. the text compositor's
  // atlas/PSO cache) must compare THIS, not the backend pointer: a
  // destroyed-then-recreated backend can land on the same heap address, and the
  // stale handles then index arbitrary slots in the NEW backend's resource
  // table (observed as replaceRegion: hitting a _MTLLibrary).
  uint64_t instanceSerial() const { return instance_serial_; }

 protected:
  // See setDefaultTextureFormat. TextureFormat code, 1 = RGBA8.
  int32_t defaultTextureFormatCode_ = 1;

 private:
  inline static std::atomic<uint64_t> s_next_serial_{1};
  const uint64_t instance_serial_ = s_next_serial_.fetch_add(1);
};

// Factory
std::unique_ptr<GPUBackend> createMetalBackend();

} // namespace gpu
