// test_gpu_readback.mm — GPUBackend::readBuffer (the native half of the effect
// GPU→CPU readback ABI). Metal buffers are MTLStorageModeShared, so readBuffer()
// is a bounds-checked coherent memcpy that must mirror writeBuffer().

#include <catch2/catch_test_macros.hpp>
#include <cstdint>
#include "gpu/gpu_backend.h"

TEST_CASE("Metal GPU buffer readback round-trips", "[gpu_readback]") {
  auto gpu = gpu::createMetalBackend();
  REQUIRE(gpu != nullptr);

  // usage 1 = Storage (see gpu.h BufferUsage).
  const int32_t vals[4] = {7, -3, 1000000, 42};
  int32_t buf = gpu->createBuffer(sizeof(vals), 1);
  REQUIRE(buf > 0);
  gpu->writeBuffer(buf, 0, reinterpret_cast<const uint8_t*>(vals), sizeof(vals));

  int32_t out[4] = {0, 0, 0, 0};
  REQUIRE(gpu->readBuffer(buf, 0, out, sizeof(out)) == (int)sizeof(out));
  for (int i = 0; i < 4; i++) REQUIRE(out[i] == vals[i]);

  // Offset read: skip the first int, read the next two.
  int32_t two[2] = {0, 0};
  REQUIRE(gpu->readBuffer(buf, sizeof(int32_t), two, sizeof(two)) == (int)sizeof(two));
  REQUIRE(two[0] == vals[1]);
  REQUIRE(two[1] == vals[2]);

  // Out-of-range read is rejected (returns 0), not a buffer overrun.
  int32_t big[8] = {0};
  REQUIRE(gpu->readBuffer(buf, 0, big, sizeof(big)) == 0);
}
