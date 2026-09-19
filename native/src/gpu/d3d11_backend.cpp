// d3d11_backend.cpp — the Windows gpu::GPUBackend.
//
// Twin of metal_backend.mm. D3D11 rather than D3D12 on purpose: its resource
// states are driver-tracked, so there are no explicit barriers to thread
// through a flat handle table, and its single immediate context maps onto the
// Metal backend's one-command-buffer structure almost directly.
//
// Everything is loaded with LoadLibrary/GetProcAddress rather than linked, so
// this needs no import libraries at all — which keeps the cross-compile from
// macOS honest, and means a missing d3dcompiler_47.dll is a clear runtime
// error instead of a link failure on a machine that cannot reproduce it.
//
// SHADERS ARRIVE AS HLSL TEXT and are compiled to DXBC here, at runtime, by
// D3DCompile. D3D11 will not accept DXIL, and DXBC cannot be produced off
// Windows, so unlike the SPIR-V baking this genuinely cannot move to build
// time. Microsoft's d3dcompiler_47.dll must sit beside the binary: wine's
// builtin one rejects valid HLSL (it has no RWByteAddressBuffer::InterlockedAdd)
// and the failure looks exactly like a GPU fault.

#include "gpu/gpu_backend.h"

#include <windows.h>
#include <d3d11_1.h>
#include <d3dcompiler.h>

#include <cstdio>
#include <cstring>
#include <unordered_map>
#include <vector>

namespace gpu {
namespace {

// Abort loudly on a failed HRESULT when NANO_D3D_STRICT=1. There is no
// D3D11 validation layer under wine (D3D11SDKLayers.dll is absent), so the
// backend's own checking is the only diagnostic there is.
bool strictMode() {
  static const bool s = [] {
    const char* e = getenv("NANO_D3D_STRICT");
    return e && *e == '1';
  }();
  return s;
}

void hrFail(const char* what, HRESULT hr) {
  std::fprintf(stderr, "[d3d11] %s failed: hr=0x%08lx\n", what, (unsigned long)hr);
  std::fflush(stderr);
  if (strictMode()) std::abort();
}

/// Minimal intrusive COM pointer — mingw's <wrl/client.h> is not dependable
/// across toolchains and this is all we need from it.
template <typename T>
struct Com {
  T* p = nullptr;
  Com() = default;
  Com(const Com&) = delete;
  Com& operator=(const Com&) = delete;
  Com(Com&& o) noexcept : p(o.p) { o.p = nullptr; }
  Com& operator=(Com&& o) noexcept {
    if (this != &o) { reset(); p = o.p; o.p = nullptr; }
    return *this;
  }
  ~Com() { reset(); }
  void reset() { if (p) { p->Release(); p = nullptr; } }
  T** put() { reset(); return &p; }
  T* get() const { return p; }
  T* operator->() const { return p; }
  explicit operator bool() const { return p != nullptr; }
};

// --- TextureFormat enum (gpu.h) -> DXGI -------------------------------------
enum : int32_t {
  kFmtBGRA8 = 0, kFmtRGBA8 = 1, kFmtSurface = 2, kFmtRGBA16F = 3,
  kFmtR32F = 4, kFmtRGBA32F = 5, kFmtSketchDefault = 6,
  kFmtRGBA8_SRGB = 7, kFmtBC1 = 8,
};

DXGI_FORMAT dxgiFormat(int32_t code) {
  switch (code) {
    case kFmtBGRA8:      return DXGI_FORMAT_B8G8R8A8_UNORM;
    case kFmtRGBA8:      return DXGI_FORMAT_R8G8B8A8_UNORM;
    case kFmtRGBA16F:    return DXGI_FORMAT_R16G16B16A16_FLOAT;
    case kFmtR32F:       return DXGI_FORMAT_R32_FLOAT;
    case kFmtRGBA32F:    return DXGI_FORMAT_R32G32B32A32_FLOAT;
    case kFmtRGBA8_SRGB: return DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
    case kFmtBC1:        return DXGI_FORMAT_BC1_UNORM;
    default:             return DXGI_FORMAT_UNKNOWN;
  }
}

uint32_t bytesPerPixel(DXGI_FORMAT f) {
  switch (f) {
    case DXGI_FORMAT_R32G32B32A32_FLOAT: return 16;
    case DXGI_FORMAT_R16G16B16A16_FLOAT: return 8;
    case DXGI_FORMAT_R32_FLOAT:          return 4;
    default:                             return 4;
  }
}

bool isBlockCompressed(DXGI_FORMAT f) { return f == DXGI_FORMAT_BC1_UNORM; }

/// sRGB and block-compressed formats cannot be UAVs; everything else we use can.
bool canBeUav(DXGI_FORMAT f) {
  return f != DXGI_FORMAT_R8G8B8A8_UNORM_SRGB && !isBlockCompressed(f);
}

// --- the flat handle table --------------------------------------------------
enum class Kind { None, Buffer, Texture, Shader, ComputePSO, RenderPSO, Sampler };

struct Resource {
  Kind kind = Kind::None;

