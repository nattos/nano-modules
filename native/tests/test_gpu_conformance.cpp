// test_gpu_conformance.cpp — the same assertions against whatever backend this
// platform has. Metal on macOS, D3D11 on Windows.
//
// This is the acceptance harness for the Windows port: it runs identically on
// both, so a divergence is a backend bug rather than a test difference. It is
// plain C++ with no Objective-C, and reaches the backend through
// gpu::createBackend() rather than naming one.
//
// The shader cases still carry two source strings, because createShaderModule
// takes PLATFORM-NATIVE source — that is exactly the duplication Stage 5
// removes by routing these through the HLSL -> SPIR-V pipeline the effects
// already use. Until then, note the trap: `else` must not mean Metal.

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "gpu/gpu_backend.h"

namespace {

constexpr int32_t kBackendMetal = 0;
constexpr int32_t kBackendD3D11 = 2;

/// Order-sensitive checksum, so two backends can be compared by one number.
uint32_t fnv1a(const std::vector<uint8_t>& v) {
  uint32_t h = 2166136261u;
  for (uint8_t b : v) { h ^= b; h *= 16777619u; }
  return h;
}

const char* backendName(int32_t id) {
  switch (id) {
    case kBackendMetal: return "Metal";
    case 1:             return "WebGPU";
    case kBackendD3D11: return "D3D11";
    default:            return "unknown";
  }
}

/// A gradient with an absolute vertical reference: red rises with x, green with
/// y. A backend that flips Y renders it upside down, which a symmetric pattern
/// would hide entirely.
std::string gradientSource(int32_t backend) {
  if (backend == kBackendD3D11) {
    return R"(
RWTexture2D<float4> outTex : register(u0);
[numthreads(8,8,1)]
void nano_gradient(uint3 gid : SV_DispatchThreadID) {
  uint w, h; outTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float2 uv = float2(gid.xy) / float2(w, h);
  outTex[gid.xy] = float4(uv.x, uv.y, 0.25, 1.0);
}
)";
  }
  if (backend == kBackendMetal) {
    return R"(// nano_threadgroup: 8 8 1
#include <metal_stdlib>
using namespace metal;
kernel void nano_gradient(texture2d<float, access::write> outTex [[texture(0)]],
                          uint2 gid [[thread_position_in_grid]]) {
  const uint w = outTex.get_width(), h = outTex.get_height();
  if (gid.x >= w || gid.y >= h) return;
  const float2 uv = float2(gid) / float2(w, h);
  outTex.write(float4(uv.x, uv.y, 0.25, 1.0), gid);
}
)";
  }
  return {};
}

}  // namespace

TEST_CASE("the platform has a GPU backend", "[gpu_conformance]") {
  auto gpu = gpu::createBackend();
  if (!gpu) { SKIP("no GPU device available"); }
  const int32_t id = gpu->getBackend();
  std::printf("[conformance] backend = %s (%d)\n", backendName(id), id);
  REQUIRE((id == kBackendMetal || id == kBackendD3D11));
}

TEST_CASE("GPU buffers round-trip through readBuffer", "[gpu_conformance]") {
  auto gpu = gpu::createBackend();
  if (!gpu) { SKIP("no GPU device available"); }

  // usage 1 = Storage (gpu.h BufferUsage).
  const int32_t vals[4] = {7, -3, 1000000, 42};
  const int32_t buf = gpu->createBuffer(sizeof(vals), 1);
  REQUIRE(buf >= 0);
  gpu->writeBuffer(buf, 0, reinterpret_cast<const uint8_t*>(vals), sizeof(vals));

  int32_t out[4] = {0, 0, 0, 0};
  REQUIRE(gpu->readBuffer(buf, 0, out, sizeof(out)) == (int)sizeof(out));
  for (int i = 0; i < 4; ++i) REQUIRE(out[i] == vals[i]);

  // Offset read: skip the first int, take the next two.
  int32_t two[2] = {0, 0};
  REQUIRE(gpu->readBuffer(buf, sizeof(int32_t), two, sizeof(two)) == (int)sizeof(two));
  REQUIRE(two[0] == vals[1]);
  REQUIRE(two[1] == vals[2]);
}

