#pragma once

// The D3D11 descriptor the barrel's interop texture is created with, in one
// place so it cannot drift.
//
// adoptExternalTexture builds the runtime's views straight from these bind
// flags, and D3D11 cannot add a bind flag to a texture after creation — so a
// texture made here without UNORDERED_ACCESS is one no compute effect can ever
// write, with no error at the point the flag was omitted. The test harness
// (tests/barrel_probe_tex_d3d11.cpp) makes its textures through this same
// function, which is the whole reason it is a function: otherwise the test
// would keep passing against its own private copy of the descriptor while the
// plugin's diverged.

#include <d3d11.h>

inline D3D11_TEXTURE2D_DESC nanoInteropTextureDesc(int width, int height) {
  D3D11_TEXTURE2D_DESC td{};
  td.Width = (UINT)width;
  td.Height = (UINT)height;
  td.MipLevels = 1;
  td.ArraySize = 1;
  // BGRA8, matching the Apple side's kCVPixelFormatType_32BGRA, and what FFGL
  // hosts hand out.
  td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  td.SampleDesc.Count = 1;
  td.Usage = D3D11_USAGE_DEFAULT;
  // Everything the engine may do to it: sample it, write it from a compute
  // shader, rasterize into it.
  td.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS |
                 D3D11_BIND_RENDER_TARGET;
  // Deliberately NOT D3D11_RESOURCE_MISC_SHARED. The original NV_DX_interop
  // required a shared resource; interop2 is precisely the extension that lifted
  // that for D3D11, and asking for SHARED alongside UNORDERED_ACCESS is refused
  // by some drivers.
  td.MiscFlags = 0;
  return td;
}
