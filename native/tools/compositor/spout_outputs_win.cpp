// spout_outputs_win.cpp — see spout_outputs.h.

#include "compositor/spout_outputs.h"

#include <windows.h>
#include <d3d11.h>

#include <cstdio>
#include <cstring>
#include <map>
#include <mutex>

#include "SpoutFrameCount.h"
#include "SpoutSenderNames.h"
#include "gpu/d3d11_adapter_win.h"

namespace compositor {
namespace {

using PFN_D3D11CreateDevice_t = HRESULT(WINAPI*)(
    IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL*, UINT, UINT,
    ID3D11Device**, D3D_FEATURE_LEVEL*, ID3D11DeviceContext**);

/// Spout names are ANSI (receivers show them in the system code page).
std::string toAnsi(const std::string& utf8) {
  const int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
  if (n <= 0) return utf8;
  std::wstring w((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, w.data(), n);
  const int m = WideCharToMultiByte(CP_ACP, 0, w.c_str(), -1, nullptr, 0, "?", nullptr);
  if (m <= 0) return utf8;
  std::string out((size_t)m, '\0');
  WideCharToMultiByte(CP_ACP, 0, w.c_str(), -1, out.data(), m, "?", nullptr);
  out.resize(std::strlen(out.c_str()));
  return out;
}

}  // namespace

struct SpoutOutputs::Impl {
  struct Sender {
    std::string wanted;      // the name asked for
    std::string registered;  // what Spout registered (may carry a suffix)
    ID3D11Texture2D* texture = nullptr;
    HANDLE share = nullptr;
    int width = 0, height = 0;
    std::unique_ptr<spoutFrameCount> frame;
  };

  ID3D11Device* device = nullptr;
  ID3D11DeviceContext* ctx = nullptr;
  bool deviceTried = false;
  spoutSenderNames names;
  mutable std::mutex mu;  // senders: publish comes from the GPU's completion thread
  std::map<std::string, Sender> senders;

  bool ensureDevice() {
    if (device) return true;
    if (deviceTried) return false;
    deviceTried = true;
    HMODULE d3d11 = LoadLibraryA("d3d11.dll");
    auto create = d3d11 ? (PFN_D3D11CreateDevice_t)GetProcAddress(d3d11, "D3D11CreateDevice")
                        : nullptr;
    if (!create) return false;
    IDXGIAdapter* adapter = gpu::chosenAdapter(/*quiet=*/true);
    const HRESULT hr = create(adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
                              nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &ctx);
    if (adapter) adapter->Release();
    if (FAILED(hr)) {
      std::fprintf(stderr, "[spout] no D3D11 device (hr=0x%08lx): no Spout outputs\n",
                   (unsigned long)hr);
      device = nullptr;
      return false;
    }
    return true;
  }

  /// A BGRA8 texture shared by a legacy handle, as SpoutDX makes a sender's.
  bool makeTexture(int w, int h, ID3D11Texture2D** tex, HANDLE* share) {
    D3D11_TEXTURE2D_DESC d{};
    d.Width = (UINT)w;
    d.Height = (UINT)h;
    d.MipLevels = 1;
    d.ArraySize = 1;
    d.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    d.SampleDesc.Count = 1;
    d.Usage = D3D11_USAGE_DEFAULT;
    d.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    d.MiscFlags = D3D11_RESOURCE_MISC_SHARED;
    if (FAILED(device->CreateTexture2D(&d, nullptr, tex))) return false;
    IDXGIResource* res = nullptr;
    HRESULT hr = (*tex)->QueryInterface(__uuidof(IDXGIResource), (void**)&res);
    if (SUCCEEDED(hr)) hr = res->GetSharedHandle(share);
    if (res) res->Release();
    if (FAILED(hr) || !*share) {
      (*tex)->Release();
      *tex = nullptr;
      return false;
    }
    ctx->Flush();  // the texture exists for other devices once this device has flushed
    return true;
  }