  // Buffer
  Com<ID3D11Buffer> buffer;
  uint64_t byteSize = 0;
  int32_t usage = 0;              // BufferUsage: 0=Vertex 1=Storage 2=Uniform
  Com<ID3D11ShaderResourceView> bufSrv;
  Com<ID3D11UnorderedAccessView> bufUav;

  // Texture
  Com<ID3D11Resource> texture;    // ID3D11Texture2D or Texture3D
  DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
  uint32_t width = 0, height = 0, depth = 1, mips = 1;
  Com<ID3D11ShaderResourceView> texSrv;
  std::unordered_map<int32_t, ID3D11UnorderedAccessView*> texUavByMip;
  Com<ID3D11RenderTargetView> texRtv;

  // Shader module: the HLSL source, compiled per entry point on demand.
  std::string source;

  // PSOs
  Com<ID3D11ComputeShader> cs;
  Com<ID3D11VertexShader> vs;
  Com<ID3D11PixelShader> ps;
  int32_t blendMode = 0;
  Com<ID3D11BlendState> blend;

  Com<ID3D11SamplerState> sampler;
};

using PFN_D3D11CreateDevice_t = HRESULT(WINAPI*)(
    IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL*,
    UINT, UINT, ID3D11Device**, D3D_FEATURE_LEVEL*, ID3D11DeviceContext**);
using PFN_D3DCompile_t = HRESULT(WINAPI*)(
    LPCVOID, SIZE_T, LPCSTR, const D3D_SHADER_MACRO*, ID3DInclude*, LPCSTR,
    LPCSTR, UINT, UINT, ID3DBlob**, ID3DBlob**);

class D3D11Backend : public GPUBackend {
 public:
  D3D11Backend() { init(); }
  ~D3D11Backend() override { resources_.clear(); }

  bool ok() const { return device_.get() != nullptr; }

  int32_t getBackend() override { return 2; }  // gpu::Backend::D3D11

  // --- creation ------------------------------------------------------------
  int32_t createShaderModule(const std::string& source) override {
    if (source.empty()) return -1;
    Resource r;
    r.kind = Kind::Shader;
    r.source = source;
    return store(std::move(r));
  }

  int32_t createBuffer(uint64_t size, int32_t usage) override {
    if (!device_ || size == 0) return -1;
    Resource r;
    r.kind = Kind::Buffer;
    r.byteSize = size;
    r.usage = usage;

    D3D11_BUFFER_DESC bd{};
    // Constant buffers must be a multiple of 16 bytes, and D3D11 rejects any
    // size that is not. Metal has no such rule, so callers do not round.
    bd.ByteWidth = (usage == 2) ? (UINT)((size + 15) & ~(uint64_t)15) : (UINT)size;
    bd.Usage = D3D11_USAGE_DEFAULT;
    if (usage == 2) {
      bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    } else {
      // Storage AND vertex buffers both arrive as raw byte address buffers:
      // SPIRV-Cross emits ByteAddressBuffer for every SPIR-V storage buffer,
      // and the vertex path here is procedural (pull from an SRV, no IA).
      bd.BindFlags = D3D11_BIND_UNORDERED_ACCESS | D3D11_BIND_SHADER_RESOURCE;
      bd.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS |
                     D3D11_RESOURCE_MISC_DRAWINDIRECT_ARGS;
      bd.ByteWidth = (UINT)((size + 3) & ~(uint64_t)3);  // raw views need 4-byte multiples
    }
    HRESULT hr = device_->CreateBuffer(&bd, nullptr, r.buffer.put());
    if (FAILED(hr)) { hrFail("CreateBuffer", hr); return -1; }

    if (usage != 2) {
      D3D11_UNORDERED_ACCESS_VIEW_DESC ud{};
      ud.Format = DXGI_FORMAT_R32_TYPELESS;
      ud.ViewDimension = D3D11_UAV_DIMENSION_BUFFER;
      ud.Buffer.NumElements = bd.ByteWidth / 4;
      ud.Buffer.Flags = D3D11_BUFFER_UAV_FLAG_RAW;
      hr = device_->CreateUnorderedAccessView(r.buffer.get(), &ud, r.bufUav.put());
      if (FAILED(hr)) hrFail("CreateUnorderedAccessView(buffer)", hr);

      D3D11_SHADER_RESOURCE_VIEW_DESC sd{};
      sd.Format = DXGI_FORMAT_R32_TYPELESS;
      sd.ViewDimension = D3D11_SRV_DIMENSION_BUFFEREX;
      sd.BufferEx.NumElements = bd.ByteWidth / 4;
      sd.BufferEx.Flags = D3D11_BUFFEREX_SRV_FLAG_RAW;
      hr = device_->CreateShaderResourceView(r.buffer.get(), &sd, r.bufSrv.put());
      if (FAILED(hr)) hrFail("CreateShaderResourceView(buffer)", hr);
    }
    return store(std::move(r));
  }

  int32_t createTexture(uint32_t w, uint32_t h, int32_t format) override {
    return createTextureWithMips(w, h, format, 1);
  }

