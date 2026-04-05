#pragma once
/*
 * gpu.h — C++ wrappers for the gpu.* host API.
 *
 * Provides type-safe, D3D12-style resource handles and command encoding.
 * Thin wrappers over the raw C imports — zero overhead when optimized.
 *
 * Usage:
 *   auto device = gpu::Device::create();
 *   auto shader = device.createShaderModule(source);
 *   auto pso = device.createComputePSO(shader, "main");
 *   auto buffer = device.createBuffer(1024, gpu::BufferUsage::Storage);
 *
 *   auto pass = gpu::ComputePass::begin();
 *   pass.setPSO(pso);
 *   pass.setBuffer(buffer, 0, 0);
 *   pass.dispatch(16, 1, 1);
 *   pass.end();
 *   device.submit();
 */

#include <cstring>

// Raw C imports (defined in each module's source, or via a shared import header)
extern "C" {
  __attribute__((import_module("gpu"), import_name("get_backend")))
  int gpu_get_backend(void);
  __attribute__((import_module("gpu"), import_name("create_shader_module")))
  int gpu_create_shader_module(const char* src, int src_len);
  __attribute__((import_module("gpu"), import_name("create_buffer")))
  int gpu_create_buffer(int size, int usage);
  __attribute__((import_module("gpu"), import_name("create_texture")))
  int gpu_create_texture(int w, int h, int format);
  __attribute__((import_module("gpu"), import_name("create_compute_pso")))
  int gpu_create_compute_pso(int shader, const char* entry, int entry_len);
  __attribute__((import_module("gpu"), import_name("create_render_pso")))
  int gpu_create_render_pso(int vs_shader, const char* vs, int vs_len,
                             int fs_shader, const char* fs, int fs_len, int format);
  __attribute__((import_module("gpu"), import_name("write_buffer")))
  void gpu_write_buffer(int buf, int offset, const void* data, int data_len);
  __attribute__((import_module("gpu"), import_name("begin_compute_pass")))
  int gpu_begin_compute_pass(void);
  __attribute__((import_module("gpu"), import_name("compute_set_pso")))
  void gpu_compute_set_pso(int pass, int pso);
  __attribute__((import_module("gpu"), import_name("compute_set_buffer")))
  void gpu_compute_set_buffer(int pass, int buf, int offset, int slot);
  __attribute__((import_module("gpu"), import_name("compute_set_texture")))
  void gpu_compute_set_texture(int pass, int texture, int slot, int access);
  __attribute__((import_module("gpu"), import_name("compute_dispatch")))
  void gpu_compute_dispatch(int pass, int x, int y, int z);
  __attribute__((import_module("gpu"), import_name("end_compute_pass")))
  void gpu_end_compute_pass(int pass);
  __attribute__((import_module("gpu"), import_name("begin_render_pass")))
  int gpu_begin_render_pass(int texture, float cr, float cg, float cb, float ca);
  __attribute__((import_module("gpu"), import_name("render_set_pso")))
  void gpu_render_set_pso(int pass, int pso);
  __attribute__((import_module("gpu"), import_name("render_set_vertex_buffer")))
  void gpu_render_set_vertex_buffer(int pass, int buf, int offset, int slot);
  __attribute__((import_module("gpu"), import_name("render_draw")))
  void gpu_render_draw(int pass, int vertex_count, int instance_count);
  __attribute__((import_module("gpu"), import_name("end_render_pass")))
  void gpu_end_render_pass(int pass);
  __attribute__((import_module("gpu"), import_name("submit")))
  void gpu_submit(void);
  __attribute__((import_module("gpu"), import_name("get_render_target")))
  int gpu_get_render_target(void);
  __attribute__((import_module("gpu"), import_name("get_render_target_width")))
  int gpu_get_render_target_width(void);
  __attribute__((import_module("gpu"), import_name("get_render_target_height")))
  int gpu_get_render_target_height(void);
  __attribute__((import_module("gpu"), import_name("release")))
  void gpu_release(int handle);
  __attribute__((import_module("gpu"), import_name("get_input_texture")))
  int gpu_get_input_texture(int index);
  __attribute__((import_module("gpu"), import_name("get_input_texture_count")))
  int gpu_get_input_texture_count(void);
}

namespace gpu {

// --- Enums ---

enum class Backend : int { Metal = 0, WebGPU = 1, None = -1 };

enum class BufferUsage : int { Vertex = 0, Storage = 1, Uniform = 2 };

enum class TextureFormat : int { BGRA8 = 0, RGBA8 = 1, Surface = 2 };

// --- Handle base ---

struct Handle {
  int id = -1;

