// Headless D3D12: compute + rasterization, no window, no swapchain, no DComp.
//
// D3D12 is what Chromium's WebGPU (Dawn) uses on Windows, so this is the test
// that separates "CrossOver has no D3D12" from "Chromium asks D3D12 for things
// CrossOver can't do" (shared NT handles, DirectComposition, presentation).
//
// Shaders are compiled to SHADER MODEL 5.1 DXBC via d3dcompiler_47, which the
// D3D12 runtime accepts natively. That sidesteps DXIL entirely — DXIL has to be
// signed by dxil.dll, and an unsigned blob would fail for reasons that have
// nothing to do with the question being asked.

#include <windows.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include <d3dcompiler.h>
#include <stdio.h>
#include <string.h>

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { ++failures; \
  printf("FAIL  " __VA_ARGS__); printf("\n"); } \
  else { printf("ok    " __VA_ARGS__); printf("\n"); } fflush(stdout); } while (0)

typedef HRESULT (WINAPI *PFN_D3D12CreateDevice_)(IUnknown*, D3D_FEATURE_LEVEL, REFIID, void**);
typedef HRESULT (WINAPI *PFN_D3D12SerializeRootSignature_)(
    const D3D12_ROOT_SIGNATURE_DESC*, D3D_ROOT_SIGNATURE_VERSION, ID3DBlob**, ID3DBlob**);
typedef HRESULT (WINAPI *PFN_CreateDXGIFactory1_)(REFIID, void**);
typedef HRESULT (WINAPI *PFN_D3DCompile_)(LPCVOID, SIZE_T, LPCSTR, const D3D_SHADER_MACRO*,
    ID3DInclude*, LPCSTR, LPCSTR, UINT, UINT, ID3DBlob**, ID3DBlob**);

static PFN_D3DCompile_ gCompile = nullptr;

static ID3DBlob* compile(const char* src, const char* entry, const char* target) {
  ID3DBlob *code = nullptr, *err = nullptr;
  HRESULT hr = gCompile(src, strlen(src), "inline", nullptr, nullptr, entry, target,
                        0, 0, &code, &err);
  if (FAILED(hr)) {
    printf("      compile %s (%s) hr=0x%08lx: %s\n", entry, target, (unsigned long)hr,
           err ? (const char*)err->GetBufferPointer() : "(no message)");
    return nullptr;
  }
  if (err) err->Release();
  return code;
}