  int32_t createTextureWithMips(uint32_t w, uint32_t h, int32_t format,
                                int32_t mipCount) override {
    if (!device_ || w == 0 || h == 0) return -1;
    const DXGI_FORMAT f = resolveFormat(format);
    if (f == DXGI_FORMAT_UNKNOWN) return -1;

    Resource r;
    r.kind = Kind::Texture;
    r.format = f;
    r.width = w; r.height = h; r.depth = 1;
    r.mips = mipCount < 1 ? 1 : (uint32_t)mipCount;

    D3D11_TEXTURE2D_DESC td{};
    td.Width = w; td.Height = h;
    td.MipLevels = r.mips; td.ArraySize = 1;
    td.Format = f;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    if (canBeUav(f)) td.BindFlags |= D3D11_BIND_UNORDERED_ACCESS;
    if (!isBlockCompressed(f)) td.BindFlags |= D3D11_BIND_RENDER_TARGET;

    Com<ID3D11Texture2D> tex;
    HRESULT hr = device_->CreateTexture2D(&td, nullptr, tex.put());
    if (FAILED(hr)) { hrFail("CreateTexture2D", hr); return -1; }
    r.texture.p = tex.p; tex.p = nullptr;  // transfer ownership as ID3D11Resource

    makeTextureViews(r);
    return store(std::move(r));
  }

  int32_t createTexture3D(uint32_t w, uint32_t h, uint32_t d,
                          int32_t format) override {
    if (!device_ || !w || !h || !d) return -1;
    const DXGI_FORMAT f = resolveFormat(format);
    if (f == DXGI_FORMAT_UNKNOWN) return -1;

    Resource r;
    r.kind = Kind::Texture;
    r.format = f; r.width = w; r.height = h; r.depth = d; r.mips = 1;

    D3D11_TEXTURE3D_DESC td{};
    td.Width = w; td.Height = h; td.Depth = d;
    td.MipLevels = 1; td.Format = f;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    if (canBeUav(f)) td.BindFlags |= D3D11_BIND_UNORDERED_ACCESS;

    Com<ID3D11Texture3D> tex;
    HRESULT hr = device_->CreateTexture3D(&td, nullptr, tex.put());
    if (FAILED(hr)) { hrFail("CreateTexture3D", hr); return -1; }
    r.texture.p = tex.p; tex.p = nullptr;

    makeTextureViews(r);
    return store(std::move(r));
  }

  int32_t getTextureWidth(int32_t h) override {
    Resource* r = get(h, Kind::Texture); return r ? (int32_t)r->width : 0;
  }
  int32_t getTextureHeight(int32_t h) override {
    Resource* r = get(h, Kind::Texture); return r ? (int32_t)r->height : 0;
  }
  int32_t getTextureFormat(int32_t h) override {
    Resource* r = get(h, Kind::Texture);
    if (!r) return -1;
    switch (r->format) {
      case DXGI_FORMAT_B8G8R8A8_UNORM:      return kFmtBGRA8;
      case DXGI_FORMAT_R8G8B8A8_UNORM:      return kFmtRGBA8;
      case DXGI_FORMAT_R16G16B16A16_FLOAT:  return kFmtRGBA16F;
      case DXGI_FORMAT_R32_FLOAT:           return kFmtR32F;
      case DXGI_FORMAT_R32G32B32A32_FLOAT:  return kFmtRGBA32F;
      case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB: return kFmtRGBA8_SRGB;
      case DXGI_FORMAT_BC1_UNORM:           return kFmtBC1;
      default:                              return -1;
    }
  }

  int32_t createSampler(const SamplerDesc& d) override {
    if (!device_) return -1;
    Resource r;
    r.kind = Kind::Sampler;
    D3D11_SAMPLER_DESC sd{};
    const bool lin = d.minFilter == 1 && d.magFilter == 1;
    sd.Filter = d.maxAnisotropy > 1 ? D3D11_FILTER_ANISOTROPIC
              : lin ? D3D11_FILTER_MIN_MAG_MIP_LINEAR
                    : D3D11_FILTER_MIN_MAG_MIP_POINT;
    const auto addr = [](int32_t m) {
      switch (m) {
        case 1:  return D3D11_TEXTURE_ADDRESS_WRAP;
        case 2:  return D3D11_TEXTURE_ADDRESS_MIRROR;
        default: return D3D11_TEXTURE_ADDRESS_CLAMP;
      }
    };
    sd.AddressU = addr(d.addressU);
    sd.AddressV = addr(d.addressV);
    sd.AddressW = addr(d.addressW);
    sd.MaxAnisotropy = (UINT)(d.maxAnisotropy < 1 ? 1 : d.maxAnisotropy);
    sd.MinLOD = d.lodMinClamp;
    sd.MaxLOD = d.lodMaxClamp;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    HRESULT hr = device_->CreateSamplerState(&sd, r.sampler.put());
    if (FAILED(hr)) { hrFail("CreateSamplerState", hr); return -1; }
    return store(std::move(r));
  }

