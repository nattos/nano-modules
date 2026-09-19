// barrel_probe_tex_d3d11.cpp — the D3D11 half of barrel_probe_tex.h.

#include "barrel_probe_tex.h"

#include <d3d11.h>

#include "plugin/nano_barrel/interop_texture_desc_d3d11.h"

namespace barrel_probe {
namespace {

ID3D11DeviceContext* immediateContext(ID3D11Device* dev) {
  ID3D11DeviceContext* ctx = nullptr;
  dev->GetImmediateContext(&ctx);   // AddRef'd; the same object the backend holds
  return ctx;
}

}  // namespace

void* createTexture(void* device, int w, int h) {
  auto* dev = static_cast<ID3D11Device*>(device);
  if (!dev || w <= 0 || h <= 0) return nullptr;

  // The interop's OWN descriptor, not a copy of it — see the header. If the
  // plugin's texture ever stops being something the engine can adopt, this
  // harness stops being able to adopt one too, and the test says so.
  const D3D11_TEXTURE2D_DESC td = nanoInteropTextureDesc(w, h);

  ID3D11Texture2D* tex = nullptr;
  if (FAILED(dev->CreateTexture2D(&td, nullptr, &tex))) return nullptr;
  return tex;
}

void releaseTexture(void* texture) {
  if (texture) static_cast<ID3D11Texture2D*>(texture)->Release();
}

void fillTexture(void* device, void* texture, int w, int h,
                 uint8_t b, uint8_t g, uint8_t r, uint8_t a) {
  auto* dev = static_cast<ID3D11Device*>(device);
  auto* tex = static_cast<ID3D11Texture2D*>(texture);
  if (!dev || !tex || w <= 0 || h <= 0) return;
  std::vector<uint8_t> px((size_t)w * h * 4);
  for (size_t i = 0; i + 3 < px.size(); i += 4) {
    px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = a;
  }
  ID3D11DeviceContext* ctx = immediateContext(dev);
  ctx->UpdateSubresource(tex, 0, nullptr, px.data(), (UINT)(w * 4), 0);
  ctx->Release();
}

bool readTexture(void* device, void* texture, int w, int h,
                 std::vector<uint8_t>& outRgba) {
  auto* dev = static_cast<ID3D11Device*>(device);
  auto* tex = static_cast<ID3D11Texture2D*>(texture);
  if (!dev || !tex || w <= 0 || h <= 0) return false;

  D3D11_TEXTURE2D_DESC td{};
  tex->GetDesc(&td);
  td.Usage = D3D11_USAGE_STAGING;
  td.BindFlags = 0;
  td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  td.MiscFlags = 0;

  ID3D11Texture2D* staging = nullptr;
  if (FAILED(dev->CreateTexture2D(&td, nullptr, &staging))) return false;

  ID3D11DeviceContext* ctx = immediateContext(dev);
  ctx->CopyResource(staging, tex);
  // Map(READ) on the immediate context blocks until everything queued ahead of
  // it — including the render we are reading — has run. That ordering is the
  // whole reason this uses the runtime's own context rather than a fresh one.
  D3D11_MAPPED_SUBRESOURCE m{};
  bool ok = SUCCEEDED(ctx->Map(staging, 0, D3D11_MAP_READ, 0, &m));
  if (ok) {
    outRgba.assign((size_t)w * h * 4, 0);
    const auto* src = static_cast<const uint8_t*>(m.pData);
    for (int y = 0; y < h; ++y) {
      const uint8_t* row = src + (size_t)y * m.RowPitch;
      uint8_t* dst = outRgba.data() + (size_t)y * w * 4;
      for (int x = 0; x < w; ++x) {
        // BGRA on the wire, RGBA out.
        dst[x * 4 + 0] = row[x * 4 + 2];
        dst[x * 4 + 1] = row[x * 4 + 1];
        dst[x * 4 + 2] = row[x * 4 + 0];
        dst[x * 4 + 3] = row[x * 4 + 3];
      }
    }
    ctx->Unmap(staging, 0);
  }
  ctx->Release();
  staging->Release();
  return ok;
}

}  // namespace barrel_probe
