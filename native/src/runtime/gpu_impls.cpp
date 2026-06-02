// gpu_impls.cpp — extern-C implementations of every gpu_* import the
// effects' main.cpp files reference via <gpu.h>. Each call routes to
// the singleton runtime's GPUBackend.
//
// Coverage strategy: implement what soft_glow + motion_blur use.
// Unused entry points get stubs that log + return -1 so missing
// functionality surfaces loudly rather than silently producing wrong
// pixels.

#include "runtime/effect_runtime.h"

#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>

#include "gpu/gpu_backend.h"

using effect_runtime::currentRuntime;
using effect_runtime::EffectInstance;

namespace {

gpu::GPUBackend* backend() {
  auto* rt = currentRuntime();
  return rt ? rt->gpu() : nullptr;
}

EffectInstance* active() {
  auto* rt = currentRuntime();
  return rt ? rt->active() : nullptr;
}

void unimplemented(const char* name) {
  std::cerr << "[effect_runtime] gpu_impls: unimplemented " << name << std::endl;
}

}  // namespace

extern "C" {

int gpu_get_backend(void) {
  auto* b = backend();
  return b ? b->getBackend() : -1;
}

int gpu_create_shader_module(const char* src, int src_len) {
  auto* b = backend();
  if (!b) return -1;
  return b->createShaderModule(std::string(src, src_len));
}

int gpu_create_shader_module_named(const char* name, int name_len) {
  auto* rt = currentRuntime();
  auto* b = backend();
  if (!rt || !b) return -1;
  std::string nameStr(name, name_len);
  std::string msl;
  if (!rt->lookupMSL(nameStr, &msl)) {
    std::cerr << "[effect_runtime] no MSL registered for shader name: "
              << nameStr << std::endl;
    return -1;
  }
  return b->createShaderModule(msl);
}

int gpu_create_buffer(int size, int usage) {
  auto* b = backend();
  if (!b) return -1;
  return b->createBuffer((uint32_t)size, usage);
}

int gpu_create_texture(int w, int h, int format) {
  auto* b = backend();
  if (!b) return -1;
  return b->createTexture((uint32_t)w, (uint32_t)h, format);
}

int gpu_create_texture_mips(int w, int h, int format, int mips) {
  auto* b = backend();
  if (!b) return -1;
  return b->createTextureWithMips((uint32_t)w, (uint32_t)h, format, mips);
}

int gpu_create_texture_3d(int, int, int, int) {
  unimplemented("create_texture_3d");
  return -1;
}

int gpu_create_sampler(int filterMode, int addressMode) {
  auto* b = backend();
  if (!b) return -1;
  return b->createSampler(filterMode, addressMode);
}

// Decode a packed Constants buffer (see gpu.h Constants::pack) into a
// vector of {name, value} for the backend.
static std::vector<gpu::GPUBackend::SpecConstant>
decodeConstants(const unsigned char* p, int len) {
  std::vector<gpu::GPUBackend::SpecConstant> out;
  if (!p || len < 4) return out;
  auto read_u32 = [](const unsigned char* q) {
    return (uint32_t)q[0] | ((uint32_t)q[1] << 8)
         | ((uint32_t)q[2] << 16) | ((uint32_t)q[3] << 24);
  };
  uint32_t count = read_u32(p); p += 4; len -= 4;
  for (uint32_t i = 0; i < count && len >= 4; ++i) {
    uint32_t nlen = read_u32(p); p += 4; len -= 4;
    if (len < (int)nlen + 8) break;
    std::string name((const char*)p, nlen); p += nlen; len -= (int)nlen;
    double v = 0;
    std::memcpy(&v, p, 8); p += 8; len -= 8;
    out.push_back({std::move(name), v});
  }
  return out;
}

// MSL reserves the name "main" for kernel functions; spirv-cross
// renames our shaders' "main" → "main0" during SPV→MSL translation.
// Effects (matching the WebGPU side) ask for "main" — translate here
// so the per-effect code doesn't need to know about the rename.
static std::string mapEntryName(const char* entry, int len) {
  std::string e(entry, len);
  auto* b = backend();
  if (b && b->getBackend() == 0 /*Metal*/ && e == "main") return "main0";
  return e;
}

int gpu_create_compute_pso_layout(int shader, const char* entry, int entry_len,
                                   int /*binding_count*/, const int* /*bindings*/) {
  // Metal doesn't need pre-declared binding layouts — the per-dispatch
  // setBuffer/setTexture/setSampler calls determine the actual binding.
  // We accept and discard the bindings array.
  auto* b = backend();
  if (!b) return -1;
  return b->createComputePSO(shader, mapEntryName(entry, entry_len));
}

int gpu_create_compute_pso_v2(int shader, const char* entry, int entry_len,
                               int /*binding_count*/, const int* /*bindings*/,
                               const unsigned char* constants, int constants_len) {
  auto* b = backend();
  if (!b) return -1;
  auto consts = decodeConstants(constants, constants_len);
  if (consts.empty()) {
    return b->createComputePSO(shader, mapEntryName(entry, entry_len));
  }
  return b->createComputePSOWithConstants(shader,
                                           mapEntryName(entry, entry_len),
                                           consts);
}

int gpu_create_render_pso_layout(int vs, const char* vse, int vsl,
                                  int fs, const char* fse, int fsl,
                                  int fmt, int /*bcount*/, const int* /*bindings*/) {
  auto* b = backend();
  if (!b) return -1;
  return b->createRenderPSO(vs, mapEntryName(vse, vsl),
                            fs, mapEntryName(fse, fsl), fmt);
}
int gpu_create_instanced_render_pso_layout(int vs, const char* vse, int vsl,
                                            int fs, const char* fse, int fsl,
                                            int fmt, int /*bcount*/, const int* /*bindings*/) {
  auto* b = backend();
  if (!b) return -1;
  return b->createInstancedRenderPSO(vs, mapEntryName(vse, vsl),
                                     fs, mapEntryName(fse, fsl), fmt, /*blend=*/0);
}
int gpu_create_instanced_render_pso(int vs, const char* vse, int vsl,
                                     int fs, const char* fse, int fsl, int fmt) {
  auto* b = backend();
  if (!b) return -1;
  return b->createInstancedRenderPSO(vs, mapEntryName(vse, vsl),
                                     fs, mapEntryName(fse, fsl), fmt, /*blend=*/0);
}
int gpu_create_instanced_render_pso_mrt_layout(int vs, const char* vse, int vsl,
                                                int fs, const char* fse, int fsl,
                                                int target_count, const int* target_formats,
                                                int /*bcount*/, const int* /*bindings*/) {
  auto* b = backend();
  if (!b) return -1;
  return b->createInstancedRenderPSOMRT(vs, mapEntryName(vse, vsl),
                                        fs, mapEntryName(fse, fsl),
                                        target_count, target_formats);
}
int gpu_create_instanced_render_pso_blend_layout(int vs, const char* vse, int vsl,
                                                  int fs, const char* fse, int fsl,
                                                  int fmt, int /*bcount*/,
                                                  const int* /*bindings*/, int blend_mode) {
  auto* b = backend();
  if (!b) return -1;
  return b->createInstancedRenderPSO(vs, mapEntryName(vse, vsl),
                                     fs, mapEntryName(fse, fsl), fmt, blend_mode);
}

void gpu_write_buffer(int buf, int offset, const void* data, int data_len) {
  auto* b = backend();
  if (!b) return;
  b->writeBuffer(buf, (uint32_t)offset,
                 static_cast<const uint8_t*>(data), (uint32_t)data_len);
}

int gpu_begin_compute_pass(void) {
  auto* b = backend();
  return b ? b->beginComputePass() : -1;
}
void gpu_compute_set_pso(int pass, int pso) {
  auto* b = backend();
  if (b) b->computeSetPSO(pass, pso);
}
void gpu_compute_set_buffer(int pass, int buf, int offset, int slot) {
  auto* b = backend();
  if (b) b->computeSetBuffer(pass, buf, (uint32_t)offset, slot);
}
void gpu_compute_set_texture(int pass, int texture, int slot, int access) {
  auto* b = backend();
  if (b) b->computeSetTexture(pass, texture, slot, access);
}
void gpu_compute_set_texture_mip(int pass, int texture, int slot,
                                  int access, int mip) {
  auto* b = backend();
  if (b) b->computeSetTextureMip(pass, texture, slot, access, mip);
}
void gpu_compute_set_sampler(int pass, int sampler, int slot) {
  auto* b = backend();
  if (b) b->computeSetSampler(pass, sampler, slot);
}
void gpu_compute_dispatch(int pass, int x, int y, int z) {
  auto* b = backend();
  if (b) b->computeDispatch(pass, (uint32_t)x, (uint32_t)y, (uint32_t)z);
}
void gpu_end_compute_pass(int pass) {
  auto* b = backend();
  if (b) b->endComputePass(pass);
}

int gpu_begin_render_pass(int tex, float r, float g, float b_, float a) {
  auto* b = backend();
  return b ? b->beginRenderPass(tex, r, g, b_, a) : -1;
}
int gpu_begin_render_pass_load(int tex) {
  auto* b = backend();
  return b ? b->beginRenderPassLoad(tex) : -1;
}
int gpu_begin_render_pass_mrt(int count, const int* texs, const float* clears) {
  auto* b = backend();
  return b ? b->beginRenderPassMRT(count, texs, clears) : -1;
}
void gpu_render_set_pso(int pass, int pso) {
  auto* b = backend();
  if (b) b->renderSetPSO(pass, pso);
}
void gpu_render_set_vertex_buffer(int pass, int buf, int offset, int slot) {
  auto* b = backend();
  if (b) b->renderSetVertexBuffer(pass, buf, (uint32_t)offset, slot);
}
void gpu_render_set_buffer(int pass, int buf, int slot) {
  auto* b = backend();
  if (b) b->renderSetBuffer(pass, buf, slot);
}
void gpu_render_draw(int pass, int vc, int ic) {
  auto* b = backend();
  if (b) b->renderDraw(pass, (uint32_t)vc, (uint32_t)ic);
}
void gpu_end_render_pass(int pass) {
  auto* b = backend();
  if (b) b->endRenderPass(pass);
}

void gpu_submit(void) {
  auto* b = backend();
  if (b) b->submit();
}

int gpu_get_render_target(void) {
  auto* b = backend();
  return b ? b->getSurfaceTexture() : -1;
}
int gpu_get_render_target_width(void) {
  auto* b = backend();
  return b ? b->getSurfaceWidth() : 0;
}
int gpu_get_render_target_height(void) {
  auto* b = backend();
  return b ? b->getSurfaceHeight() : 0;
}
void gpu_release(int handle) {
  auto* b = backend();
  if (b) b->release(handle);
}

int gpu_get_input_texture(int /*idx*/) {
  // Legacy multi-input API — soft_glow uses textureForField instead.
  return -1;
}
int gpu_get_input_texture_count(void) { return 0; }

int gpu_texture_for_field(const char* path, int path_len) {
  auto* inst = active();
  if (!inst) return -1;
  return inst->textureField(std::string(path, path_len));
}
int gpu_buffer_for_field(const char* path, int path_len) {
  auto* inst = active();
  if (!inst) return -1;
  return inst->bufferField(std::string(path, path_len));
}

void gpu_clear_texture(int tex, float r, float g, float b, float a) {
  auto* bk = backend();
  if (bk) bk->clearTexture(tex, r, g, b, a);
}
void gpu_copy_texture(int src, int dst) {
  auto* bk = backend();
  if (bk) bk->copyTexture(src, dst);
}

}  // extern "C"