  int32_t createComputePSO(int32_t shaderHandle,
                           const std::string& entryPoint) override {
    Resource* sh = get(shaderHandle, Kind::Shader);
    if (!sh || !device_) return -1;
    Com<ID3DBlob> blob;
    if (!compile(sh->source, entryPoint, "cs_5_0", blob)) return -1;
    Resource r;
    r.kind = Kind::ComputePSO;
    HRESULT hr = device_->CreateComputeShader(blob->GetBufferPointer(),
                                              blob->GetBufferSize(), nullptr,
                                              r.cs.put());
    if (FAILED(hr)) { hrFail("CreateComputeShader", hr); return -1; }
    return store(std::move(r));
  }

  int32_t createRenderPSO(int32_t vsHandle, const std::string& vsEntry,
                          int32_t fsHandle, const std::string& fsEntry,
                          int32_t format) override {
    (void)format;
    return makeRenderPSO(vsHandle, vsEntry, fsHandle, fsEntry, /*blend*/0);
  }

  int32_t createInstancedRenderPSO(int32_t vsHandle, const std::string& vsEntry,
                                   int32_t fsHandle, const std::string& fsEntry,
                                   int32_t format, int32_t blendMode) override {
    (void)format;
    return makeRenderPSO(vsHandle, vsEntry, fsHandle, fsEntry, blendMode);
  }

  // --- writes / copies -----------------------------------------------------
  void writeBuffer(int32_t bufHandle, uint32_t offset,
                   const uint8_t* data, uint32_t len) override {
    Resource* r = get(bufHandle, Kind::Buffer);
    if (!r || !r->buffer || !data || !len) return;
    // UpdateSubresource is queued INTO the command stream, so each dispatch
    // sees the latest write that preceded its encode. That is exactly the
    // semantic metal_backend.mm has to emulate by swapping in a fresh buffer
    // and memcpying (see its writeBuffer) — here it comes for free, so the
    // versioning hack is deliberately NOT ported.
    D3D11_BOX box{};
    box.left = offset; box.right = offset + len;
    box.top = 0; box.bottom = 1; box.front = 0; box.back = 1;
    // A constant buffer must be updated whole; partial box updates are illegal.
    if (r->usage == 2) ctx_->UpdateSubresource(r->buffer.get(), 0, nullptr, data, 0, 0);
    else               ctx_->UpdateSubresource(r->buffer.get(), 0, &box, data, 0, 0);
  }

  int readBuffer(int32_t bufHandle, uint32_t offset, void* dst,
                 uint32_t len) override {
    Resource* r = get(bufHandle, Kind::Buffer);
    if (!r || !r->buffer || !dst || !len) return 0;
    D3D11_BUFFER_DESC bd{};
    r->buffer->GetDesc(&bd);
    D3D11_BUFFER_DESC sd = bd;
    sd.Usage = D3D11_USAGE_STAGING;
    sd.BindFlags = 0;
    sd.MiscFlags = 0;
    sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    Com<ID3D11Buffer> staging;
    HRESULT hr = device_->CreateBuffer(&sd, nullptr, staging.put());
    if (FAILED(hr)) { hrFail("CreateBuffer(staging)", hr); return 0; }
    ctx_->CopyResource(staging.get(), r->buffer.get());
    ctx_->Flush();
    D3D11_MAPPED_SUBRESOURCE m{};
    hr = ctx_->Map(staging.get(), 0, D3D11_MAP_READ, 0, &m);
    if (FAILED(hr)) { hrFail("Map(staging buffer)", hr); return 0; }
    const uint32_t avail = (offset < bd.ByteWidth) ? (bd.ByteWidth - offset) : 0;
    const uint32_t n = len < avail ? len : avail;
    if (n) std::memcpy(dst, (const uint8_t*)m.pData + offset, n);
    ctx_->Unmap(staging.get(), 0);
    return (int)n;
  }

  void writeTexture(int32_t textureHandle, uint32_t w, uint32_t h,
                    const uint8_t* bytes, uint32_t byteCount) override {
    Resource* r = get(textureHandle, Kind::Texture);
    if (!r || !r->texture || !bytes || !byteCount) return;
    const uint32_t rowPitch = isBlockCompressed(r->format)
        ? ((w + 3) / 4) * 8
        : w * bytesPerPixel(r->format);
    (void)h;
    ctx_->UpdateSubresource(r->texture.get(), 0, nullptr, bytes, rowPitch, 0);
  }

  void clearTexture(int32_t textureHandle, float r_, float g, float b,
                    float a) override {
    Resource* r = get(textureHandle, Kind::Texture);
    if (!r || !r->texRtv) return;
    const float c[4] = { r_, g, b, a };
    ctx_->ClearRenderTargetView(r->texRtv.get(), c);
  }

