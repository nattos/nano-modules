// test_spout_outputs.cpp — a display output as a Spout sender, end to end in
// one process: SpoutOutputs registers a sender; a "receiver" finds it by name
// through Spout's own registry (as Resolume, TouchDesigner or OBS would), the
// ENGINE side opens the share handle on its own device and draws a colour
// (what presentScaled does), and the receiver reads that colour out of the
// texture on a third device. Closing the output unregisters the sender.
//
// Registers a real (short-lived) sender: any Spout app running on the machine
// lists "Nano Modules - Spout test <pid>" for a moment.

#include <catch2/catch_test_macros.hpp>

#include <windows.h>
#include <d3d11.h>

#include <string>

#include "SpoutSenderNames.h"
#include "compositor/spout_outputs.h"

namespace {

using PFN_D3D11CreateDevice_t = HRESULT(WINAPI*)(
    IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL*, UINT, UINT,
    ID3D11Device**, D3D_FEATURE_LEVEL*, ID3D11DeviceContext**);

struct Dev {
  ID3D11Device* d = nullptr;
  ID3D11DeviceContext* c = nullptr;
  bool make() {
    HMODULE m = LoadLibraryA("d3d11.dll");
    auto create = m ? (PFN_D3D11CreateDevice_t)GetProcAddress(m, "D3D11CreateDevice") : nullptr;
    return create && SUCCEEDED(create(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
                                      D3D11_SDK_VERSION, &d, nullptr, &c));
  }
  ~Dev() {
    if (c) c->Release();
    if (d) d->Release();
  }
};

}  // namespace

TEST_CASE("spout: an output is a sender receivers find, with the engine's pixels",
          "[spout_outputs]") {
  Dev engine, receiver;
  if (!engine.make() || !receiver.make()) SKIP("No D3D11 device");
  compositor::SpoutOutputs outs;
  const std::string slot = "Spout test " + std::to_string(GetCurrentProcessId());
  HANDLE share = (HANDLE)outs.ensure("d1", slot, 64, 32);
  REQUIRE(share);
  CHECK(outs.has("d1"));
  const std::string name = outs.senderName("d1");
  CHECK(name == "Nano Modules - " + slot);
  // Same size and name: the same texture.
  CHECK(outs.ensure("d1", slot, 64, 32) == (void*)share);

  // The engine draws into it (its own device, by the handle).
  ID3D11Texture2D* tex = nullptr;
  REQUIRE(SUCCEEDED(engine.d->OpenSharedResource(share, __uuidof(ID3D11Texture2D), (void**)&tex)));
  ID3D11RenderTargetView* rtv = nullptr;
  REQUIRE(SUCCEEDED(engine.d->CreateRenderTargetView(tex, nullptr, &rtv)));
  const float orange[4] = {1.0f, 0.25f, 0.0f, 1.0f};
  engine.c->ClearRenderTargetView(rtv, orange);
  engine.c->Flush();
  outs.publish("d1");
  rtv->Release();
  tex->Release();

  // A receiver: by name, through Spout's registry.
  spoutSenderNames names;
  char nm[256] = {0};
  strncpy_s(nm, sizeof(nm), name.c_str(), _TRUNCATE);
  unsigned w = 0, h = 0;
  HANDLE found = nullptr;
  DWORD fmt = 0;
  REQUIRE(names.FindSender(nm, w, h, found, fmt));
  CHECK(w == 64);
  CHECK(h == 32);
  CHECK(found == share);
  CHECK(fmt == DXGI_FORMAT_B8G8R8A8_UNORM);

  ID3D11Texture2D* rtex = nullptr;
  REQUIRE(SUCCEEDED(receiver.d->OpenSharedResource(found, __uuidof(ID3D11Texture2D), (void**)&rtex)));
  D3D11_TEXTURE2D_DESC td{};
  rtex->GetDesc(&td);
  td.Usage = D3D11_USAGE_STAGING;
  td.BindFlags = 0;
  td.MiscFlags = 0;
  td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ID3D11Texture2D* staging = nullptr;
  REQUIRE(SUCCEEDED(receiver.d->CreateTexture2D(&td, nullptr, &staging)));
  receiver.c->CopyResource(staging, rtex);
  D3D11_MAPPED_SUBRESOURCE m{};
  REQUIRE(SUCCEEDED(receiver.c->Map(staging, 0, D3D11_MAP_READ, 0, &m)));
  const uint8_t* px = (const uint8_t*)m.pData + 16 * m.RowPitch + 32 * 4;  // BGRA
  CHECK(px[2] == 255);
  CHECK(px[1] >= 62);
  CHECK(px[1] <= 66);
  CHECK(px[0] == 0);
  receiver.c->Unmap(staging, 0);
  staging->Release();
  rtex->Release();

  // A new size: a new texture under the same sender name.
  HANDLE bigger = (HANDLE)outs.ensure("d1", slot, 128, 64);
  REQUIRE(bigger);
  CHECK(bigger != share);
  REQUIRE(names.FindSender(nm, w, h, found, fmt));
  CHECK(w == 128);
  CHECK(found == bigger);

  outs.close("d1");
  CHECK_FALSE(outs.has("d1"));
  CHECK_FALSE(names.FindSenderName(nm));
}
