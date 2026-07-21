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

TEST_CASE("Metal GPU: indirect dispatch + draw consume GPU-written args", "[gpu_metal]") {
  // The whole point of the indirect ABI: a compute pass DECIDES the work size
  // and downstream dispatch/draw consume it with zero CPU readback. Kernel A
  // writes {3,1,1} dispatch args + {6,N,0,0} draw args into one args buffer;
  // kernel B runs under dispatchIndirect and stamps its thread ids; a draw
  // under drawIndirect covers the target only when the GPU-written instance
  // count says so.
  auto gpu = gpu::createMetalBackend();
  REQUIRE(gpu != nullptr);

  // args[0..2] = dispatch {x,y,z}; args[3..6] = draw {vc, ic, fv, fi}.
  int args = gpu->createBuffer(7 * 4, /*Storage*/ 1);
  int data = gpu->createBuffer(64 * 4, /*Storage*/ 1);
  REQUIRE(args > 0);
  REQUIRE(data > 0);
  const uint32_t zeros[64] = {0};
  gpu->writeBuffer(data, 0, reinterpret_cast<const uint8_t*>(zeros), sizeof(zeros));

  int writerLib = gpu->createShaderModule(R"(// nano_threadgroup: 1 1 1
    #include <metal_stdlib>
    using namespace metal;
    kernel void write_args(device uint* args [[buffer(0)]],
                           uint id [[thread_position_in_grid]]) {
      args[0] = 3; args[1] = 1; args[2] = 1;          // dispatch: 3 groups
      args[3] = 6; args[4] = 1; args[5] = 0; args[6] = 0;  // draw: quad, 1 instance
    }
  )");
  int stampLib = gpu->createShaderModule(R"(// nano_threadgroup: 4 1 1
    #include <metal_stdlib>
    using namespace metal;
    kernel void stamp(device uint* data [[buffer(0)]],
                      uint id [[thread_position_in_grid]]) {
      data[id] = 100 + id;
    }
  )");
  REQUIRE(writerLib > 0);
  REQUIRE(stampLib > 0);
  int writerPso = gpu->createComputePSO(writerLib, "write_args");
  int stampPso = gpu->createComputePSO(stampLib, "stamp");
  REQUIRE(writerPso > 0);
  REQUIRE(stampPso > 0);

  int pass = gpu->beginComputePass();
  gpu->computeSetPSO(pass, writerPso);
  gpu->computeSetBuffer(pass, args, 0, 0);
  gpu->computeDispatch(pass, 1, 1, 1);
  gpu->endComputePass(pass);

  pass = gpu->beginComputePass();
  gpu->computeSetPSO(pass, stampPso);
  gpu->computeSetBuffer(pass, data, 0, 0);
  gpu->computeDispatchIndirect(pass, args, /*offset=*/0);
  gpu->endComputePass(pass);
  gpu->submit();

  // 3 groups × 4 threads = exactly 12 stamped elements.
  uint32_t out[16] = {0};
  REQUIRE(gpu->readBuffer(data, 0, out, sizeof(out)) == (int)sizeof(out));
  for (int i = 0; i < 12; ++i) {
    INFO("data[" << i << "] = " << out[i]);
    CHECK(out[i] == 100u + (uint32_t)i);
  }
  CHECK(out[12] == 0u);  // beyond the GPU-written dispatch size: untouched

  // Indirect draw: fullscreen quad (6 verts) from the GPU-written args → the
  // clear color is fully overwritten. Then zero the instance count on the CPU
  // and draw again → nothing rendered, the clear survives.
  int target = gpu->createTexture(16, 16, 1);
  REQUIRE(target > 0);
  int vsLib = gpu->createShaderModule(R"(
    #include <metal_stdlib>
    using namespace metal;
    struct VOut { float4 pos [[position]]; };
    vertex VOut vmain(uint vid [[vertex_id]]) {
      float2 p[6] = { float2(-1,-1), float2(1,-1), float2(-1,1),
                      float2(-1,1), float2(1,-1), float2(1,1) };
      VOut o; o.pos = float4(p[vid], 0, 1); return o;
    }
    fragment float4 fmain() { return float4(0, 1, 0, 1); }
  )");
  REQUIRE(vsLib > 0);
  int rpso = gpu->createInstancedRenderPSO(vsLib, "vmain", vsLib, "fmain",
                                           /*RGBA8*/ 1, /*blend=*/2);
  REQUIRE(rpso > 0);

  pass = gpu->beginRenderPass(target, 1, 0, 0, 1);  // red clear
  gpu->renderSetPSO(pass, rpso);
  gpu->renderDrawIndirect(pass, args, /*offset=*/3 * 4);
  gpu->endRenderPass(pass);
  gpu->submit();
  auto px = gpu->readbackTexture(target, 16, 16);
  REQUIRE(px.size() == 16 * 16 * 4);
  const int c = (8 * 16 + 8) * 4;
  INFO("drawn center rgba = " << (int)px[c] << "," << (int)px[c+1] << ","
       << (int)px[c+2] << "," << (int)px[c+3]);
  CHECK((int)px[c + 1] >= 250);  // green: the GPU-written draw args drew
  CHECK((int)px[c + 0] <= 5);

  const uint32_t zeroDraw[4] = {6, 0, 0, 0};
  gpu->writeBuffer(args, 3 * 4, reinterpret_cast<const uint8_t*>(zeroDraw),
                   sizeof(zeroDraw));
  pass = gpu->beginRenderPass(target, 1, 0, 0, 1);
  gpu->renderSetPSO(pass, rpso);
  gpu->renderDrawIndirect(pass, args, /*offset=*/3 * 4);
  gpu->endRenderPass(pass);
  gpu->submit();
  px = gpu->readbackTexture(target, 16, 16);
  INFO("zero-instance center rgba = " << (int)px[c] << "," << (int)px[c+1]);
  CHECK((int)px[c + 0] >= 250);  // red clear survives: instance_count 0 drew nothing
  CHECK((int)px[c + 1] <= 5);
}