  void copyTexture(int32_t src, int32_t dst) override {
    Resource* s = get(src, Kind::Texture);
    Resource* d = get(dst, Kind::Texture);
    if (!s || !d || !s->texture || !d->texture) return;
    if (s->format == d->format) {
      ctx_->CopyResource(d->texture.get(), s->texture.get());
      return;
    }
    // DIFFERENT FORMATS: a copy moves BYTES, so blitting BGRA8 into RGBA8 (or
    // back) silently swaps red and blue — blue comes out orange. That boundary
    // is real: FFGL interop textures are BGRA8 while executor intermediates are
    // RGBA8. Go through a shader, which reads and writes THROUGH the formats
    // and gets the channel order right on both sides. Mirrors
    // metal_backend.mm's copyTexture. Pinned by test_texture_copy_format.
    if (!ensureFormatCopyPso()) return;
    ID3D11ShaderResourceView* srv = s->texSrv.get();
    ID3D11UnorderedAccessView* uav = uavForMip(*d, 0);
    if (!srv || !uav) return;
    ctx_->CSSetShader(formatCopyCs_.get(), nullptr, 0);
    ctx_->CSSetShaderResources(0, 1, &srv);
    ctx_->CSSetUnorderedAccessViews(0, 1, &uav, nullptr);
    ctx_->Dispatch((d->width + 7) / 8, (d->height + 7) / 8, 1);
    unbindCompute();
  }

  // --- compute -------------------------------------------------------------
  int32_t beginComputePass() override { return ++passCounter_; }

  void computeSetPSO(int32_t pass, int32_t pso) override {
    (void)pass;
    Resource* r = get(pso, Kind::ComputePSO);
    if (r && r->cs) ctx_->CSSetShader(r->cs.get(), nullptr, 0);
  }

  void computeSetBuffer(int32_t pass, int32_t buf, uint32_t offset,
                        int32_t slot) override {
    (void)pass; (void)offset;
    Resource* r = get(buf, Kind::Buffer);
    if (!r) return;
    if (r->usage == 2) {
      ID3D11Buffer* b = r->buffer.get();
      ctx_->CSSetConstantBuffers((UINT)slot, 1, &b);
    } else if (r->bufUav) {
      ID3D11UnorderedAccessView* u = r->bufUav.get();
      ctx_->CSSetUnorderedAccessViews((UINT)slot, 1, &u, nullptr);
    }
  }

  void computeSetTexture(int32_t pass, int32_t textureHandle, int32_t slot,
                         int32_t access) override {
    computeSetTextureMip(pass, textureHandle, slot, access, 0);
  }

  void computeSetTextureMip(int32_t pass, int32_t textureHandle, int32_t slot,
                            int32_t access, int32_t mipLevel) override {
    (void)pass;
    Resource* r = get(textureHandle, Kind::Texture);
    if (!r) return;
    // Metal binds ONE texture object regardless of access and ignores the arg.
    // D3D11 needs an SRV to read and a UAV to write, and they are different
    // descriptors — so `access` finally matters here. 0=read 1=write 2=rw.
    if (access == 0) {
      ID3D11ShaderResourceView* srv = r->texSrv.get();
      ctx_->CSSetShaderResources((UINT)slot, 1, &srv);
    } else {
      ID3D11UnorderedAccessView* uav = uavForMip(*r, mipLevel);
      if (uav) ctx_->CSSetUnorderedAccessViews((UINT)slot, 1, &uav, nullptr);
    }
  }

  void computeSetSampler(int32_t pass, int32_t samplerHandle,
                         int32_t slot) override {
    (void)pass;
    Resource* r = get(samplerHandle, Kind::Sampler);
    if (!r || !r->sampler) return;
    ID3D11SamplerState* s = r->sampler.get();
    ctx_->CSSetSamplers((UINT)slot, 1, &s);
  }

  void computeDispatch(int32_t pass, uint32_t x, uint32_t y,
                       uint32_t z) override {
    (void)pass;
    // Group COUNTS, exactly like Metal's dispatchThreadgroups. The workgroup
    // size itself is baked into the HLSL by [numthreads], so none of the
    // `// nano_threadgroup:` hint machinery the Metal path needs applies here.
    if (x && y && z) ctx_->Dispatch(x, y, z);
  }

  void computeDispatchIndirect(int32_t pass, int32_t argsBuf,
                               uint64_t offset) override {
    (void)pass;
    Resource* r = get(argsBuf, Kind::Buffer);
    if (r && r->buffer) ctx_->DispatchIndirect(r->buffer.get(), (UINT)offset);
  }

  void endComputePass(int32_t pass) override { (void)pass; unbindCompute(); }

  // --- render (Stage 6; deliberately inert for now) ------------------------
  int32_t beginRenderPass(int32_t textureHandle, float cr, float cg, float cb,
                          float ca) override {
    Resource* r = get(textureHandle, Kind::Texture);
    if (!r || !r->texRtv) return -1;
    const float c[4] = { cr, cg, cb, ca };
    ctx_->ClearRenderTargetView(r->texRtv.get(), c);
    ID3D11RenderTargetView* rtv = r->texRtv.get();
    ctx_->OMSetRenderTargets(1, &rtv, nullptr);
    setViewport(r->width, r->height);
    return ++passCounter_;
  }

