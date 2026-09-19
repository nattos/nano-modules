// The things Chromium needs ON TOP of plain D3D. Plain D3D11/D3D12 compute and
// raster already pass under CrossOver, so whatever stops the GPU process must
// be in here.
#include <windows.h>
#include <d3d11_4.h>
#include <dxgi1_4.h>
#include <stdio.h>

static int failures = 0;
#define CHECK(c, ...) do { if (!(c)) { ++failures; printf("FAIL  " __VA_ARGS__); } \
  else printf("ok    " __VA_ARGS__); printf("\n"); fflush(stdout); } while (0)

typedef HRESULT (WINAPI *PFN_Create)(IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT,
    const D3D_FEATURE_LEVEL*, UINT, UINT, ID3D11Device**, D3D_FEATURE_LEVEL*,
    ID3D11DeviceContext**);
typedef HRESULT (WINAPI *PFN_DComp)(IDXGIDevice*, REFIID, void**);

int main() {
  printf("=== what Chromium needs beyond plain D3D ===\n");
  HMODULE h = LoadLibraryA("d3d11.dll");
  auto pCreate = (PFN_Create)GetProcAddress(h, "D3D11CreateDevice");

  // 1. Chromium always asks for BGRA support; without it ANGLE/Skia bail out.
  ID3D11Device* dev = nullptr; D3D_FEATURE_LEVEL fl{};
  const D3D_FEATURE_LEVEL want[] = { D3D_FEATURE_LEVEL_11_1 };
  HRESULT hr = pCreate(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                       D3D11_CREATE_DEVICE_BGRA_SUPPORT, want, 1,
                       D3D11_SDK_VERSION, &dev, &fl, nullptr);
  CHECK(SUCCEEDED(hr) && dev, "D3D11CreateDevice with BGRA_SUPPORT hr=0x%08lx", (unsigned long)hr);
  if (!dev) return 1;

  // 2. Newer device interfaces Chromium QIs for.
  ID3D11Device5* dev5 = nullptr;
  hr = dev->QueryInterface(__uuidof(ID3D11Device5), (void**)&dev5);
  CHECK(SUCCEEDED(hr) && dev5, "QueryInterface ID3D11Device5 hr=0x%08lx", (unsigned long)hr);

  ID3D11Multithread* mt = nullptr;
  hr = dev->QueryInterface(__uuidof(ID3D11Multithread), (void**)&mt);
  CHECK(SUCCEEDED(hr) && mt, "QueryInterface ID3D11Multithread hr=0x%08lx", (unsigned long)hr);

  // 3. Shared NT handles — the backbone of Chromium's SharedImage interop, and
  //    how a WebGPU texture reaches the compositor.
  D3D11_TEXTURE2D_DESC td{}; td.Width = td.Height = 64; td.MipLevels = 1;
  td.ArraySize = 1; td.Format = DXGI_FORMAT_B8G8R8A8_UNORM; td.SampleDesc.Count = 1;
  td.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  td.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
  ID3D11Texture2D* tex = nullptr;
  hr = dev->CreateTexture2D(&td, nullptr, &tex);
  CHECK(SUCCEEDED(hr) && tex, "CreateTexture2D SHARED_NTHANDLE|KEYEDMUTEX hr=0x%08lx",
        (unsigned long)hr);

  if (tex) {
    IDXGIResource1* res = nullptr;
    hr = tex->QueryInterface(__uuidof(IDXGIResource1), (void**)&res);
    CHECK(SUCCEEDED(hr) && res, "QueryInterface IDXGIResource1 hr=0x%08lx", (unsigned long)hr);
    if (res) {
      HANDLE shared = nullptr;
      hr = res->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
                                   nullptr, &shared);
      CHECK(SUCCEEDED(hr) && shared, "IDXGIResource1::CreateSharedHandle hr=0x%08lx",
            (unsigned long)hr);
      if (shared && dev5) {
        ID3D11Texture2D* opened = nullptr;
        hr = dev5->OpenSharedResource1(shared, __uuidof(ID3D11Texture2D), (void**)&opened);
        CHECK(SUCCEEDED(hr) && opened, "OpenSharedResource1 (reimport) hr=0x%08lx",
              (unsigned long)hr);
      }
    }
  }

  // 4. DirectComposition — how Chromium presents on Windows.
  HMODULE hd = LoadLibraryA("dcomp.dll");
  CHECK(hd != nullptr, "load dcomp.dll");
  if (hd) {
    auto pD = (PFN_DComp)GetProcAddress(hd, "DCompositionCreateDevice");
    void* dcomp = nullptr;
    IDXGIDevice* dxgiDev = nullptr;
    dev->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDev);
    if (pD) {
      hr = pD(dxgiDev, __uuidof(IUnknown), &dcomp);
      CHECK(SUCCEEDED(hr) && dcomp, "DCompositionCreateDevice hr=0x%08lx", (unsigned long)hr);
    } else CHECK(false, "resolve DCompositionCreateDevice");
    CHECK(GetProcAddress(hd, "DCompositionCreateDevice3") != nullptr,
          "dcomp.dll exports DCompositionCreateDevice3");
  }

  printf("=== %d failure%s ===\n", failures, failures == 1 ? "" : "s");
  return 0;
}