  Handle() = default;
  explicit Handle(int id) : id(id) {}

  bool valid() const { return id > 0; }
  explicit operator bool() const { return valid(); }

  void release() {
    if (valid()) { gpu_release(id); id = -1; }
  }
};

// --- Typed handles ---

struct ShaderModule : Handle {
  using Handle::Handle;
};

struct Buffer : Handle {
  using Handle::Handle;

  void writeBytes(const void* data, int byteCount, int offset = 0) {
    gpu_write_buffer(id, offset, data, byteCount);
  }

  template<typename T>
  void write(const T* data, int count, int offset = 0) {
    gpu_write_buffer(id, offset, data, count * static_cast<int>(sizeof(T)));
  }

  template<typename T>
  void writeOne(const T& value, int offset = 0) {
    gpu_write_buffer(id, offset, &value, static_cast<int>(sizeof(T)));
  }
};

struct Texture : Handle {
  using Handle::Handle;
};

struct ComputePSO : Handle {
  using Handle::Handle;
};

struct RenderPSO : Handle {
  using Handle::Handle;
};

// --- Compute pass ---

struct ComputePass {
  int id;

  static ComputePass begin() { return { gpu_begin_compute_pass() }; }

  void setPSO(ComputePSO pso) { gpu_compute_set_pso(id, pso.id); }

  void setBuffer(Buffer buf, int slot, int offset = 0) {
    gpu_compute_set_buffer(id, buf.id, offset, slot);
  }

  // access: 0=read, 1=write, 2=read_write
  void setTexture(Texture tex, int slot, int access = 0) {
    gpu_compute_set_texture(id, tex.id, slot, access);
  }

  void dispatch(int x, int y = 1, int z = 1) {
    gpu_compute_dispatch(id, x, y, z);
  }

  void end() { gpu_end_compute_pass(id); }
};

// --- Render pass ---

struct RenderPass {
  int id;

  static RenderPass begin(Texture target, float r = 0, float g = 0, float b = 0, float a = 1) {
    return { gpu_begin_render_pass(target.id, r, g, b, a) };
  }

  void setPSO(RenderPSO pso) { gpu_render_set_pso(id, pso.id); }

  void setVertexBuffer(Buffer buf, int slot = 0, int offset = 0) {
    gpu_render_set_vertex_buffer(id, buf.id, offset, slot);
  }

  void draw(int vertexCount, int instanceCount = 1) {
    gpu_render_draw(id, vertexCount, instanceCount);
  }

  void end() { gpu_end_render_pass(id); }
};

// --- Device (factory + submit) ---

struct Device {
  static Backend backend() { return static_cast<Backend>(gpu_get_backend()); }

  static ShaderModule createShaderModule(const char* source) {
    return ShaderModule(gpu_create_shader_module(source, std::strlen(source)));
  }

  static Buffer createBuffer(int size, BufferUsage usage) {
    return Buffer(gpu_create_buffer(size, static_cast<int>(usage)));
  }

  static Texture createTexture(int w, int h, TextureFormat format = TextureFormat::RGBA8) {
    return Texture(gpu_create_texture(w, h, static_cast<int>(format)));
  }

  static ComputePSO createComputePSO(ShaderModule shader, const char* entryPoint) {
    return ComputePSO(gpu_create_compute_pso(shader.id, entryPoint, std::strlen(entryPoint)));
  }

  static RenderPSO createRenderPSO(ShaderModule vs, const char* vsEntry,
                                    ShaderModule fs, const char* fsEntry,
                                    TextureFormat format = TextureFormat::Surface) {
    return RenderPSO(gpu_create_render_pso(
        vs.id, vsEntry, std::strlen(vsEntry),
        fs.id, fsEntry, std::strlen(fsEntry),
        static_cast<int>(format)));
  }

  static Texture inputTexture(int index) { return Texture(gpu_get_input_texture(index)); }
  static int inputTextureCount() { return gpu_get_input_texture_count(); }

  static Texture renderTarget() { return Texture(gpu_get_render_target()); }
  static int renderTargetWidth() { return gpu_get_render_target_width(); }
  static int renderTargetHeight() { return gpu_get_render_target_height(); }

  static void submit() { gpu_submit(); }
};

} // namespace gpu