  void renderSetPSO(int32_t pass, int32_t pso) override {
    (void)pass;
    Resource* r = get(pso, Kind::RenderPSO);
    if (!r) return;
    ctx_->VSSetShader(r->vs.get(), nullptr, 0);
    ctx_->PSSetShader(r->ps.get(), nullptr, 0);
    ctx_->IASetInputLayout(nullptr);
    ctx_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    if (r->blend) ctx_->OMSetBlendState(r->blend.get(), nullptr, 0xffffffff);
  }

  void renderSetVertexBuffer(int32_t pass, int32_t buf, uint32_t offset,
                             int32_t slot) override {
    (void)pass; (void)buf; (void)offset; (void)slot;
  }

  void renderDraw(int32_t pass, uint32_t vertexCount,
                  uint32_t instanceCount) override {
    (void)pass;
    if (!vertexCount) return;
    ctx_->DrawInstanced(vertexCount, instanceCount ? instanceCount : 1, 0, 0);
  }

  void endRenderPass(int32_t pass) override {
    (void)pass;
    ID3D11RenderTargetView* none = nullptr;
    ctx_->OMSetRenderTargets(1, &none, nullptr);
  }

  // --- submit / surface ----------------------------------------------------
  void submit() override { if (ctx_) ctx_->Flush(); }

  void setSurface(int32_t textureHandle, uint32_t w, uint32_t h) override {
    surface_ = textureHandle; surfaceW_ = w; surfaceH_ = h;
  }
  int32_t getSurfaceTexture() override { return surface_; }
  int32_t getSurfaceWidth() override { return (int32_t)surfaceW_; }
  int32_t getSurfaceHeight() override { return (int32_t)surfaceH_; }

  // --- readback ------------------------------------------------------------
  std::vector<uint8_t> readbackTexture(int32_t textureHandle, uint32_t w,
                                       uint32_t h) override {
    Resource* r = get(textureHandle, Kind::Texture);
    if (!r || !r->texture || !w || !h) return {};

    D3D11_TEXTURE2D_DESC td{};
    ((ID3D11Texture2D*)r->texture.get())->GetDesc(&td);
    td.Usage = D3D11_USAGE_STAGING;
    td.BindFlags = 0;
    td.MiscFlags = 0;
    td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    Com<ID3D11Texture2D> staging;
    HRESULT hr = device_->CreateTexture2D(&td, nullptr, staging.put());
    if (FAILED(hr)) { hrFail("CreateTexture2D(staging)", hr); return {}; }

    ctx_->CopyResource(staging.get(), r->texture.get());
    ctx_->Flush();
    D3D11_MAPPED_SUBRESOURCE m{};
    hr = ctx_->Map(staging.get(), 0, D3D11_MAP_READ, 0, &m);
    if (FAILED(hr)) { hrFail("Map(staging texture)", hr); return {}; }

    const uint32_t bpp = bytesPerPixel(r->format);
    std::vector<uint8_t> out((size_t)w * h * bpp);
    for (uint32_t y = 0; y < h; ++y) {
      std::memcpy(out.data() + (size_t)y * w * bpp,
                  (const uint8_t*)m.pData + (size_t)y * m.RowPitch,
                  (size_t)w * bpp);
    }
    ctx_->Unmap(staging.get(), 0);
    return out;
  }

  std::vector<uint8_t> readbackTextureScaled(int32_t textureHandle,
                                             uint32_t srcW, uint32_t srcH,
                                             uint32_t dstW,
                                             uint32_t dstH) override {
    // Metal uses MPSImageLanczosScale; there is no D3D equivalent, and the one
    // consumer in scope (preview thumbnails) checks a flat-colour mean, so a
    // box filter is sufficient and obviously correct.
    auto full = readbackTexture(textureHandle, srcW, srcH);
    if (full.empty() || !dstW || !dstH) return {};
    Resource* r = get(textureHandle, Kind::Texture);
    const uint32_t bpp = r ? bytesPerPixel(r->format) : 4;
    std::vector<uint8_t> out((size_t)dstW * dstH * bpp);
    for (uint32_t y = 0; y < dstH; ++y) {
      const uint32_t sy = srcH ? (y * srcH / dstH) : 0;
      for (uint32_t x = 0; x < dstW; ++x) {
        const uint32_t sx = srcW ? (x * srcW / dstW) : 0;
        std::memcpy(out.data() + ((size_t)y * dstW + x) * bpp,
                    full.data() + ((size_t)sy * srcW + sx) * bpp, bpp);
      }
    }
    return out;
  }

  // --- lifetime ------------------------------------------------------------
  void release(int32_t handle) override {
    if (handle < 0 || (size_t)handle >= resources_.size()) return;
    Resource& r = resources_[handle];
    for (auto& kv : r.texUavByMip) if (kv.second) kv.second->Release();
    r.texUavByMip.clear();
    r = Resource{};
    free_.push_back(handle);
  }

  int32_t liveResourceCount() const override {
    int32_t n = 0;
    for (const auto& r : resources_) if (r.kind != Kind::None) ++n;
    return n;
  }

