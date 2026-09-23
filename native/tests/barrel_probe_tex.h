#pragma once
// barrel_probe_tex.h — stand where the FFGL barrel's InteropTexture stands.
//
// The barrel does not hand the runtime textures the runtime made. It builds an
// interop pair against the device the ABI advertises (bridge_rt_gpu_device) and
// passes those through bridge_executor_render, so the engine renders straight
// into memory the host's GL pipeline can read. The interop half of that needs a
// GL context and a working IOSurface / WGL_NV_DX_interop2 share, which no
// headless test has.
//
// Everything ELSE about it is testable: a texture created outside the engine,
// on that device, with those bind flags, adopted, rendered into, read back.
// These helpers make exactly such a texture — the same format and usage the
// interop pair has, minus the sharing — so a test can assert both sides of the
// seam and leave only the share itself unproven.

#include <cstdint>
#include <vector>

namespace barrel_probe {

/// A BGRA8 texture on `device` (an id<MTLTexture>'s device / ID3D11Device*),
/// bound for everything the runtime may do to it. Null on failure.
void* createTexture(void* device, int w, int h);
void releaseTexture(void* texture);

/// Fill every pixel with one BGRA colour, so a passthrough render is
/// distinguishable from a render that never happened.
void fillTexture(void* device, void* texture, int w, int h,
                 uint8_t b, uint8_t g, uint8_t r, uint8_t a);

/// Upload `bgra` (w*h*4 bytes, row 0 = top) verbatim — for a pattern that a
/// crop, a scale or a flip would visibly change, which a flat fill cannot show.
void uploadTexture(void* device, void* texture, int w, int h, const uint8_t* bgra);

/// Read the texture back as RGBA8, row-major, w*h*4 bytes. False on failure.
bool readTexture(void* device, void* texture, int w, int h,
                 std::vector<uint8_t>& outRgba);

}  // namespace barrel_probe
