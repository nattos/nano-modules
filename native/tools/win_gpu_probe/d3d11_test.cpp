// Headless D3D11: does plain compute + rasterization work under CrossOver?
//
// Deliberately NO window, NO swapchain, NO DirectComposition — those are what
// Chromium's GPU process trips over, and mixing them in would prove nothing
// about D3D itself. Everything renders to an offscreen RTV and is read back.
//
// Every entry point is LoadLibrary'd so the binary needs no import libraries.

#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <stdio.h>
#include <string.h>

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { ++failures; \
  printf("FAIL  " __VA_ARGS__); printf("\n"); } \
  else { printf("ok    " __VA_ARGS__); printf("\n"); } \
  fflush(stdout); } while (0)

typedef HRESULT (WINAPI *PFN_D3D11CreateDevice)(
    IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL*,
    UINT, UINT, ID3D11Device**, D3D_FEATURE_LEVEL*, ID3D11DeviceContext**);
typedef HRESULT (WINAPI *PFN_D3DCompile)(
    LPCVOID, SIZE_T, LPCSTR, const D3D_SHADER_MACRO*, ID3DInclude*, LPCSTR,
    LPCSTR, UINT, UINT, ID3DBlob**, ID3DBlob**);
typedef HRESULT (WINAPI *PFN_CreateDXGIFactory1)(REFIID, void**);

static PFN_D3DCompile gCompile = nullptr;

static ID3DBlob* compile(const char* src, const char* entry, const char* target) {
  ID3DBlob *code = nullptr, *err = nullptr;
  HRESULT hr = gCompile(src, strlen(src), "inline", nullptr, nullptr,
                           entry, target, 0, 0, &code, &err);
  if (FAILED(hr)) {
    printf("      compile %s (%s) failed hr=0x%08lx: %s\n", entry, target,
                (unsigned long)hr,
                err ? (const char*)err->GetBufferPointer() : "(no message)");
    return nullptr;
  }
  if (err) err->Release();
  return code;
}

static const char* kCompute = R"(
RWStructuredBuffer<float> Sums   : register(u0);
RWByteAddressBuffer       Counter: register(u1);
groupshared float lds[64];

[numthreads(64,1,1)]
void CSMain(uint3 tid : SV_DispatchThreadID, uint3 gtid : SV_GroupThreadID,
            uint3 gid : SV_GroupID) {
  float v = (float)tid.x;
  lds[gtid.x] = v * v;                       // groupshared write
  GroupMemoryBarrierWithGroupSync();          // barrier
  [unroll] for (uint s = 32u; s > 0u; s >>= 1u) {   // parallel reduction
    if (gtid.x < s) lds[gtid.x] += lds[gtid.x + s];
    GroupMemoryBarrierWithGroupSync();
  }
  uint prev;
  Counter.InterlockedAdd(0, 1, prev);         // UAV atomic
  if (gtid.x == 0) Sums[gid.x] = lds[0];
}
)";

static const char* kRaster = R"(
struct VSOut { float4 pos : SV_Position; float3 col : COLOR; };
VSOut VSMain(uint vid : SV_VertexID) {
  float2 p[3] = { float2(-0.8,-0.8), float2(0.0, 0.9), float2(0.8,-0.8) };
  float3 c[3] = { float3(1,0,0), float3(0,1,0), float3(0,0,1) };
  VSOut o; o.pos = float4(p[vid], 0, 1); o.col = c[vid]; return o;
}
float4 PSMain(VSOut i) : SV_Target { return float4(i.col, 1); }
)";