 private:
  void init() {
    HMODULE d3d11 = LoadLibraryA("d3d11.dll");
    if (!d3d11) { std::fprintf(stderr, "[d3d11] d3d11.dll not found\n"); return; }
    auto create = (PFN_D3D11CreateDevice_t)GetProcAddress(d3d11, "D3D11CreateDevice");
    if (!create) { std::fprintf(stderr, "[d3d11] no D3D11CreateDevice\n"); return; }

    HMODULE comp = LoadLibraryA("d3dcompiler_47.dll");
    if (comp) compile_ = (PFN_D3DCompile_t)GetProcAddress(comp, "D3DCompile");
    if (!compile_) {
      std::fprintf(stderr,
          "[d3d11] d3dcompiler_47.dll not usable — no shader can be compiled. "
          "Ship Microsoft's copy beside the binary.\n");
    }

    // 11_1 specifically, not 11_0: feature level 11_0 caps compute UAVs at 8,
    // and line_reconstruct/features.hlsl already binds u8/u9/u10. Failing here
    // is far better than mis-binding silently at dispatch time.
    const D3D_FEATURE_LEVEL want[] = { D3D_FEATURE_LEVEL_11_1 };
    D3D_FEATURE_LEVEL got{};
    HRESULT hr = create(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, want, 1,
                        D3D11_SDK_VERSION, device_.put(), &got, ctx_.put());
    if (FAILED(hr)) {
      hrFail("D3D11CreateDevice(HARDWARE, 11_1)", hr);
      return;
    }
    std::fprintf(stderr, "[d3d11] device up at feature level 0x%04x\n",
                 (unsigned)got);
    std::fflush(stderr);
  }

  DXGI_FORMAT resolveFormat(int32_t code) {
    if (code == kFmtSketchDefault) code = defaultTextureFormatCode_;
    if (code == kFmtSurface) {
      Resource* s = get(surface_, Kind::Texture);
      return s ? s->format : DXGI_FORMAT_R8G8B8A8_UNORM;
    }
    return dxgiFormat(code);
  }

  void makeTextureViews(Resource& r) {
    HRESULT hr = device_->CreateShaderResourceView(r.texture.get(), nullptr,
                                                   r.texSrv.put());
    if (FAILED(hr)) hrFail("CreateShaderResourceView(texture)", hr);
    if (!isBlockCompressed(r.format) && r.depth == 1) {
      hr = device_->CreateRenderTargetView(r.texture.get(), nullptr,
                                           r.texRtv.put());
      if (FAILED(hr)) hrFail("CreateRenderTargetView", hr);
    }
  }

  /// One UAV per mip, cached. Reading mip N while writing mip M of the same
  /// texture has to touch different subresources or D3D11 unbinds one of them.
  ID3D11UnorderedAccessView* uavForMip(Resource& r, int32_t mip) {
    if (!canBeUav(r.format)) return nullptr;
    auto it = r.texUavByMip.find(mip);
    if (it != r.texUavByMip.end()) return it->second;
    D3D11_UNORDERED_ACCESS_VIEW_DESC ud{};
    ud.Format = r.format;
    if (r.depth > 1) {
      ud.ViewDimension = D3D11_UAV_DIMENSION_TEXTURE3D;
      ud.Texture3D.MipSlice = (UINT)mip;
      ud.Texture3D.WSize = r.depth;
    } else {
      ud.ViewDimension = D3D11_UAV_DIMENSION_TEXTURE2D;
      ud.Texture2D.MipSlice = (UINT)mip;
    }
    ID3D11UnorderedAccessView* uav = nullptr;
    HRESULT hr = device_->CreateUnorderedAccessView(r.texture.get(), &ud, &uav);
    if (FAILED(hr)) { hrFail("CreateUnorderedAccessView(texture)", hr); return nullptr; }
    r.texUavByMip[mip] = uav;
    return uav;
  }

  void unbindCompute() {
    ID3D11UnorderedAccessView* nullUavs[8] = {};
    ID3D11ShaderResourceView* nullSrvs[8] = {};
    ctx_->CSSetUnorderedAccessViews(0, 8, nullUavs, nullptr);
    ctx_->CSSetShaderResources(0, 8, nullSrvs);
    ctx_->CSSetShader(nullptr, nullptr, 0);
  }

  void setViewport(uint32_t w, uint32_t h) {
    D3D11_VIEWPORT vp{};
    vp.Width = (float)w; vp.Height = (float)h; vp.MaxDepth = 1.0f;
    ctx_->RSSetViewports(1, &vp);
    D3D11_RECT sc{ 0, 0, (LONG)w, (LONG)h };
    ctx_->RSSetScissorRects(1, &sc);
  }

  bool compile(const std::string& src, const std::string& entry,
               const char* target, Com<ID3DBlob>& out) {
    if (!compile_) return false;
    Com<ID3DBlob> err;
    HRESULT hr = compile_(src.data(), src.size(), "nano", nullptr, nullptr,
                          entry.c_str(), target, 0, 0, out.put(), err.put());
    if (FAILED(hr)) {
      std::fprintf(stderr, "[d3d11] compile %s (%s) failed: %s\n", entry.c_str(),
                   target,
                   err ? (const char*)err->GetBufferPointer() : "(no message)");
      std::fflush(stderr);
      if (strictMode()) std::abort();
      return false;
    }
    return true;
  }