  void stop(Sender& s) {
    if (!s.registered.empty()) names.ReleaseSenderName(s.registered.c_str());
    if (s.frame) {
      s.frame->CleanupFrameCount();
      s.frame->CloseAccessMutex();
    }
    // The engine holds its own reference to the texture while it still
    // presents into it; this one can go now.
    if (s.texture) s.texture->Release();
    s.texture = nullptr;
  }
};

SpoutOutputs::SpoutOutputs() : impl_(std::make_unique<Impl>()) {}

SpoutOutputs::~SpoutOutputs() {
  std::lock_guard<std::mutex> lk(impl_->mu);
  for (auto& [key, s] : impl_->senders) impl_->stop(s);
  impl_->senders.clear();
  if (impl_->ctx) impl_->ctx->Release();
  if (impl_->device) impl_->device->Release();
}

void* SpoutOutputs::ensure(const std::string& key, const std::string& name, int width,
                           int height) {
  if (width <= 0 || height <= 0 || !impl_->ensureDevice()) return nullptr;
  const std::string wanted = toAnsi("Nano Modules - " + name);
  std::lock_guard<std::mutex> lk(impl_->mu);
  auto it = impl_->senders.find(key);
  if (it != impl_->senders.end() && it->second.wanted != wanted) {
    impl_->stop(it->second);  // Spout can't rename a sender: a new one
    impl_->senders.erase(it);
    it = impl_->senders.end();
  }
  if (it != impl_->senders.end()) {
    Impl::Sender& s = it->second;
    if (s.width == width && s.height == height) return s.share;
    // A new size: a new texture under the same sender (as SpoutDX does).
    ID3D11Texture2D* tex = nullptr;
    HANDLE share = nullptr;
    if (!impl_->makeTexture(width, height, &tex, &share)) return nullptr;
    impl_->names.UpdateSender(s.registered.c_str(), (unsigned)width, (unsigned)height, share,
                              DXGI_FORMAT_B8G8R8A8_UNORM);
    if (s.texture) s.texture->Release();
    s.texture = tex;
    s.share = share;
    s.width = width;
    s.height = height;
    return share;
  }
  Impl::Sender s;
  s.wanted = wanted;
  if (!impl_->makeTexture(width, height, &s.texture, &s.share)) return nullptr;
  char nm[256] = {0};
  strncpy_s(nm, sizeof(nm), wanted.c_str(), _TRUNCATE);
  if (!impl_->names.CreateSender(nm, (unsigned)width, (unsigned)height, s.share,
                                 DXGI_FORMAT_B8G8R8A8_UNORM)) {
    s.texture->Release();
    return nullptr;
  }
  s.registered = nm;  // CreateSender suffixes a name that's taken
  s.frame = std::make_unique<spoutFrameCount>();
  s.frame->CreateAccessMutex(nm);
  s.frame->EnableFrameCount(nm);  // a no-op unless SpoutSettings turned frame counting on
  s.width = width;
  s.height = height;
  void* share = s.share;
  impl_->senders[key] = std::move(s);
  return share;
}

void SpoutOutputs::publish(const std::string& key) {
  std::lock_guard<std::mutex> lk(impl_->mu);
  auto it = impl_->senders.find(key);
  if (it != impl_->senders.end() && it->second.frame) it->second.frame->SetNewFrame();
}

void SpoutOutputs::close(const std::string& key) {
  std::lock_guard<std::mutex> lk(impl_->mu);
  auto it = impl_->senders.find(key);
  if (it == impl_->senders.end()) return;
  impl_->stop(it->second);
  impl_->senders.erase(it);
}

bool SpoutOutputs::has(const std::string& key) const {
  std::lock_guard<std::mutex> lk(impl_->mu);
  return impl_->senders.count(key) > 0;
}

std::string SpoutOutputs::senderName(const std::string& key) const {
  std::lock_guard<std::mutex> lk(impl_->mu);
  auto it = impl_->senders.find(key);
  return it == impl_->senders.end() ? std::string() : it->second.registered;
}

}  // namespace compositor