int main() {
  printf("=== headless D3D11 compute + raster ===\n");

  HMODULE hD3D11 = LoadLibraryA("d3d11.dll");
  HMODULE hComp  = LoadLibraryA("d3dcompiler_47.dll");
  HMODULE hDxgi  = LoadLibraryA("dxgi.dll");
  CHECK(hD3D11 && hComp && hDxgi, "load d3d11/d3dcompiler_47/dxgi");
  if (!hD3D11 || !hComp) return 1;

  auto pCreate = (PFN_D3D11CreateDevice)GetProcAddress(hD3D11, "D3D11CreateDevice");
  gCompile  = (PFN_D3DCompile)GetProcAddress(hComp, "D3DCompile");
  CHECK(pCreate && gCompile, "resolve D3D11CreateDevice + D3DCompile");
  if (!pCreate || !gCompile) return 1;

  if (hDxgi) {
    auto pFac = (PFN_CreateDXGIFactory1)GetProcAddress(hDxgi, "CreateDXGIFactory1");
    IDXGIFactory1* fac = nullptr;
    if (pFac && SUCCEEDED(pFac(__uuidof(IDXGIFactory1), (void**)&fac)) && fac) {
      IDXGIAdapter1* ad = nullptr;
      for (UINT i = 0; fac->EnumAdapters1(i, &ad) == S_OK; ++i) {
        DXGI_ADAPTER_DESC1 d{}; ad->GetDesc1(&d);
        printf("      adapter %u: %ls (vendor 0x%04x device 0x%04x, vram %llu MB)\n",
                    i, d.Description, (unsigned)d.VendorId, (unsigned)d.DeviceId,
                    (unsigned long long)(d.DedicatedVideoMemory >> 20));
        ad->Release();
      }
      fac->Release();
    }
  }

  const D3D_FEATURE_LEVEL want[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
  ID3D11Device* dev = nullptr; ID3D11DeviceContext* ctx = nullptr;
  D3D_FEATURE_LEVEL got{};
  HRESULT hr = pCreate(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, want, 2,
                       D3D11_SDK_VERSION, &dev, &got, &ctx);
  CHECK(SUCCEEDED(hr) && dev, "D3D11CreateDevice(HARDWARE) hr=0x%08lx", (unsigned long)hr);
  if (!dev) return 1;
  printf("      feature level 0x%04x (%s)\n", (unsigned)got,
              got == D3D_FEATURE_LEVEL_11_1 ? "11_1" :
              got == D3D_FEATURE_LEVEL_11_0 ? "11_0" : "lower");

  // ---------------- compute ----------------
  ID3DBlob* csb = compile(kCompute, "CSMain", "cs_5_0");
  CHECK(csb != nullptr, "compile compute shader (cs_5_0)");
  if (csb) {
    ID3D11ComputeShader* cs = nullptr;
    hr = dev->CreateComputeShader(csb->GetBufferPointer(), csb->GetBufferSize(), nullptr, &cs);
    CHECK(SUCCEEDED(hr) && cs, "CreateComputeShader hr=0x%08lx", (unsigned long)hr);

    ID3D11Buffer* sums = nullptr; ID3D11UnorderedAccessView* sumsUav = nullptr;
    D3D11_BUFFER_DESC bd{}; bd.ByteWidth = 4 * sizeof(float);
    bd.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
    bd.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_STRUCTURED;
    bd.StructureByteStride = sizeof(float);
    hr = dev->CreateBuffer(&bd, nullptr, &sums);
    CHECK(SUCCEEDED(hr), "create structured UAV buffer hr=0x%08lx", (unsigned long)hr);
    D3D11_UNORDERED_ACCESS_VIEW_DESC ud{};
    ud.Format = DXGI_FORMAT_UNKNOWN; ud.ViewDimension = D3D11_UAV_DIMENSION_BUFFER;
    ud.Buffer.NumElements = 4;
    if (sums) dev->CreateUnorderedAccessView(sums, &ud, &sumsUav);

    ID3D11Buffer* cnt = nullptr; ID3D11UnorderedAccessView* cntUav = nullptr;
    D3D11_BUFFER_DESC cd{}; cd.ByteWidth = 16;
    cd.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
    cd.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
    UINT zero[4] = {0,0,0,0};
    D3D11_SUBRESOURCE_DATA sd{}; sd.pSysMem = zero;
    hr = dev->CreateBuffer(&cd, &sd, &cnt);
    CHECK(SUCCEEDED(hr), "create raw UAV buffer (atomics) hr=0x%08lx", (unsigned long)hr);
    D3D11_UNORDERED_ACCESS_VIEW_DESC rd{};
    rd.Format = DXGI_FORMAT_R32_TYPELESS; rd.ViewDimension = D3D11_UAV_DIMENSION_BUFFER;
    rd.Buffer.NumElements = 4; rd.Buffer.Flags = D3D11_BUFFER_UAV_FLAG_RAW;
    if (cnt) dev->CreateUnorderedAccessView(cnt, &rd, &cntUav);

    if (cs && sumsUav && cntUav) {
      ID3D11UnorderedAccessView* uavs[2] = { sumsUav, cntUav };
      ctx->CSSetShader(cs, nullptr, 0);
      ctx->CSSetUnorderedAccessViews(0, 2, uavs, nullptr);
      ctx->Dispatch(4, 1, 1);

      D3D11_BUFFER_DESC stg{}; stg.ByteWidth = 4 * sizeof(float);
      stg.Usage = D3D11_USAGE_STAGING; stg.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      ID3D11Buffer* rb = nullptr; dev->CreateBuffer(&stg, nullptr, &rb);
      D3D11_BUFFER_DESC stg2 = stg; stg2.ByteWidth = 16;
      ID3D11Buffer* rb2 = nullptr; dev->CreateBuffer(&stg2, nullptr, &rb2);
      if (rb && rb2) {
        ctx->CopyResource(rb, sums); ctx->CopyResource(rb2, cnt);
        D3D11_MAPPED_SUBRESOURCE m{};
        if (SUCCEEDED(ctx->Map(rb, 0, D3D11_MAP_READ, 0, &m))) {
          const float* f = (const float*)m.pData;
          bool good = true;
          for (int g = 0; g < 4; ++g) {           // sum of i^2 over the group
            double want_ = 0; for (int i = g*64; i < g*64+64; ++i) want_ += (double)i*i;
            if (f[g] < want_ * 0.999 || f[g] > want_ * 1.001) good = false;
          }
          printf("      sums = %.0f %.0f %.0f %.0f\n", f[0], f[1], f[2], f[3]);
          CHECK(good, "compute: groupshared + barrier + reduction correct");
          ctx->Unmap(rb, 0);
        } else { CHECK(false, "map compute readback"); }
        if (SUCCEEDED(ctx->Map(rb2, 0, D3D11_MAP_READ, 0, &m))) {
          UINT n = *(const UINT*)m.pData;
          printf("      atomic counter = %u (want 256)\n", n);
          CHECK(n == 256, "compute: UAV InterlockedAdd across 4 groups");
          ctx->Unmap(rb2, 0);
        } else { CHECK(false, "map atomic readback"); }
      }
    }
  }

  // ---------------- rasterize a triangle ----------------
  ID3DBlob* vsb = compile(kRaster, "VSMain", "vs_5_0");
  ID3DBlob* psb = compile(kRaster, "PSMain", "ps_5_0");
  CHECK(vsb && psb, "compile vs_5_0 + ps_5_0");
  if (vsb && psb) {
    ID3D11VertexShader* vs = nullptr; ID3D11PixelShader* ps = nullptr;
    dev->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &vs);
    dev->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr, &ps);
    CHECK(vs && ps, "create vertex + pixel shaders");

    const UINT N = 64;
    D3D11_TEXTURE2D_DESC td{}; td.Width = N; td.Height = N; td.MipLevels = 1;
    td.ArraySize = 1; td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    td.SampleDesc.Count = 1; td.BindFlags = D3D11_BIND_RENDER_TARGET;
    ID3D11Texture2D* rt = nullptr;
    hr = dev->CreateTexture2D(&td, nullptr, &rt);
    CHECK(SUCCEEDED(hr) && rt, "create offscreen render target hr=0x%08lx", (unsigned long)hr);

    ID3D11RenderTargetView* rtv = nullptr;
    if (rt) dev->CreateRenderTargetView(rt, nullptr, &rtv);
    if (vs && ps && rtv) {
      const float clear[4] = { 0, 0, 0, 1 };
      ctx->ClearRenderTargetView(rtv, clear);
      ctx->OMSetRenderTargets(1, &rtv, nullptr);
      D3D11_VIEWPORT vp{}; vp.Width = (float)N; vp.Height = (float)N; vp.MaxDepth = 1;
      ctx->RSSetViewports(1, &vp);
      ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
      ctx->IASetInputLayout(nullptr);
      ctx->VSSetShader(vs, nullptr, 0);
      ctx->PSSetShader(ps, nullptr, 0);
      ctx->Draw(3, 0);

      td.BindFlags = 0; td.Usage = D3D11_USAGE_STAGING;
      td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      ID3D11Texture2D* rb = nullptr; dev->CreateTexture2D(&td, nullptr, &rb);
      if (rb) {
        ctx->CopyResource(rb, rt);
        D3D11_MAPPED_SUBRESOURCE m{};
        if (SUCCEEDED(ctx->Map(rb, 0, D3D11_MAP_READ, 0, &m))) {
          auto px = [&](UINT x, UINT y) {
            return (const unsigned char*)m.pData + y * m.RowPitch + x * 4;
          };
          const unsigned char* c = px(N/2, N/2);
          const unsigned char* corner = px(1, 1);
          printf("      centre  = %u %u %u %u\n", c[0], c[1], c[2], c[3]);
          printf("      corner  = %u %u %u %u\n", corner[0], corner[1], corner[2], corner[3]);
          CHECK(c[0] + c[1] + c[2] > 60, "raster: triangle covers the centre");
          CHECK(c[1] > c[0] && c[1] > c[2], "raster: interpolated varyings (green-dominant centre)");
          CHECK(corner[0] + corner[1] + corner[2] == 0, "raster: corner left at clear colour");
          ctx->Unmap(rb, 0);
        } else { CHECK(false, "map render-target readback"); }
      }
    }
  }

  printf("=== %s (%d failure%s) ===\n", failures ? "FAILED" : "PASSED",
              failures, failures == 1 ? "" : "s");
  fflush(stdout);
  return failures ? 1 : 0;
}