  int32_t makeRenderPSO(int32_t vsHandle, const std::string& vsEntry,
                        int32_t fsHandle, const std::string& fsEntry,
                        int32_t blendMode) {
    Resource* v = get(vsHandle, Kind::Shader);
    Resource* f = get(fsHandle, Kind::Shader);
    if (!v || !f || !device_) return -1;
    Com<ID3DBlob> vb, pb;
    if (!compile(v->source, vsEntry, "vs_5_0", vb)) return -1;
    if (!compile(f->source, fsEntry, "ps_5_0", pb)) return -1;

    Resource r;
    r.kind = Kind::RenderPSO;
    r.blendMode = blendMode;
    HRESULT hr = device_->CreateVertexShader(vb->GetBufferPointer(),
                                             vb->GetBufferSize(), nullptr,
                                             r.vs.put());
    if (FAILED(hr)) { hrFail("CreateVertexShader", hr); return -1; }
    hr = device_->CreatePixelShader(pb->GetBufferPointer(), pb->GetBufferSize(),
                                    nullptr, r.ps.put());
    if (FAILED(hr)) { hrFail("CreatePixelShader", hr); return -1; }

    D3D11_BLEND_DESC bd{};
    auto& t = bd.RenderTarget[0];
    t.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    t.BlendOp = D3D11_BLEND_OP_ADD;
    t.BlendOpAlpha = D3D11_BLEND_OP_ADD;
    switch (blendMode) {
      case 1:  // additive
        t.BlendEnable = TRUE;
        t.SrcBlend = D3D11_BLEND_SRC_ALPHA;  t.DestBlend = D3D11_BLEND_ONE;
        t.SrcBlendAlpha = D3D11_BLEND_ONE;   t.DestBlendAlpha = D3D11_BLEND_ONE;
        break;
      case 2:  // replace
        t.BlendEnable = FALSE;
        t.SrcBlend = D3D11_BLEND_ONE; t.DestBlend = D3D11_BLEND_ZERO;
        t.SrcBlendAlpha = D3D11_BLEND_ONE; t.DestBlendAlpha = D3D11_BLEND_ZERO;
        break;
      default:  // alpha-over
        t.BlendEnable = TRUE;
        t.SrcBlend = D3D11_BLEND_SRC_ALPHA;
        t.DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        t.SrcBlendAlpha = D3D11_BLEND_ONE;
        t.DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        break;
    }
    hr = device_->CreateBlendState(&bd, r.blend.put());
    if (FAILED(hr)) hrFail("CreateBlendState", hr);
    return store(std::move(r));
  }

  bool ensureFormatCopyPso() {
    if (formatCopyCs_) return true;
    if (!compile_) return false;
    static const char* kSrc =
        "Texture2D<float4> src : register(t0);\n"
        "RWTexture2D<float4> dst : register(u0);\n"
        "[numthreads(8,8,1)]\n"
        "void main(uint3 gid : SV_DispatchThreadID) {\n"
        "  uint w, h; dst.GetDimensions(w, h);\n"
        "  if (gid.x >= w || gid.y >= h) return;\n"
        "  dst[gid.xy] = src.Load(int3(gid.xy, 0));\n"
        "}\n";
    Com<ID3DBlob> blob;
    if (!compile(kSrc, "main", "cs_5_0", blob)) return false;
    HRESULT hr = device_->CreateComputeShader(blob->GetBufferPointer(),
                                              blob->GetBufferSize(), nullptr,
                                              formatCopyCs_.put());
    if (FAILED(hr)) { hrFail("CreateComputeShader(format copy)", hr); return false; }
    return true;
  }

  int32_t store(Resource&& r) {
    if (!free_.empty()) {
      const int32_t h = free_.back();
      free_.pop_back();
      resources_[h] = std::move(r);
      return h;
    }
    resources_.push_back(std::move(r));
    return (int32_t)resources_.size() - 1;
  }

  Resource* get(int32_t h, Kind k) {
    if (h < 0 || (size_t)h >= resources_.size()) return nullptr;
    Resource* r = &resources_[h];
    return r->kind == k ? r : nullptr;
  }

  Com<ID3D11Device> device_;
  Com<ID3D11DeviceContext> ctx_;
  Com<ID3D11ComputeShader> formatCopyCs_;
  PFN_D3DCompile_t compile_ = nullptr;
  std::vector<Resource> resources_;
  std::vector<int32_t> free_;
  int32_t passCounter_ = 0;
  int32_t surface_ = -1;
  uint32_t surfaceW_ = 0, surfaceH_ = 0;
};

}  // namespace

std::unique_ptr<GPUBackend> createD3D11Backend() {
  auto b = std::make_unique<D3D11Backend>();
  if (!b->ok()) return nullptr;
  return b;
}

}  // namespace gpu
