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

#include <cstdarg>
#include <cstdio>
#include <cmath>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <string>
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

// Log every bind and dispatch when NANO_D3D_TRACE=1. Same reasoning as strict
// mode: with no validation layer and no PIX, a dispatch that binds nothing
// looks exactly like a dispatch that computes zero, and the only way to tell
// them apart is to watch the calls go by.
bool traceMode() {
  static const bool s = [] {
    const char* e = getenv("NANO_D3D_TRACE");
    return e && *e == '1';
  }();
  return s;
}

void trace(const char* fmt, ...) {
  if (!traceMode()) return;
  va_list ap;
  va_start(ap, fmt);
  std::fprintf(stderr, "[d3d11] ");
  std::vfprintf(stderr, fmt, ap);
  std::fputc('\n', stderr);
  va_end(ap);
  std::fflush(stderr);
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

/// IEEE half → float. Enough for a readback conversion: denormals flush and
/// NaN/Inf land on the clamp below, which is all a thumbnail needs.
float halfToFloat(uint16_t h) {
  const int sign = (h >> 15) & 1;
  const int exp = (h >> 10) & 0x1f;
  const int mant = h & 0x3ff;
  float v;
  if (exp == 0)        v = std::ldexp((float)mant, -24);
  else if (exp == 31)  v = mant ? 0.0f : 1e30f;   // NaN → 0, Inf → clamps to 1
  else                 v = std::ldexp((float)(mant + 1024), exp - 25);
  return sign ? -v : v;
}

/// One pixel of any format we readback, written as RGBA8. Float channels are
/// clamped to [0,1] and scaled — the same thing Metal's RGBA8 scratch does.
void toRgba8(DXGI_FORMAT f, const uint8_t* src, uint8_t* dst) {
  auto enc = [](float v) -> uint8_t {
    if (!(v > 0.0f)) return 0;                 // also catches NaN
    return v >= 1.0f ? 255 : (uint8_t)(v * 255.0f + 0.5f);
  };
  switch (f) {
    case DXGI_FORMAT_R16G16B16A16_FLOAT: {
      uint16_t h[4];
      std::memcpy(h, src, sizeof(h));
      for (int c = 0; c < 4; ++c) dst[c] = enc(halfToFloat(h[c]));
      return;
    }
    case DXGI_FORMAT_R32G32B32A32_FLOAT: {
      float v[4];
      std::memcpy(v, src, sizeof(v));
      for (int c = 0; c < 4; ++c) dst[c] = enc(v[c]);
      return;
    }
    case DXGI_FORMAT_R32_FLOAT: {
      float v;
      std::memcpy(&v, src, sizeof(v));
      dst[0] = enc(v); dst[1] = 0; dst[2] = 0; dst[3] = 255;
      return;
    }
    default:
      std::memcpy(dst, src, 4);
      return;
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
  uint32_t width = 0, height = 0, depth = 1, mips = 1, layers = 1;
  Com<ID3D11ShaderResourceView> texSrv;
  std::unordered_map<int32_t, ID3D11UnorderedAccessView*> texUavByMip;
  Com<ID3D11RenderTargetView> texRtv;
  // The texture's actual D3D11_BIND_* flags. Views are gated on these: an
  // ADOPTED texture is whatever its creator made it, and asking D3D11 for a
  // view a texture wasn't bound for is a hard failure, not a soft one.
  uint32_t bindFlags = 0;

  // Shader module: the HLSL source, compiled per entry point on demand.
  std::string source;

  // PSOs
  Com<ID3D11ComputeShader> cs;
  Com<ID3D11VertexShader> vs;
  Com<ID3D11PixelShader> ps;
  int32_t blendMode = 0;
  Com<ID3D11BlendState> blend;
  // Non-null only for the fixed-vertex-format pipelines (createRenderPSO);
  // procedural/instanced ones draw with a null input layout.
  Com<ID3D11InputLayout> inputLayout;
  uint32_t vertexStride = 0;

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
  ~D3D11Backend() override {
    resources_.clear();
    for (auto& kv : blobCache_) if (kv.second) kv.second->Release();
  }

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

  // A storage buffer asks for more than it usually needs: VERTEX_BUFFER and
  // DRAWINDIRECT_ARGS go on every one of them because the `usage` code the
  // caller passed says nothing about whether the IA or an indirect draw will
  // later read it (see createBuffer). wined3d accepts that combination at any
  // size; a real driver does not always, and the first Windows machine to run
  // this rejected three 4-byte buffers with E_INVALIDARG while every larger
  // one succeeded.
  //
  // Rather than guess which rule bites, drop the speculative parts one at a
  // time and keep the first set the device accepts. Only UAV|SRV|ALLOW_RAW_VIEWS
  // is actually load-bearing — that is what SPIRV-Cross's ByteAddressBuffer
  // needs — so every tier below the first still renders correctly; a buffer
  // that later turns out to need the dropped flag fails at bind time with its
  // own message, not silently.
  //
  // The accepted tier is logged once, which is how the next machine tells us
  // what the rule was. The ladder is re-walked per buffer rather than latched,
  // because what failed was size-dependent — latching the first machine's
  // answer would strip flags from every large buffer that never needed it.
  // bd is taken by REFERENCE: a tier that pads ByteWidth changes the raw
  // view element counts the caller derives from it.
  HRESULT createStorageBufferFallback(D3D11_BUFFER_DESC& bd, Resource& r) {
    struct Tier { const char* what; UINT bind; UINT misc; UINT minWidth; };
    const UINT kRaw = D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
    const UINT kUavSrv = D3D11_BIND_UNORDERED_ACCESS | D3D11_BIND_SHADER_RESOURCE;
    const Tier tiers[] = {
      {"padded to 16 bytes",      bd.BindFlags, bd.MiscFlags, 16},
      {"without DRAWINDIRECT_ARGS", bd.BindFlags, kRaw, 0},
      {"without VERTEX_BUFFER",   kUavSrv, bd.MiscFlags, 0},
      {"UAV|SRV raw only",        kUavSrv, kRaw, 0},
      {"UAV|SRV raw, 16-byte",    kUavSrv, kRaw, 16},
    };
    const UINT want = bd.ByteWidth;
    for (const Tier& t : tiers) {
      D3D11_BUFFER_DESC try_bd = bd;
      try_bd.BindFlags = t.bind;
      try_bd.MiscFlags = t.misc;
      if (t.minWidth && try_bd.ByteWidth < t.minWidth) try_bd.ByteWidth = t.minWidth;
      if (try_bd.BindFlags == bd.BindFlags && try_bd.MiscFlags == bd.MiscFlags &&
          try_bd.ByteWidth == want)
        continue;   // identical to the attempt that already failed
      const HRESULT hr = device_->CreateBuffer(&try_bd, nullptr, r.buffer.put());
      if (SUCCEEDED(hr)) {
        static bool told = false;
        if (!told) {
          told = true;
          std::fprintf(stderr,
              "[d3d11] this driver rejects the full storage-buffer flag set at "
              "%u bytes; falling back to '%s' (reported once)\n",
              want, t.what);
          std::fflush(stderr);
        }
        bd = try_bd;
        return hr;
      }
    }
    r.buffer.reset();
    return E_INVALIDARG;
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
      // Storage buffers arrive as raw byte address buffers — SPIRV-Cross emits
      // ByteAddressBuffer for every SPIR-V storage buffer, read through an SRV
      // in raster and a UAV in compute (spv_to_hlsl.cpp).
      //
      // VERTEX_BUFFER goes on all of them, not just usage 0. The one buffer
      // that reaches IASetVertexBuffers (debug.gpu_test's) is FILLED by a
      // compute shader through a UAV first, so the usage code it was created
      // with says nothing about whether the IA will also read it. The flag is
      // free on a buffer nobody binds that way.
      bd.BindFlags = D3D11_BIND_UNORDERED_ACCESS | D3D11_BIND_SHADER_RESOURCE |
                     D3D11_BIND_VERTEX_BUFFER;
      bd.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS |
                     D3D11_RESOURCE_MISC_DRAWINDIRECT_ARGS;
      bd.ByteWidth = (UINT)((size + 3) & ~(uint64_t)3);  // raw views need 4-byte multiples
    }
    HRESULT hr = device_->CreateBuffer(&bd, nullptr, r.buffer.put());
    if (FAILED(hr) && usage != 2) hr = createStorageBufferFallback(bd, r);
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

    r.bindFlags = td.BindFlags;
    Com<ID3D11Texture2D> tex;
    HRESULT hr = device_->CreateTexture2D(&td, nullptr, tex.put());
    if (FAILED(hr)) { hrFail("CreateTexture2D", hr); return -1; }
    r.texture.p = tex.p; tex.p = nullptr;  // transfer ownership as ID3D11Resource

    makeTextureViews(r);
    return store(std::move(r));
  }

  // 2D-ARRAY texture: `layers` slices, one mip, sampled as Texture2DArray.
  // The host text compositor's multi-page MSDF atlas is the only user, and it
  // uploads per layer through writeTextureLayer. Not a UAV and not a render
  // target — a null SRV desc on an ArraySize>1 texture gives D3D11 the array
  // view it needs on its own.
  int32_t createTextureArray(uint32_t w, uint32_t h, int32_t format,
                             int32_t layers) override {
    if (!device_ || !w || !h) return -1;
    const DXGI_FORMAT f = resolveFormat(format);
    if (f == DXGI_FORMAT_UNKNOWN) return -1;

    Resource r;
    r.kind = Kind::Texture;
    r.format = f; r.width = w; r.height = h; r.depth = 1; r.mips = 1;
    r.layers = layers > 0 ? (uint32_t)layers : 1;

    D3D11_TEXTURE2D_DESC td{};
    td.Width = w; td.Height = h;
    td.MipLevels = 1; td.ArraySize = r.layers;
    td.Format = f;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;

    r.bindFlags = td.BindFlags;
    Com<ID3D11Texture2D> tex;
    HRESULT hr = device_->CreateTexture2D(&td, nullptr, tex.put());
    if (FAILED(hr)) { hrFail("CreateTexture2D(array)", hr); return -1; }
    r.texture.p = tex.p; tex.p = nullptr;

    makeTextureViews(r);
    return store(std::move(r));
  }

  void writeTextureLayer(int32_t textureHandle, int32_t layer, uint32_t w,
                         uint32_t h, const uint8_t* bytes,
                         uint32_t byteCount) override {
    Resource* r = get(textureHandle, Kind::Texture);
    if (!r || !r->texture || !bytes) return;
    if (layer < 0 || (uint32_t)layer >= r->layers) return;
    if (byteCount < w * h * 4) return;
    // Subresource index for (mip 0, slice `layer`) with one mip level.
    ctx_->UpdateSubresource(r->texture.get(), (UINT)layer, nullptr, bytes,
                            w * 4, w * h * 4);
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
    r.bindFlags = td.BindFlags;

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
    if (!sh || !device_) {
      trace("createComputePSO shader=%d -> NO SUCH SHADER", shaderHandle);
      return -1;
    }
    Com<ID3DBlob> blob;
    if (!compile(sh->source, entryPoint, "cs_5_0", blob)) return -1;
    Resource r;
    r.kind = Kind::ComputePSO;
    trace("createComputePSO shader=%d entry=%s -> %zu bytes of DXBC",
          shaderHandle, entryPoint.c_str(), (size_t)blob->GetBufferSize());
    HRESULT hr = device_->CreateComputeShader(blob->GetBufferPointer(),
                                              blob->GetBufferSize(), nullptr,
                                              r.cs.put());
    if (FAILED(hr)) { hrFail("CreateComputeShader", hr); return -1; }
    return store(std::move(r));
  }

  // The fixed vertex format: float2 position + float4 color, stride 24 — the
  // SAME layout metal_backend.mm hardcodes in its createRenderPSO, which is
  // what makes this the "there IS a vertex buffer" entry point as against
  // createInstancedRenderPSO's procedural one. The semantics are TEXCOORD0/1,
  // not POSITION/COLOR: SPIR-V carries only Location decorations, and
  // spirv-cross names every stage input TEXCOORD<location> on the way back out
  // (dump the HLSL for gpu_test/vertex.hlsl and you can read them off).
  int32_t createRenderPSO(int32_t vsHandle, const std::string& vsEntry,
                          int32_t fsHandle, const std::string& fsEntry,
                          int32_t format) override {
    (void)format;
    return makeRenderPSO(vsHandle, vsEntry, fsHandle, fsEntry, /*blend*/0,
                         /*withVertexLayout=*/true);
  }

  int32_t createInstancedRenderPSO(int32_t vsHandle, const std::string& vsEntry,
                                   int32_t fsHandle, const std::string& fsEntry,
                                   int32_t format, int32_t blendMode) override {
    (void)format;
    return makeRenderPSO(vsHandle, vsEntry, fsHandle, fsEntry, blendMode);
  }

  // MRT: the fragment shader's SV_Target<i> goes to attachment i, each with its
  // own blend mode. `targetFormats` is unused — unlike Metal and WebGPU, a
  // D3D11 PSO carries no attachment formats; they come from the RTVs bound at
  // draw time (bindTargets), and a mismatch is the driver's problem, not the
  // pipeline's.
  int32_t createInstancedRenderPSOMRT(int32_t vsHandle, const std::string& vsEntry,
                                      int32_t fsHandle, const std::string& fsEntry,
                                      int32_t targetCount,
                                      const int32_t* targetFormats,
                                      const int32_t* targetBlends) override {
    (void)targetFormats;
    if (targetCount <= 0 || targetCount > 8) return -1;
    const int32_t pso = makeRenderPSO(vsHandle, vsEntry, fsHandle, fsEntry,
                                      targetBlends ? targetBlends[0] : 0);
    if (pso < 0) return pso;
    if (targetCount == 1) return pso;
    // Per-target blend needs IndependentBlendEnable; replace the single-target
    // state makeRenderPSO built.
    D3D11_BLEND_DESC bd{};
    bd.IndependentBlendEnable = TRUE;
    for (int32_t i = 0; i < targetCount; ++i)
      fillBlendTarget(bd.RenderTarget[i], targetBlends ? targetBlends[i] : 0);
    Resource* r = get(pso, Kind::RenderPSO);
    if (!r) return pso;
    Com<ID3D11BlendState> blend;
    HRESULT hr = device_->CreateBlendState(&bd, blend.put());
    if (FAILED(hr)) { hrFail("CreateBlendState(MRT)", hr); return pso; }
    r->blend = std::move(blend);
    return pso;
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
    trace("computeSetPSO %d -> %s", pso, (r && r->cs) ? "ok" : "MISSING");
    if (r && r->cs) ctx_->CSSetShader(r->cs.get(), nullptr, 0);
  }

  void computeSetBuffer(int32_t pass, int32_t buf, uint32_t offset,
                        int32_t slot) override {
    (void)pass; (void)offset;
    Resource* r = get(buf, Kind::Buffer);
    trace("computeSetBuffer buf=%d slot=%d usage=%d -> %s", buf, slot,
          r ? r->usage : -1,
          !r ? "MISSING" : (r->usage == 2 ? "cbuffer" : (r->bufUav ? "uav" : "NO UAV")));
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
      trace("computeSetTexture tex=%d slot=t%d -> %s", textureHandle, slot,
            srv ? "srv" : "NO SRV");
      ctx_->CSSetShaderResources((UINT)slot, 1, &srv);
    } else {
      ID3D11UnorderedAccessView* uav = uavForMip(*r, mipLevel);
      trace("computeSetTexture tex=%d slot=u%d mip=%d -> %s", textureHandle,
            slot, mipLevel, uav ? "uav" : "NO UAV");
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
    trace("dispatch %ux%ux%u", x, y, z);
    if (x && y && z) ctx_->Dispatch(x, y, z);
  }

  void computeDispatchIndirect(int32_t pass, int32_t argsBuf,
                               uint64_t offset) override {
    (void)pass;
    Resource* r = get(argsBuf, Kind::Buffer);
    if (r && r->buffer) ctx_->DispatchIndirect(r->buffer.get(), (UINT)offset);
  }

  void endComputePass(int32_t pass) override { (void)pass; unbindCompute(); }

  // --- render --------------------------------------------------------------
  //
  // Everything here is PROCEDURAL: no input layout, no vertex buffer. The
  // vertex shader reads SV_VertexID / SV_InstanceID and pulls its geometry out
  // of a StructuredBuffer (see flash_particles/vs.hlsl and flow_swarm/vs.hlsl,
  // the canonical shape). That is why renderSetBuffer binds storage buffers as
  // SRVs rather than UAVs — D3D11 cannot give the vertex stage a UAV at all,
  // and spv_to_hlsl.cpp declares them accordingly for non-compute stages.
  int32_t beginRenderPass(int32_t textureHandle, float cr, float cg, float cb,
                          float ca) override {
    const float clear[4] = { cr, cg, cb, ca };
    const int32_t load = 0;
    return bindTargets(1, &textureHandle, clear, &load);
  }

  int32_t beginRenderPassLoad(int32_t textureHandle) override {
    const float clear[4] = { 0, 0, 0, 0 };
    const int32_t load = 1;
    return bindTargets(1, &textureHandle, clear, &load);
  }

  int32_t beginRenderPassMRT(int32_t count, const int32_t* texHandles,
                             const float* clears, const int32_t* loads) override {
    return bindTargets(count, texHandles, clears, loads);
  }

  void renderSetPSO(int32_t pass, int32_t pso) override {
    (void)pass;
    Resource* r = get(pso, Kind::RenderPSO);
    trace("renderSetPSO %d -> %s", pso, (r && r->vs) ? "ok" : "MISSING");
    if (!r) return;
    ctx_->VSSetShader(r->vs.get(), nullptr, 0);
    ctx_->PSSetShader(r->ps.get(), nullptr, 0);
    ctx_->IASetInputLayout(r->inputLayout.get());   // null = procedural
    vertexStride_ = r->vertexStride;
    ctx_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    if (r->blend) ctx_->OMSetBlendState(r->blend.get(), nullptr, 0xffffffff);
  }

  // Only the fixed-format pipelines use this; the instanced ones pull their
  // geometry from an SRV instead and never call it. The stride comes from the
  // PSO bound just before (renderSetPSO), because the ABI doesn't carry one —
  // Metal gets it from the pipeline's vertex descriptor for the same reason.
  void renderSetVertexBuffer(int32_t pass, int32_t buf, uint32_t offset,
                             int32_t slot) override {
    (void)pass;
    Resource* r = get(buf, Kind::Buffer);
    trace("renderSetVertexBuffer buf=%d slot=%d stride=%u -> %s", buf, slot,
          vertexStride_, (r && r->buffer) ? "ok" : "MISSING");
    if (!r || !r->buffer || !vertexStride_) return;
    ID3D11Buffer* b = r->buffer.get();
    UINT stride = vertexStride_, off = offset;
    ctx_->IASetVertexBuffers((UINT)slot, 1, &b, &stride, &off);
  }

  // Bound to BOTH stages, matching metal_backend.mm: a WGSL bind group is
  // stage-unified, and our shaders number registers across the whole VS+FS
  // pair (vs.hlsl takes t0/b1, fs.hlsl takes b2), so there is no collision.
  void renderSetBuffer(int32_t pass, int32_t buf, int32_t slot) override {
    (void)pass;
    Resource* r = get(buf, Kind::Buffer);
    trace("renderSetBuffer buf=%d slot=%d usage=%d -> %s", buf, slot,
          r ? r->usage : -1,
          !r ? "MISSING" : (r->usage == 2 ? "cbuffer" : (r->bufSrv ? "srv" : "NO SRV")));
    if (!r) return;
    if (r->usage == 2) {
      ID3D11Buffer* b = r->buffer.get();
      ctx_->VSSetConstantBuffers((UINT)slot, 1, &b);
      ctx_->PSSetConstantBuffers((UINT)slot, 1, &b);
    } else if (r->bufSrv) {
      ID3D11ShaderResourceView* srv = r->bufSrv.get();
      ctx_->VSSetShaderResources((UINT)slot, 1, &srv);
      ctx_->PSSetShaderResources((UINT)slot, 1, &srv);
    }
  }

  // Fragment stage only — the procedural vertex shaders never sample, and
  // metal_backend.mm binds it the same way. `access` is accepted for symmetry
  // with computeSetTexture; a render target is read-only here by construction.
  void renderSetTexture(int32_t pass, int32_t textureHandle, int32_t slot,
                        int32_t access) override {
    (void)pass; (void)access;
    Resource* r = get(textureHandle, Kind::Texture);
    if (!r) return;
    ID3D11ShaderResourceView* srv = r->texSrv.get();
    trace("renderSetTexture tex=%d slot=t%d -> %s", textureHandle, slot,
          srv ? "srv" : "NO SRV");
    ctx_->PSSetShaderResources((UINT)slot, 1, &srv);
  }

  void renderSetSampler(int32_t pass, int32_t samplerHandle,
                        int32_t slot) override {
    (void)pass;
    Resource* r = get(samplerHandle, Kind::Sampler);
    if (!r || !r->sampler) return;
    ID3D11SamplerState* smp = r->sampler.get();
    ctx_->PSSetSamplers((UINT)slot, 1, &smp);
  }

  void renderDraw(int32_t pass, uint32_t vertexCount,
                  uint32_t instanceCount) override {
    (void)pass;
    trace("renderDraw verts=%u instances=%u", vertexCount, instanceCount);
    if (!vertexCount) return;
    ctx_->DrawInstanced(vertexCount, instanceCount ? instanceCount : 1, 0, 0);
  }

  // Args are 4 × u32 {vertex_count, instance_count, first_vertex,
  // first_instance} — the WebGPU drawIndirect layout, which is byte-identical
  // to both MTLDrawPrimitivesIndirectArguments and what DrawInstancedIndirect
  // wants, so the buffer passes straight through.
  void renderDrawIndirect(int32_t pass, int32_t argsBuf,
                          uint64_t offset) override {
    (void)pass;
    Resource* r = get(argsBuf, Kind::Buffer);
    trace("renderDrawIndirect buf=%d offset=%llu -> %s", argsBuf,
          (unsigned long long)offset, (r && r->buffer) ? "ok" : "MISSING");
    if (r && r->buffer) ctx_->DrawInstancedIndirect(r->buffer.get(), (UINT)offset);
  }

  void endRenderPass(int32_t pass) override {
    (void)pass;
    unbindRender();
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
    //
    // The output is ALWAYS RGBA8, whatever the source format — the callers
    // (barrel preview capture) read 4 bytes per pixel. Metal gets that for free
    // by scaling into an RGBA8 scratch; here a float source has to be converted,
    // not reinterpreted, or a 16F sketch's thumbnail comes back at double size
    // and every channel is garbage.
    auto full = readbackTexture(textureHandle, srcW, srcH);
    if (full.empty() || !dstW || !dstH) return {};
    Resource* r = get(textureHandle, Kind::Texture);
    const DXGI_FORMAT fmt = r ? r->format : DXGI_FORMAT_R8G8B8A8_UNORM;
    const uint32_t bpp = bytesPerPixel(fmt);
    std::vector<uint8_t> out((size_t)dstW * dstH * 4);
    for (uint32_t y = 0; y < dstH; ++y) {
      const uint32_t sy = srcH ? (y * srcH / dstH) : 0;
      for (uint32_t x = 0; x < dstW; ++x) {
        const uint32_t sx = srcW ? (x * srcW / dstW) : 0;
        const uint8_t* src = full.data() + ((size_t)sy * srcW + sx) * bpp;
        uint8_t* dst = out.data() + ((size_t)y * dstW + x) * 4;
        toRgba8(fmt, src, dst);
      }
    }
    return out;
  }

  // Adopt a texture created OUTSIDE the backend — the FFGL barrel's interop
  // pair — and hand back a handle that binds that exact texture. The caller
  // keeps ownership: we AddRef for as long as the handle lives and Release on
  // release(), matching COM's rules rather than the raw-pointer transfer
  // createTexture does internally.
  //
  // The width/height/format come from the texture's own desc, so a caller
  // cannot mis-describe it. It must carry the bind flags the runtime needs
  // (SHADER_RESOURCE, plus UNORDERED_ACCESS for anything a compute effect
  // writes) — the views below are what fail loudly if it doesn't, since D3D11
  // has no way to add a bind flag after creation.
  int32_t adoptExternalTexture(void* nativeTexture) override {
    if (!device_ || !nativeTexture) return -1;
    auto* tex = static_cast<ID3D11Texture2D*>(nativeTexture);
    D3D11_TEXTURE2D_DESC td{};
    tex->GetDesc(&td);

    Resource r;
    r.kind = Kind::Texture;
    r.format = td.Format;
    r.width = td.Width; r.height = td.Height; r.depth = 1;
    r.mips = td.MipLevels ? td.MipLevels : 1;
    r.layers = td.ArraySize ? td.ArraySize : 1;
    r.bindFlags = td.BindFlags;

    tex->AddRef();
    r.texture.p = tex;
    makeTextureViews(r);
    return store(std::move(r));
  }

  // --- lifetime ------------------------------------------------------------
  void* nativeDevice() const override { return device_.get(); }

  void release(int32_t handle) override {
    if (handle <= 0 || (size_t)handle >= resources_.size()) return;
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
  /// CreateDXGIFactory1 without an import library, matching this file's rule
  /// that every D3D entry point is resolved at runtime (see CMakeLists).
  static IDXGIFactory1* makeDxgiFactory() {
    HMODULE dxgi = LoadLibraryA("dxgi.dll");
    if (!dxgi) return nullptr;
    using PFN = HRESULT(WINAPI*)(REFIID, void**);
    auto fn = (PFN)GetProcAddress(dxgi, "CreateDXGIFactory1");
    if (!fn) return nullptr;
    IDXGIFactory1* f = nullptr;
    return SUCCEEDED(fn(__uuidof(IDXGIFactory1), (void**)&f)) ? f : nullptr;
  }

  /// Resolve NANO_D3D_ADAPTER: a decimal DXGI index, or a case-insensitive
  /// fragment of the adapter description. Software adapters are skipped for a
  /// name match (nobody means WARP by "basic"), but an explicit index can
  /// still reach one. Returns null — meaning "use the default" — if nothing
  /// matches, and says so, because silently ignoring the variable would look
  /// exactly like the bug it was set to work around.
  Com<IDXGIAdapter> adapterMatching(const char* spec) {
    Com<IDXGIAdapter> out;
    IDXGIFactory1* factory = makeDxgiFactory();
    if (!factory) {
      std::fprintf(stderr, "[d3d11] NANO_D3D_ADAPTER set but DXGI is "
                           "unavailable; using the default adapter\n");
      return out;
    }
    char* end = nullptr;
    const long index = std::strtol(spec, &end, 10);
    const bool byIndex = end && *end == '\0' && end != spec && index >= 0;

    std::string needle(spec);
    for (char& c : needle) c = (char)std::tolower((unsigned char)c);

    IDXGIAdapter1* adapter = nullptr;
    for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
      DXGI_ADAPTER_DESC1 desc{};
      adapter->GetDesc1(&desc);
      char name[256] = {0};
      WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, name,
                          sizeof(name) - 1, nullptr, nullptr);
      std::string lower(name);
      for (char& c : lower) c = (char)std::tolower((unsigned char)c);

      const bool hit = byIndex
          ? ((long)i == index)
          : (lower.find(needle) != std::string::npos &&
             !(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE));
      if (hit) {
        std::fprintf(stderr, "[d3d11] NANO_D3D_ADAPTER='%s' selected [%u] %s\n",
                     spec, i, name);
        adapter->QueryInterface(__uuidof(IDXGIAdapter), (void**)out.put());
        adapter->Release();
        break;
      }
      adapter->Release();
    }
    factory->Release();
    if (!out.get())
      std::fprintf(stderr, "[d3d11] NANO_D3D_ADAPTER='%s' matched no adapter; "
                           "using the default\n", spec);
    std::fflush(stderr);
    return out;
  }

  /// The description of the adapter the live device is actually on.
  std::string deviceAdapterName() const {
    if (!device_.get()) return "(no device)";
    IDXGIDevice* dxgiDev = nullptr;
    if (FAILED(device_.get()->QueryInterface(__uuidof(IDXGIDevice),
                                             (void**)&dxgiDev)))
      return "(unknown adapter)";
    std::string out = "(unknown adapter)";
    IDXGIAdapter* a = nullptr;
    if (SUCCEEDED(dxgiDev->GetAdapter(&a)) && a) {
      DXGI_ADAPTER_DESC d{};
      if (SUCCEEDED(a->GetDesc(&d))) {
        char name[256] = {0};
        WideCharToMultiByte(CP_UTF8, 0, d.Description, -1, name,
                            sizeof(name) - 1, nullptr, nullptr);
        out = name;
      }
      a->Release();
    }
    dxgiDev->Release();
    return out;
  }

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

    // Which GPU. A null adapter means "the default", which on a hybrid laptop
    // is the integrated one — and that is usually right, because the engine
    // renders offscreen and never presents.
    //
    // It is NOT right when the barrel is in play. WGL_NV_DX_interop2 requires
    // the GL context and the D3D device to be on the SAME GPU, and the host's
    // GL context goes wherever the driver's application profile sends it,
    // which for a known VJ application is typically the discrete GPU. The two
    // choices disagreeing is a share that fails for a reason neither API
    // reports. NANO_D3D_ADAPTER is the escape hatch for exactly that: a
    // decimal DXGI index, or any case-insensitive fragment of the adapter
    // description ("nvidia", "quadro", "intel").
    Com<IDXGIAdapter> chosen;
    if (const char* pick = std::getenv("NANO_D3D_ADAPTER"); pick && *pick)
      chosen = adapterMatching(pick);

    // 11_1 specifically, not 11_0: feature level 11_0 caps compute UAVs at 8,
    // and line_reconstruct/features.hlsl already binds u8/u9/u10. Failing here
    // is far better than mis-binding silently at dispatch time.
    const D3D_FEATURE_LEVEL want[] = { D3D_FEATURE_LEVEL_11_1 };
    D3D_FEATURE_LEVEL got{};
    // Naming an adapter REQUIRES driver type UNKNOWN; HARDWARE with a non-null
    // adapter is E_INVALIDARG.
    HRESULT hr = create(chosen.get(),
                        chosen.get() ? D3D_DRIVER_TYPE_UNKNOWN
                                     : D3D_DRIVER_TYPE_HARDWARE,
                        nullptr, 0, want, 1,
                        D3D11_SDK_VERSION, device_.put(), &got, ctx_.put());
    if (FAILED(hr)) {
      hrFail("D3D11CreateDevice(HARDWARE, 11_1)", hr);
      return;
    }
    // Always say which GPU won. On a one-GPU machine this is noise; on a
    // hybrid laptop it is the first thing anybody reading a black-output
    // report needs to know.
    std::fprintf(stderr, "[d3d11] device up at feature level 0x%04x on %s\n",
                 (unsigned)got, deviceAdapterName().c_str());
    std::fflush(stderr);

    D3D11_RASTERIZER_DESC rd{};
    rd.FillMode = D3D11_FILL_SOLID;
    rd.CullMode = D3D11_CULL_NONE;     // Metal parity — see bindTargets
    rd.DepthClipEnable = TRUE;
    rd.ScissorEnable = TRUE;           // setViewport sets a matching rect
    hr = device_->CreateRasterizerState(&rd, raster_.put());
    if (FAILED(hr)) hrFail("CreateRasterizerState", hr);
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
    if (r.bindFlags & D3D11_BIND_SHADER_RESOURCE) {
      HRESULT hr = device_->CreateShaderResourceView(r.texture.get(), nullptr,
                                                     r.texSrv.put());
      if (FAILED(hr)) hrFail("CreateShaderResourceView(texture)", hr);
    }
    if ((r.bindFlags & D3D11_BIND_RENDER_TARGET) &&
        !isBlockCompressed(r.format) && r.depth == 1 && r.layers == 1) {
      HRESULT hr = device_->CreateRenderTargetView(r.texture.get(), nullptr,
                                                   r.texRtv.put());
      if (FAILED(hr)) hrFail("CreateRenderTargetView", hr);
    }
  }

  /// One UAV per mip, cached. Reading mip N while writing mip M of the same
  /// texture has to touch different subresources or D3D11 unbinds one of them.
  ID3D11UnorderedAccessView* uavForMip(Resource& r, int32_t mip) {
    if (!canBeUav(r.format) || !(r.bindFlags & D3D11_BIND_UNORDERED_ACCESS))
      return nullptr;
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

  // Bind `count` render targets, clearing or loading each. Returns a pass id,
  // or -1 if any target has no RTV (a block-compressed texture, say).
  int32_t bindTargets(int32_t count, const int32_t* handles,
                      const float* clears, const int32_t* loads) {
    if (count <= 0 || count > 8 || !handles) return -1;
    ID3D11RenderTargetView* rtvs[8] = {};
    uint32_t w = 0, h = 0;
    for (int32_t i = 0; i < count; ++i) {
      Resource* r = get(handles[i], Kind::Texture);
      if (!r || !r->texRtv) {
        trace("beginRenderPass target %d (tex=%d) -> NO RTV", i, handles[i]);
        return -1;
      }
      rtvs[i] = r->texRtv.get();
      if (i == 0) { w = r->width; h = r->height; }
      if (!loads || !loads[i]) {
        const float black[4] = { 0, 0, 0, 0 };
        ctx_->ClearRenderTargetView(rtvs[i], clears ? clears + i * 4 : black);
      }
    }
    // A render target that is still bound as a compute SRV/UAV would be
    // silently unbound by D3D11 the moment it becomes an RTV, and the warning
    // that says so only exists with the debug layer, which wine has no copy of.
    unbindCompute();
    ctx_->OMSetRenderTargets((UINT)count, rtvs, nullptr);
    // Metal rasterizes with no culling by default; D3D11 culls BACK faces. On
    // top of that the clip-space Y flip (spv_to_hlsl.cpp) REVERSES winding, so
    // leaving the default in place drops every triangle of a procedural quad
    // whose author never thought about winding — which is all of them.
    if (raster_) ctx_->RSSetState(raster_.get());
    setViewport(w, h);
    return ++passCounter_;
  }

  void unbindRender() {
    ID3D11RenderTargetView* noRtv[8] = {};
    ID3D11ShaderResourceView* noSrv[8] = {};
    ctx_->OMSetRenderTargets(8, noRtv, nullptr);
    ctx_->VSSetShaderResources(0, 8, noSrv);
    ctx_->PSSetShaderResources(0, 8, noSrv);
    ctx_->VSSetShader(nullptr, nullptr, 0);
    ctx_->PSSetShader(nullptr, nullptr, 0);
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

  // FXC is slow, and the same source gets compiled repeatedly: every effect
  // instance builds its own PSOs, and an effect with six entry points in one
  // shader compiles that source six times. The suite spends most of its wall
  // clock here under wine. Cache on (source, entry, target) — the compiler is
  // a pure function of exactly those three.
  bool compile(const std::string& src, const std::string& entry,
               const char* target, Com<ID3DBlob>& out) {
    if (!compile_) return false;
    const std::string key = entry + '\0' + target + '\0' + src;
    if (auto it = blobCache_.find(key); it != blobCache_.end()) {
      out.p = it->second;
      out.p->AddRef();
      return true;
    }
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
    out.p->AddRef();              // the cache holds a reference of its own
    blobCache_.emplace(key, out.p);
    return true;
  }

  int32_t makeRenderPSO(int32_t vsHandle, const std::string& vsEntry,
                        int32_t fsHandle, const std::string& fsEntry,
                        int32_t blendMode, bool withVertexLayout = false) {
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

    if (withVertexLayout) {
      const D3D11_INPUT_ELEMENT_DESC elems[] = {
        { "TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT,       0, 0,
          D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "TEXCOORD", 1, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 8,
          D3D11_INPUT_PER_VERTEX_DATA, 0 },
      };
      hr = device_->CreateInputLayout(elems, 2, vb->GetBufferPointer(),
                                      vb->GetBufferSize(), r.inputLayout.put());
      if (FAILED(hr)) { hrFail("CreateInputLayout", hr); return -1; }
      r.vertexStride = 24;
    }

    D3D11_BLEND_DESC bd{};
    fillBlendTarget(bd.RenderTarget[0], blendMode);
    hr = device_->CreateBlendState(&bd, r.blend.put());
    if (FAILED(hr)) hrFail("CreateBlendState", hr);
    return store(std::move(r));
  }

  // BlendMode → one D3D11 render-target blend description.
  // 0 = alpha-over, 1 = additive, 2 = replace (gpu_backend.h).
  static void fillBlendTarget(D3D11_RENDER_TARGET_BLEND_DESC& t,
                              int32_t blendMode) {
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

  // Handle 0 is NEVER issued. The effect ABI's Handle::valid() is `id > 0`
  // (wasm_modules/include/gpu.h), so an effect handed 0 treats a perfectly
  // good resource as a failure — brightness_contrast's module_init bailed at
  // "shader compile failed" with a shader that had compiled fine, left its PSO
  // unset, and rendered black with nothing logged. Metal's backend starts at 1
  // for the same reason; slot 0 here is a permanent placeholder.
  int32_t store(Resource&& r) {
    if (resources_.empty()) resources_.emplace_back();  // burn slot 0
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
    if (h <= 0 || (size_t)h >= resources_.size()) return nullptr;
    Resource* r = &resources_[h];
    return r->kind == k ? r : nullptr;
  }

  Com<ID3D11Device> device_;
  Com<ID3D11DeviceContext> ctx_;
  Com<ID3D11ComputeShader> formatCopyCs_;
  // One rasterizer state for every render pass — see bindTargets for why the
  // default is wrong (D3D11 culls back faces; Metal culls nothing).
  Com<ID3D11RasterizerState> raster_;
  // Stride of the vertex buffer the currently-bound render PSO expects; 0 for
  // the procedural pipelines. Set by renderSetPSO, read by
  // renderSetVertexBuffer — see there.
  uint32_t vertexStride_ = 0;
  PFN_D3DCompile_t compile_ = nullptr;
  std::vector<Resource> resources_;
  std::vector<int32_t> free_;
  std::unordered_map<std::string, ID3DBlob*> blobCache_;
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