TEST_CASE("clearTexture reaches the pixels", "[gpu_conformance]") {
  auto gpu = gpu::createBackend();
  if (!gpu) { SKIP("no GPU device available"); }

  const uint32_t N = 16;
  const int32_t tex = gpu->createTexture(N, N, /*RGBA8*/ 1);
  REQUIRE(tex >= 0);
  REQUIRE(gpu->getTextureWidth(tex) == (int32_t)N);
  REQUIRE(gpu->getTextureFormat(tex) == 1);

  gpu->clearTexture(tex, 0.0f, 1.0f, 0.0f, 1.0f);
  gpu->submit();

  const std::vector<uint8_t> px = gpu->readbackTexture(tex, N, N);
  REQUIRE(px.size() == (size_t)N * N * 4);
  // Green, opaque, everywhere. Channel ORDER matters: an RGBA8 texture read
  // back as BGRA would put the green in the same slot, so check red and blue
  // are both zero rather than just looking for 255 somewhere.
  for (uint32_t i = 0; i < N * N; ++i) {
    REQUIRE(px[i * 4 + 0] == 0);
    REQUIRE(px[i * 4 + 1] == 255);
    REQUIRE(px[i * 4 + 2] == 0);
    REQUIRE(px[i * 4 + 3] == 255);
  }
}

TEST_CASE("a compute shader writes a gradient", "[gpu_conformance]") {
  auto gpu = gpu::createBackend();
  if (!gpu) { SKIP("no GPU device available"); }

  const std::string src = gradientSource(gpu->getBackend());
  if (src.empty()) { SKIP("no gradient shader for this backend"); }

  const uint32_t N = 64;
  const int32_t tex = gpu->createTexture(N, N, /*RGBA8*/ 1);
  REQUIRE(tex >= 0);

  const int32_t lib = gpu->createShaderModule(src);
  REQUIRE(lib >= 0);
  const int32_t pso = gpu->createComputePSO(lib, "nano_gradient");
  REQUIRE(pso >= 0);

  const int32_t pass = gpu->beginComputePass();
  gpu->computeSetPSO(pass, pso);
  gpu->computeSetTexture(pass, tex, /*slot*/ 0, /*write*/ 1);
  gpu->computeDispatch(pass, N / 8, N / 8, 1);
  gpu->endComputePass(pass);
  gpu->submit();

  const std::vector<uint8_t> px = gpu->readbackTexture(tex, N, N);
  REQUIRE(px.size() == (size_t)N * N * 4);

  const auto at = [&](uint32_t x, uint32_t y, int c) -> int {
    return px[((size_t)y * N + x) * 4 + c];
  };

  // Corners pin BOTH the values and the orientation.
  CHECK(at(0, 0, 0) == 0);           // top-left: no red
  CHECK(at(0, 0, 1) == 0);           // top-left: no green
  CHECK(at(N - 1, 0, 0) >= 250);     // top-right: full red
  CHECK(at(N - 1, 0, 1) == 0);       // ...and still no green
  CHECK(at(0, N - 1, 0) == 0);       // bottom-left: no red
  CHECK(at(0, N - 1, 1) >= 250);     // ...but full green
  // Blue is a flat 0.25 and alpha a flat 1.0 across the whole image.
  for (uint32_t i = 0; i < N * N; ++i) {
    REQUIRE(px[i * 4 + 2] >= 62);
    REQUIRE(px[i * 4 + 2] <= 65);
    REQUIRE(px[i * 4 + 3] == 255);
  }

  // One number to compare across platforms. Printed rather than asserted:
  // a rounding difference in the gradient is a real finding, not a failure to
  // hide behind an equality check.
  std::printf("[conformance] gradient fnv1a = 0x%08x  (%s)\n",
              fnv1a(px), backendName(gpu->getBackend()));
  std::fflush(stdout);
}

TEST_CASE("copyTexture across formats keeps red and blue apart",
          "[gpu_conformance]") {
  // A copy moves BYTES, so BGRA8 -> RGBA8 through a plain blit silently swaps
  // red and blue — blue comes out orange. Both backends special-case a format
  // mismatch into a shader copy. This is the cheapest possible gate on that,
  // and the one to check first when anything downstream looks wrong.
  auto gpu = gpu::createBackend();
  if (!gpu) { SKIP("no GPU device available"); }

  const uint32_t N = 8;
  const int32_t bgra = gpu->createTexture(N, N, /*BGRA8*/ 0);
  const int32_t rgba = gpu->createTexture(N, N, /*RGBA8*/ 1);
  REQUIRE(bgra >= 0);
  REQUIRE(rgba >= 0);

  // Pure red, expressed through the clear API (which takes r,g,b,a whatever
  // the storage order is).
  gpu->clearTexture(bgra, 1.0f, 0.0f, 0.0f, 1.0f);
  gpu->submit();
  gpu->copyTexture(bgra, rgba);
  gpu->submit();

  const std::vector<uint8_t> px = gpu->readbackTexture(rgba, N, N);
  REQUIRE(px.size() == (size_t)N * N * 4);
  // Still red after crossing the format boundary. If this reads 0,0,255 the
  // shader-copy branch was skipped and a byte blit happened instead.
  CHECK((int)px[0] == 255);
  CHECK((int)px[1] == 0);
  CHECK((int)px[2] == 0);
  CHECK((int)px[3] == 255);
}