static const char* kCompute = R"(
RWStructuredBuffer<float> Sums    : register(u0);
RWByteAddressBuffer       Counter : register(u1);
groupshared float lds[64];
[numthreads(64,1,1)]
void CSMain(uint3 tid : SV_DispatchThreadID, uint3 gtid : SV_GroupThreadID,
            uint3 gid : SV_GroupID) {
  float v = (float)tid.x;
  lds[gtid.x] = v * v;
  GroupMemoryBarrierWithGroupSync();
  [unroll] for (uint s = 32u; s > 0u; s >>= 1u) {
    if (gtid.x < s) lds[gtid.x] += lds[gtid.x + s];
    GroupMemoryBarrierWithGroupSync();
  }
  uint prev; Counter.InterlockedAdd(0, 1, prev);
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

static D3D12_HEAP_PROPERTIES heap(D3D12_HEAP_TYPE t) {
  D3D12_HEAP_PROPERTIES h{}; h.Type = t;
  h.CPUPageProperty = D3D12_CPU_PAGE_PROPERTY_UNKNOWN;
  h.MemoryPoolPreference = D3D12_MEMORY_POOL_UNKNOWN;
  h.CreationNodeMask = 1; h.VisibleNodeMask = 1; return h;
}
static D3D12_RESOURCE_DESC bufDesc(UINT64 bytes, D3D12_RESOURCE_FLAGS f) {
  D3D12_RESOURCE_DESC d{}; d.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
  d.Width = bytes; d.Height = 1; d.DepthOrArraySize = 1; d.MipLevels = 1;
  d.Format = DXGI_FORMAT_UNKNOWN; d.SampleDesc.Count = 1;
  d.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR; d.Flags = f; return d;
}
static void barrier(ID3D12GraphicsCommandList* cl, ID3D12Resource* r,
                    D3D12_RESOURCE_STATES from, D3D12_RESOURCE_STATES to) {
  D3D12_RESOURCE_BARRIER b{}; b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
  b.Transition.pResource = r; b.Transition.StateBefore = from;
  b.Transition.StateAfter = to;
  b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
  cl->ResourceBarrier(1, &b);
}

int main() {
  printf("=== headless D3D12 compute + raster ===\n");
  HMODULE h12 = LoadLibraryA("d3d12.dll");
  HMODULE hC  = LoadLibraryA("d3dcompiler_47.dll");
  HMODULE hX  = LoadLibraryA("dxgi.dll");
  CHECK(h12 && hC && hX, "load d3d12 / d3dcompiler_47 / dxgi");
  if (!h12 || !hC || !hX) return 1;

  auto pDev  = (PFN_D3D12CreateDevice_)GetProcAddress(h12, "D3D12CreateDevice");
  auto pSign = (PFN_D3D12SerializeRootSignature_)GetProcAddress(h12, "D3D12SerializeRootSignature");
  auto pFac  = (PFN_CreateDXGIFactory1_)GetProcAddress(hX, "CreateDXGIFactory1");
  gCompile   = (PFN_D3DCompile_)GetProcAddress(hC, "D3DCompile");
  CHECK(pDev && pSign && pFac && gCompile, "resolve D3D12 entry points");
  if (!pDev || !pSign || !pFac || !gCompile) return 1;

  IDXGIFactory1* fac = nullptr;
  CHECK(SUCCEEDED(pFac(__uuidof(IDXGIFactory1), (void**)&fac)) && fac, "CreateDXGIFactory1");
  if (!fac) return 1;

  ID3D12Device* dev = nullptr;
  IDXGIAdapter1* ad = nullptr;
  for (UINT i = 0; fac->EnumAdapters1(i, &ad) == S_OK; ++i) {
    DXGI_ADAPTER_DESC1 d{}; ad->GetDesc1(&d);
    bool sw = (d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0;
    HRESULT hr = pDev(ad, D3D_FEATURE_LEVEL_11_0, __uuidof(ID3D12Device), (void**)&dev);
    printf("      adapter %u: %ls%s -> D3D12CreateDevice hr=0x%08lx\n", i, d.Description,
           sw ? " [software]" : "", (unsigned long)hr);
    ad->Release();
    if (SUCCEEDED(hr) && dev) break;
  }
  CHECK(dev != nullptr, "D3D12CreateDevice on some adapter");
  if (!dev) { printf("=== FAILED (%d) ===\n", failures); return 1; }

  D3D12_FEATURE_DATA_D3D12_OPTIONS o{};
  if (SUCCEEDED(dev->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS, &o, sizeof(o))))
    printf("      resource binding tier %d, tiled tier %d, conservative raster tier %d\n",
           (int)o.ResourceBindingTier, (int)o.TiledResourcesTier,
           (int)o.ConservativeRasterizationTier);

  // Dawn/WebGPU needs shader model 6 (DXIL). Chromium reports supportsDx12:false
  // here even though the device above is fine, so ask what this D3D12 actually is.
  {
    static const D3D_SHADER_MODEL kSM[] = {
      (D3D_SHADER_MODEL)0x69, (D3D_SHADER_MODEL)0x68, (D3D_SHADER_MODEL)0x67,
      (D3D_SHADER_MODEL)0x66, (D3D_SHADER_MODEL)0x65, (D3D_SHADER_MODEL)0x64,
      (D3D_SHADER_MODEL)0x63, (D3D_SHADER_MODEL)0x62, (D3D_SHADER_MODEL)0x61,
      (D3D_SHADER_MODEL)0x60, (D3D_SHADER_MODEL)0x51 };
    bool got = false;
    for (D3D_SHADER_MODEL m : kSM) {
      D3D12_FEATURE_DATA_SHADER_MODEL sm{}; sm.HighestShaderModel = m;
      if (SUCCEEDED(dev->CheckFeatureSupport(D3D12_FEATURE_SHADER_MODEL, &sm, sizeof(sm)))) {
        printf("      highest shader model = %d.%d\n",
               ((int)sm.HighestShaderModel >> 4) & 0xf, (int)sm.HighestShaderModel & 0xf);
        CHECK(((int)sm.HighestShaderModel) >= 0x60,
              "shader model 6.0+ available (what DXIL / Dawn requires)");
        got = true; break;
      }
    }
    if (!got) CHECK(false, "query D3D12_FEATURE_SHADER_MODEL at all");
    D3D12_FEATURE_DATA_D3D12_OPTIONS1 o1{};
    if (SUCCEEDED(dev->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS1, &o1, sizeof(o1))))
      printf("      wave ops = %s (lane count %u..%u)\n", o1.WaveOps ? "yes" : "NO",
             (unsigned)o1.WaveLaneCountMin, (unsigned)o1.WaveLaneCountMax);
  }

  ID3D12CommandQueue* q = nullptr;
  D3D12_COMMAND_QUEUE_DESC qd{}; qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
  CHECK(SUCCEEDED(dev->CreateCommandQueue(&qd, __uuidof(ID3D12CommandQueue), (void**)&q)),
        "CreateCommandQueue(DIRECT)");
  ID3D12CommandAllocator* alloc = nullptr;
  dev->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                              __uuidof(ID3D12CommandAllocator), (void**)&alloc);
  ID3D12GraphicsCommandList* cl = nullptr;
  CHECK(SUCCEEDED(dev->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, alloc, nullptr,
        __uuidof(ID3D12GraphicsCommandList), (void**)&cl)) && cl, "CreateCommandList");
  if (!q || !cl) { printf("=== FAILED (%d) ===\n", failures); return 1; }

  // ---- compute root signature: two root UAVs ----
  D3D12_ROOT_PARAMETER rp[2]{};
  rp[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_UAV;
  rp[0].Descriptor.ShaderRegister = 0;
  rp[0].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
  rp[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_UAV;
  rp[1].Descriptor.ShaderRegister = 1;
  rp[1].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
  D3D12_ROOT_SIGNATURE_DESC rsd{}; rsd.NumParameters = 2; rsd.pParameters = rp;
  ID3DBlob *rsb = nullptr, *rse = nullptr;
  HRESULT hr = pSign(&rsd, D3D_ROOT_SIGNATURE_VERSION_1, &rsb, &rse);
  CHECK(SUCCEEDED(hr) && rsb, "D3D12SerializeRootSignature (compute) hr=0x%08lx",
        (unsigned long)hr);
  ID3D12RootSignature* crs = nullptr;
  if (rsb) dev->CreateRootSignature(0, rsb->GetBufferPointer(), rsb->GetBufferSize(),
                                    __uuidof(ID3D12RootSignature), (void**)&crs);
  CHECK(crs != nullptr, "CreateRootSignature (compute)");

  ID3DBlob* csb = compile(kCompute, "CSMain", "cs_5_1");
  CHECK(csb != nullptr, "compile compute shader (cs_5_1 DXBC)");
  ID3D12PipelineState* cpso = nullptr;
  if (crs && csb) {
    D3D12_COMPUTE_PIPELINE_STATE_DESC pd{};
    pd.pRootSignature = crs;
    pd.CS.pShaderBytecode = csb->GetBufferPointer(); pd.CS.BytecodeLength = csb->GetBufferSize();
    hr = dev->CreateComputePipelineState(&pd, __uuidof(ID3D12PipelineState), (void**)&cpso);
    CHECK(SUCCEEDED(hr) && cpso, "CreateComputePipelineState hr=0x%08lx", (unsigned long)hr);
  }

  ID3D12Resource *sums = nullptr, *cnt = nullptr, *rbBuf = nullptr;
  auto hd = heap(D3D12_HEAP_TYPE_DEFAULT);
  auto sd = bufDesc(256, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS);
  dev->CreateCommittedResource(&hd, D3D12_HEAP_FLAG_NONE, &sd,
      D3D12_RESOURCE_STATE_UNORDERED_ACCESS, nullptr, __uuidof(ID3D12Resource), (void**)&sums);
  dev->CreateCommittedResource(&hd, D3D12_HEAP_FLAG_NONE, &sd,
      D3D12_RESOURCE_STATE_UNORDERED_ACCESS, nullptr, __uuidof(ID3D12Resource), (void**)&cnt);
  auto hr_ = heap(D3D12_HEAP_TYPE_READBACK);
  auto rd_ = bufDesc(512 + 64 * 256, D3D12_RESOURCE_FLAG_NONE);
  dev->CreateCommittedResource(&hr_, D3D12_HEAP_FLAG_NONE, &rd_,
      D3D12_RESOURCE_STATE_COPY_DEST, nullptr, __uuidof(ID3D12Resource), (void**)&rbBuf);
  CHECK(sums && cnt && rbBuf, "create UAV + readback resources");

  // ---- graphics pipeline ----
  D3D12_ROOT_SIGNATURE_DESC grsd{};
  grsd.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
  ID3DBlob* grsb = nullptr;
  pSign(&grsd, D3D_ROOT_SIGNATURE_VERSION_1, &grsb, nullptr);
  ID3D12RootSignature* grs = nullptr;
  if (grsb) dev->CreateRootSignature(0, grsb->GetBufferPointer(), grsb->GetBufferSize(),
                                     __uuidof(ID3D12RootSignature), (void**)&grs);
  ID3DBlob* vsb = compile(kRaster, "VSMain", "vs_5_1");
  ID3DBlob* psb = compile(kRaster, "PSMain", "ps_5_1");
  CHECK(vsb && psb && grs, "compile vs_5_1 + ps_5_1 and create graphics root signature");

  ID3D12PipelineState* gpso = nullptr;
  if (vsb && psb && grs) {
    D3D12_GRAPHICS_PIPELINE_STATE_DESC g{};
    g.pRootSignature = grs;
    g.VS.pShaderBytecode = vsb->GetBufferPointer(); g.VS.BytecodeLength = vsb->GetBufferSize();
    g.PS.pShaderBytecode = psb->GetBufferPointer(); g.PS.BytecodeLength = psb->GetBufferSize();
    g.BlendState.RenderTarget[0].SrcBlend = D3D12_BLEND_ONE;
    g.BlendState.RenderTarget[0].DestBlend = D3D12_BLEND_ZERO;
    g.BlendState.RenderTarget[0].BlendOp = D3D12_BLEND_OP_ADD;
    g.BlendState.RenderTarget[0].SrcBlendAlpha = D3D12_BLEND_ONE;
    g.BlendState.RenderTarget[0].DestBlendAlpha = D3D12_BLEND_ZERO;
    g.BlendState.RenderTarget[0].BlendOpAlpha = D3D12_BLEND_OP_ADD;
    g.BlendState.RenderTarget[0].LogicOp = D3D12_LOGIC_OP_NOOP;
    g.BlendState.RenderTarget[0].RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    g.SampleMask = UINT_MAX;
    g.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    g.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
    g.RasterizerState.DepthClipEnable = TRUE;
    g.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    g.NumRenderTargets = 1;
    g.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
    g.SampleDesc.Count = 1;
    hr = dev->CreateGraphicsPipelineState(&g, __uuidof(ID3D12PipelineState), (void**)&gpso);
    CHECK(SUCCEEDED(hr) && gpso, "CreateGraphicsPipelineState hr=0x%08lx", (unsigned long)hr);
  }

  const UINT N = 64;
  D3D12_RESOURCE_DESC td{}; td.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
  td.Width = N; td.Height = N; td.DepthOrArraySize = 1; td.MipLevels = 1;
  td.Format = DXGI_FORMAT_R8G8B8A8_UNORM; td.SampleDesc.Count = 1;
  td.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
  td.Flags = D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET;
  D3D12_CLEAR_VALUE cv{}; cv.Format = DXGI_FORMAT_R8G8B8A8_UNORM; cv.Color[3] = 1.0f;
  ID3D12Resource* rt = nullptr;
  hr = dev->CreateCommittedResource(&hd, D3D12_HEAP_FLAG_NONE, &td,
      D3D12_RESOURCE_STATE_RENDER_TARGET, &cv, __uuidof(ID3D12Resource), (void**)&rt);
  CHECK(SUCCEEDED(hr) && rt, "create offscreen render target hr=0x%08lx", (unsigned long)hr);

  ID3D12DescriptorHeap* rtvHeap = nullptr;
  D3D12_DESCRIPTOR_HEAP_DESC hd2{}; hd2.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV; hd2.NumDescriptors = 1;
  dev->CreateDescriptorHeap(&hd2, __uuidof(ID3D12DescriptorHeap), (void**)&rtvHeap);
  CHECK(rtvHeap != nullptr, "CreateDescriptorHeap(RTV)");
  if (!rtvHeap || !rt || !gpso || !cpso) { printf("=== FAILED (%d) ===\n", failures); return 1; }
  D3D12_CPU_DESCRIPTOR_HANDLE rtv = rtvHeap->GetCPUDescriptorHandleForHeapStart();
  dev->CreateRenderTargetView(rt, nullptr, rtv);

  // ---- record ----
  cl->SetPipelineState(cpso);
  cl->SetComputeRootSignature(crs);
  cl->SetComputeRootUnorderedAccessView(0, sums->GetGPUVirtualAddress());
  cl->SetComputeRootUnorderedAccessView(1, cnt->GetGPUVirtualAddress());
  cl->Dispatch(4, 1, 1);
  barrier(cl, sums, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_STATE_COPY_SOURCE);
  barrier(cl, cnt,  D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_STATE_COPY_SOURCE);
  cl->CopyBufferRegion(rbBuf, 0,   sums, 0, 16);
  cl->CopyBufferRegion(rbBuf, 256, cnt,  0, 4);

  const float clear[4] = { 0, 0, 0, 1 };
  cl->OMSetRenderTargets(1, &rtv, FALSE, nullptr);
  cl->ClearRenderTargetView(rtv, clear, 0, nullptr);
  D3D12_VIEWPORT vp{}; vp.Width = (float)N; vp.Height = (float)N; vp.MaxDepth = 1;
  D3D12_RECT sc{ 0, 0, (LONG)N, (LONG)N };
  cl->RSSetViewports(1, &vp); cl->RSSetScissorRects(1, &sc);
  cl->SetPipelineState(gpso);
  cl->SetGraphicsRootSignature(grs);
  cl->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  cl->DrawInstanced(3, 1, 0, 0);
  barrier(cl, rt, D3D12_RESOURCE_STATE_RENDER_TARGET, D3D12_RESOURCE_STATE_COPY_SOURCE);

  D3D12_PLACED_SUBRESOURCE_FOOTPRINT fp{};
  UINT64 total = 0; dev->GetCopyableFootprints(&td, 0, 1, 512, &fp, nullptr, nullptr, &total);
  D3D12_TEXTURE_COPY_LOCATION dst{}, src{};
  dst.pResource = rbBuf; dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT; dst.PlacedFootprint = fp;
  src.pResource = rt; src.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX; src.SubresourceIndex = 0;
  cl->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
  CHECK(SUCCEEDED(cl->Close()), "close command list");

  ID3D12CommandList* lists[] = { cl };
  q->ExecuteCommandLists(1, lists);
  ID3D12Fence* fence = nullptr;
  dev->CreateFence(0, D3D12_FENCE_FLAG_NONE, __uuidof(ID3D12Fence), (void**)&fence);
  HANDLE ev = CreateEventA(nullptr, FALSE, FALSE, nullptr);
  q->Signal(fence, 1);
  if (fence->GetCompletedValue() < 1) { fence->SetEventOnCompletion(1, ev); WaitForSingleObject(ev, 20000); }
  CHECK(fence->GetCompletedValue() >= 1, "GPU fence signalled (work actually executed)");

  void* mapped = nullptr;
  D3D12_RANGE everything{ 0, (SIZE_T)(512 + 64 * 256) };
  CHECK(SUCCEEDED(rbBuf->Map(0, &everything, &mapped)) && mapped, "map readback heap");
  if (mapped) {
    const float* f = (const float*)mapped;
    bool good = true;
    for (int g = 0; g < 4; ++g) {
      double want_ = 0; for (int i = g*64; i < g*64+64; ++i) want_ += (double)i*i;
      if (f[g] < want_ * 0.999 || f[g] > want_ * 1.001) good = false;
    }
    printf("      sums = %.0f %.0f %.0f %.0f\n", f[0], f[1], f[2], f[3]);
    CHECK(good, "compute: groupshared + barrier + reduction correct");
    UINT n = *(const UINT*)((const char*)mapped + 256);
    printf("      atomic counter = %u (want 256)\n", n);
    CHECK(n == 256, "compute: UAV InterlockedAdd across 4 groups");

    const unsigned char* base = (const unsigned char*)mapped + fp.Offset;
    auto px = [&](UINT x, UINT y) { return base + y * fp.Footprint.RowPitch + x * 4; };
    const unsigned char* c = px(N/2, N/2);
    const unsigned char* corner = px(1, 1);
    printf("      centre  = %u %u %u %u\n", c[0], c[1], c[2], c[3]);
    printf("      corner  = %u %u %u %u\n", corner[0], corner[1], corner[2], corner[3]);
    CHECK(c[0] + c[1] + c[2] > 60, "raster: triangle covers the centre");
    CHECK(c[1] > c[0] && c[1] > c[2], "raster: interpolated varyings");
    CHECK(corner[0] + corner[1] + corner[2] == 0, "raster: corner left at clear colour");
  }

  printf("=== %s (%d failure%s) ===\n", failures ? "FAILED" : "PASSED",
         failures, failures == 1 ? "" : "s");
  fflush(stdout);
  return failures ? 1 : 0;
}
