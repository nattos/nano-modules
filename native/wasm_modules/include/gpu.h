#pragma once
/*
 * gpu.h — C++ wrappers for the gpu.* host API.
 *
 * Provides type-safe, D3D12-style resource handles and command encoding.
 * Thin wrappers over the raw C imports — zero overhead when optimized.
 *
 * Usage:
 *   auto device = gpu::Device::create();
 *   state::registerShaderSPV("my_cs", MY_CS_SPV, MY_CS_SPV_SIZE);
 *   auto shader = device.createShaderModuleByName("my_cs");
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
#include <initializer_list>

// Raw C imports (defined in each module's source, or via a shared import header)
extern "C" {
  __attribute__((import_module("gpu"), import_name("get_backend")))
  int gpu_get_backend(void);
  // Look up a shader by name (registered via state::registerShaderSPV).
  // The host knows how to translate the SPIR-V to the platform-native
  // shader source — effects don't have to carry WGSL/MSL strings.
  __attribute__((import_module("gpu"), import_name("create_shader_module_named")))
  int gpu_create_shader_module_named(const char* name, int name_len);
  __attribute__((import_module("gpu"), import_name("create_buffer")))
  int gpu_create_buffer(int size, int usage);
  __attribute__((import_module("gpu"), import_name("create_texture")))
  int gpu_create_texture(int w, int h, int format);
  __attribute__((import_module("gpu"), import_name("create_texture_mips")))
  int gpu_create_texture_mips(int w, int h, int format, int mip_count);
  __attribute__((import_module("gpu"), import_name("create_texture_3d")))
  int gpu_create_texture_3d(int w, int h, int d, int format);
  __attribute__((import_module("gpu"), import_name("create_sampler")))
  int gpu_create_sampler(int filter_mode, int address_mode);
  __attribute__((import_module("gpu"), import_name("create_compute_pso_layout")))
  int gpu_create_compute_pso_layout(int shader, const char* entry, int entry_len,
                                     int binding_count, const int* bindings);
  /// V2 of compute PSO creation: same as `create_compute_pso_layout`
  /// plus a packed buffer of pipeline-creation-time constants
  /// (specialization constant overrides). Constants buffer layout:
  ///   u32 count
  ///   per entry:
  ///     u32 name_len
  ///     <name_len bytes> name (UTF-8, no terminator)
  ///     f64 value
  /// Names match the `[[vk::constant_id(N)]]` declarations in HLSL,
  /// preserved through DXC → SPIR-V → naga → WGSL `@id(N) override`.
  __attribute__((import_module("gpu"), import_name("create_compute_pso_v2")))
  int gpu_create_compute_pso_v2(int shader, const char* entry, int entry_len,
                                 int binding_count, const int* bindings,
                                 const unsigned char* constants, int constants_len);
  __attribute__((import_module("gpu"), import_name("create_render_pso_layout")))
  int gpu_create_render_pso_layout(int vs_shader, const char* vs, int vs_len,
                                    int fs_shader, const char* fs, int fs_len, int format,
                                    int binding_count, const int* bindings);
  __attribute__((import_module("gpu"), import_name("create_instanced_render_pso_layout")))
  int gpu_create_instanced_render_pso_layout(int vs_shader, const char* vs, int vs_len,
                                              int fs_shader, const char* fs, int fs_len, int format,
                                              int binding_count, const int* bindings);
  __attribute__((import_module("gpu"), import_name("write_buffer")))
  void gpu_write_buffer(int buf, int offset, const void* data, int data_len);
  // GPU→CPU async readback. `request_readback` schedules an async copy of the
  // buffer's first `byte_len` bytes (call each frame); `poll_readback` copies the
  // latest COMPLETED snapshot into `dst` and returns bytes copied (0 = not ready
  // yet). Web latency is ~1-2 frames (mapAsync); native is CPU-coherent so polls
  // are satisfied almost immediately. Idempotent — repeated polls return the same
  // snapshot until a newer one completes.
  __attribute__((import_module("gpu"), import_name("request_readback")))
  void gpu_request_readback(int buf, int byte_len);
  __attribute__((import_module("gpu"), import_name("poll_readback")))
  int gpu_poll_readback(int buf, void* dst, int byte_len);
  __attribute__((import_module("gpu"), import_name("begin_compute_pass")))
  int gpu_begin_compute_pass(void);
  __attribute__((import_module("gpu"), import_name("compute_set_pso")))
  void gpu_compute_set_pso(int pass, int pso);
  __attribute__((import_module("gpu"), import_name("compute_set_buffer")))
  void gpu_compute_set_buffer(int pass, int buf, int offset, int slot);
  __attribute__((import_module("gpu"), import_name("compute_set_texture")))
  void gpu_compute_set_texture(int pass, int texture, int slot, int access);
  __attribute__((import_module("gpu"), import_name("compute_set_texture_mip")))
  void gpu_compute_set_texture_mip(int pass, int texture, int slot, int access, int mip_level);
  __attribute__((import_module("gpu"), import_name("compute_set_sampler")))
  void gpu_compute_set_sampler(int pass, int sampler, int slot);
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
  __attribute__((import_module("gpu"), import_name("create_instanced_render_pso")))
  int gpu_create_instanced_render_pso(int vs_shader, const char* vs, int vs_len,
                                       int fs_shader, const char* fs, int fs_len, int format);
  __attribute__((import_module("gpu"), import_name("render_set_buffer")))
  void gpu_render_set_buffer(int pass, int buf, int slot);
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
  // Concrete TextureFormat code of a live texture (never Surface/SketchDefault).
  __attribute__((import_module("gpu"), import_name("get_texture_format")))
  int gpu_get_texture_format(int handle);
  // The sketch's working format (what SketchDefault resolves to): RGBA8 or RGBA16F.
  __attribute__((import_module("gpu"), import_name("get_default_texture_format")))
  int gpu_get_default_texture_format(void);
  __attribute__((import_module("gpu"), import_name("texture_for_field")))
  int gpu_texture_for_field(const char* path, int path_len);
  __attribute__((import_module("gpu"), import_name("buffer_for_field")))
  int gpu_buffer_for_field(const char* path, int path_len);
  __attribute__((import_module("gpu"), import_name("clear_texture")))
  void gpu_clear_texture(int tex, float r, float g, float b, float a);
  __attribute__((import_module("gpu"), import_name("copy_texture")))
  void gpu_copy_texture(int src, int dst);
  __attribute__((import_module("gpu"), import_name("create_instanced_render_pso_mrt_layout")))
  int gpu_create_instanced_render_pso_mrt_layout(
      int vs_shader, const char* vs, int vs_len,
      int fs_shader, const char* fs, int fs_len,
      int target_count, const int* target_formats,
      int binding_count, const int* bindings);
  __attribute__((import_module("gpu"), import_name("begin_render_pass_mrt")))
  int gpu_begin_render_pass_mrt(int count, const int* tex_handles, const float* clear_values);
  // Instanced render pipeline factory variant that accepts a blend
  // mode int. 0 = standard alpha-over, 1 = additive
  // (src*src.a + dst). Anything else falls back to alpha-over.
  __attribute__((import_module("gpu"), import_name("create_instanced_render_pso_blend_layout")))
  int gpu_create_instanced_render_pso_blend_layout(
      int vs_shader, const char* vs, int vs_len,
      int fs_shader, const char* fs, int fs_len, int format,
      int binding_count, const int* bindings, int blend_mode);
  // Begin a render pass that LOADS the existing texture content
  // instead of clearing. Pair with a compute pre-fill that seeds the
  // target so the raster pass blends on top.
  __attribute__((import_module("gpu"), import_name("begin_render_pass_load")))
  int gpu_begin_render_pass_load(int texture);
}

namespace gpu {

// --- Enums ---

enum class Backend : int { Metal = 0, WebGPU = 1, None = -1 };

enum class BufferUsage : int { Vertex = 0, Storage = 1, Uniform = 2 };

/// Texture pixel format. The first three are the historical defaults;
/// the float formats unlock HDR / extended-precision intermediates
/// (bloom, glow, energy fields, accumulators — anything that needs
/// values >1.0 or sub-LSB precision). All float formats listed here are
/// usable as STORAGE textures from compute shaders in core WebGPU.
enum class TextureFormat : int {
  BGRA8   = 0,
  RGBA8   = 1,
  Surface = 2,
  RGBA16F = 3,  ///< 16-bit half-float per channel — recommended HDR format
  R32F    = 4,  ///< 32-bit float, single channel — high-precision data
  RGBA32F = 5,  ///< 32-bit float per channel — only when R16F isn't enough
  /// The sketch's configured working format (RGBA8 today; RGBA16F when the
  /// sketch opts into 16F output). Resolved host-side at creation/layout
  /// time. This is the DEFAULT for createTexture / storageTex2d so effect
  /// intermediates follow the sketch's precision automatically — pin an
  /// explicit format only where the effect genuinely requires it (R32F sim
  /// state, LUTs, byte-exact atlases).
  SketchDefault = 6,
  /// 8-bit sRGB-encoded (rgba8unorm-srgb). Sampling decodes to linear and
  /// render-target blending happens in LINEAR with encoded storage — 8-bit
  /// cost with fine dark-end precision. RENDER + SAMPLE ONLY: WebGPU forbids
  /// storage writes to sRGB formats, so never bind one as a storage texture
  /// (encode manually into a plain RGBA8 instead).
  RGBA8_SRGB = 7,
};

enum class FilterMode : int { Nearest = 0, Linear = 1 };

enum class AddressMode : int { ClampToEdge = 0, Repeat = 1, Mirror = 2 };

// How a compute pass binds a (storage) texture slot. Names the bare 0/1/2
// `access` ints at setTexture/setTextureMip; the int overloads stay for
// back-compat with existing call sites.
enum class TextureAccess : int { Read = 0, Write = 1, ReadWrite = 2 };

// --- Explicit bind group layouts ---
//
// By default the host derives bind group layouts from the shader via
// WebGPU's 'auto' layout. That works for one-shot effects with no
// conditional compilation, but it forces the C++ side to bind exactly
// the slots the shader currently parses — and silently breaks when
// they diverge (e.g. shader uses `#ifdef` to omit a binding the host
// still wants to provide; or naga prunes an unused binding the host
// still plans to bind).
//
// The fix: declare bindings up front in C++. The host builds an
// explicit layout matching the declaration, the pipeline is stamped
// with it, and bind groups at dispatch time are constructed against
// the same declaration in order. WebGPU only requires the shader's
// bindings to be a subset of the layout, so extras (slots reserved for
// future use, or slots elided by current `#ifdef` settings) are fine.
//
// Usage:
//
//   auto pso = gpu::Device::createComputePSO(cs_mod, "main", gpu::Bindings()
//     .tex2d(0)
//     .storageTex2d(1, gpu::TextureFormat::RGBA8)
//     .uniform(2)
//     .storage(3));

enum class BindingKind : int {
  Uniform           = 0,  // var<uniform>             — read-only constant buffer
  StorageRO         = 1,  // var<storage, read>       — read-only storage buffer
  StorageRW         = 2,  // var<storage, read_write> — writable storage buffer
  Sampler           = 3,
  Texture2D         = 4,  // texture_2d<f32>
  Texture3D         = 5,  // texture_3d<f32>
  Texture2DArray    = 6,  // texture_2d_array<f32>
  StorageTexture2D  = 7,  // texture_storage_2d<format, access>
  StorageTexture3D  = 8,  // texture_storage_3d<format, access>
};

struct BindingEntry {
  int slot;
  BindingKind kind;
  int format = 0;   // TextureFormat (storage textures only); ignored otherwise
  int access = 1;   // 0=read, 1=write, 2=read_write (storage textures only)
};

class Bindings {
public:
  static constexpr int MAX_ENTRIES = 16;

  Bindings& uniform(int slot)    { return push({slot, BindingKind::Uniform, 0, 0}); }
  Bindings& storage(int slot)    { return push({slot, BindingKind::StorageRO, 0, 0}); }
  Bindings& storageRW(int slot)  { return push({slot, BindingKind::StorageRW, 0, 0}); }
  Bindings& sampler(int slot)    { return push({slot, BindingKind::Sampler, 0, 0}); }
  /// Sampled texture. The optional format is a WEB-LAYOUT HINT only: WebGPU
  /// bind group layouts must declare `unfilterable-float` for 32-bit float
  /// formats (r32float / rgba32float), which also forbids linear-sampling
  /// them — read those with Load (or a manual tap lerp). Other formats (and
  /// Metal) ignore it.
  Bindings& tex2d(int slot, TextureFormat fmt = TextureFormat::BGRA8) {
    return push({slot, BindingKind::Texture2D, static_cast<int>(fmt), 0});
  }
  Bindings& tex3d(int slot)      { return push({slot, BindingKind::Texture3D, 0, 0}); }
  Bindings& tex2dArray(int slot) { return push({slot, BindingKind::Texture2DArray, 0, 0}); }

  /// Storage texture, write-only (the common case — output target).
  /// Defaults to the sketch's working format so bindings for tex_out /
  /// default-format internals track the sketch's precision; pin a format
  /// only when the bound texture's creation format is itself pinned.
  Bindings& storageTex2d(int slot, TextureFormat fmt = TextureFormat::SketchDefault) {
    return push({slot, BindingKind::StorageTexture2D, static_cast<int>(fmt), 1});
  }
  /// Storage texture, read-write (in-place RMW). Format must support
  /// read-write access in WebGPU core (r32float / r32sint / r32uint).
  Bindings& storageTex2dRW(int slot, TextureFormat fmt = TextureFormat::R32F) {
    return push({slot, BindingKind::StorageTexture2D, static_cast<int>(fmt), 2});
  }
  Bindings& storageTex3d(int slot, TextureFormat fmt = TextureFormat::RGBA8) {
    return push({slot, BindingKind::StorageTexture3D, static_cast<int>(fmt), 1});
  }
  Bindings& storageTex3dRW(int slot, TextureFormat fmt = TextureFormat::R32F) {
    return push({slot, BindingKind::StorageTexture3D, static_cast<int>(fmt), 2});
  }

  int count() const { return m_count; }
  const BindingEntry* data() const { return m_entries; }

private:
  Bindings& push(const BindingEntry& e) {
    if (m_count < MAX_ENTRIES) m_entries[m_count++] = e;
    return *this;
  }
  BindingEntry m_entries[MAX_ENTRIES];
  int m_count = 0;
};

namespace detail {
  /// Pack a Bindings into the wire format the host expects: one
  /// `int[4]` per entry — (slot, kind, format, access).
  inline int packBindings(const Bindings& b, int* out /* [Bindings::MAX_ENTRIES * 4] */) {
    int n = b.count();
    for (int i = 0; i < n; i++) {
      const auto& e = b.data()[i];
      out[i * 4 + 0] = e.slot;
      out[i * 4 + 1] = static_cast<int>(e.kind);
      out[i * 4 + 2] = e.format;
      out[i * 4 + 3] = e.access;
    }
    return n;
  }
}

// --- Pipeline-creation-time constants (specialization overrides) ---
//
// Effects declare overrides in HLSL via `[[vk::constant_id(N)]] const
// T NAME = default;`. DXC emits SPIR-V SpecId; naga preserves as
// `@id(N) override NAME: T = default;` in WGSL. The host fills the
// values per-PSO using the names supplied here, so swapping presets
// only re-creates the pipeline (no shader recompile, no naga round-
// trip — WebGPU specifically optimizes this path).
//
// Use case (motion blur quality settings):
//
//   auto pso = gpu::Device::createComputePSO(mod, "main", bindings,
//       gpu::Constants()
//         .set("TILE_SIZE", 24)
//         .set("NEIGHBOR_RADIUS", 2));
//
// Names must match the HLSL constant identifiers exactly. Values are
// stored as f64 on the wire and coerced by WebGPU to whatever the
// override's WGSL type happens to be (u32, i32, f32, bool).

class Constants {
public:
  static constexpr int MAX_ENTRIES = 8;
  static constexpr int MAX_NAME_LEN = 32;

  Constants& set(const char* name, double value) {
    if (m_count >= MAX_ENTRIES) return *this;
    int i = m_count++;
    int len = 0;
    while (name[len] != '\0' && len < MAX_NAME_LEN - 1) {
      m_entries[i].name[len] = name[len];
      len++;
    }
    m_entries[i].name[len] = '\0';
    m_entries[i].name_len = len;
    m_entries[i].value = value;
    return *this;
  }
  Constants& set(const char* name, int value)   { return set(name, double(value)); }
  Constants& set(const char* name, unsigned int value) { return set(name, double(value)); }
  Constants& set(const char* name, float value) { return set(name, double(value)); }
  Constants& set(const char* name, bool value)  { return set(name, value ? 1.0 : 0.0); }

  int count() const { return m_count; }
  bool empty() const { return m_count == 0; }

  /// Pack into the wire format the host expects:
  ///   u32 count
  ///   per entry: u32 name_len, <name_len bytes>, f64 value
  /// Returns total byte length written. `out` must be sized for the
  /// worst case (MAX_ENTRIES * (4 + MAX_NAME_LEN + 8) + 4 = 384B).
  int pack(unsigned char* out) const {
    auto write_u32 = [](unsigned char* p, unsigned int v) {
      p[0] = (v >>  0) & 0xff;
      p[1] = (v >>  8) & 0xff;
      p[2] = (v >> 16) & 0xff;
      p[3] = (v >> 24) & 0xff;
    };
    unsigned char* p = out;
    write_u32(p, (unsigned)m_count); p += 4;
    for (int i = 0; i < m_count; i++) {
      const auto& e = m_entries[i];
      write_u32(p, (unsigned)e.name_len); p += 4;
      for (int j = 0; j < e.name_len; j++) p[j] = (unsigned char)e.name[j];
      p += e.name_len;
      // f64 little-endian — wasm32 is LE so just copy.
      const unsigned char* vb = reinterpret_cast<const unsigned char*>(&e.value);
      for (int j = 0; j < 8; j++) p[j] = vb[j];
      p += 8;
    }
    return int(p - out);
  }

private:
  struct Entry {
    char name[MAX_NAME_LEN];
    int name_len = 0;
    double value = 0.0;
  };
  Entry m_entries[MAX_ENTRIES];
  int m_count = 0;
};

namespace detail {
  /// Maximum byte size of a packed Constants buffer.
  static constexpr int CONSTANTS_PACK_MAX =
      4 + Constants::MAX_ENTRIES *
          (4 + Constants::MAX_NAME_LEN + 8);
}

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

  // Async GPU→CPU readback (see gpu_request_readback / gpu_poll_readback).
  // Call requestReadback() each frame after the pass that writes this buffer;
  // pollReadback() copies the latest completed snapshot and returns bytes copied
  // (0 if none ready yet).
  void requestReadback(int byteCount) {
    gpu_request_readback(id, byteCount);
  }
  int pollReadback(void* dst, int byteCount) {
    return gpu_poll_readback(id, dst, byteCount);
  }
};

struct Texture : Handle {
  using Handle::Handle;
};

struct Sampler : Handle {
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

  // access: 0=read, 1=write, 2=read_write (prefer the TextureAccess overload).
  void setTexture(Texture tex, int slot, int access = 0) {
    gpu_compute_set_texture(id, tex.id, slot, access);
  }
  void setTexture(Texture tex, int slot, TextureAccess access) {
    gpu_compute_set_texture(id, tex.id, slot, (int)access);
  }

  /// Bind a specific mip level of a texture as the storage target at
  /// `slot`. Required for the destination of any pass that writes a
  /// single mip of a multi-mip texture (e.g., dual-filter blur). For
  /// single-mip textures pass `mip_level = 0`. The matching shader
  /// binding sees a `texture_storage_2d` view of just that mip.
  void setTextureMip(Texture tex, int slot, int access, int mip_level) {
    gpu_compute_set_texture_mip(id, tex.id, slot, access, mip_level);
  }
  void setTextureMip(Texture tex, int slot, TextureAccess access, int mip_level) {
    gpu_compute_set_texture_mip(id, tex.id, slot, (int)access, mip_level);
  }

  void setSampler(Sampler s, int slot) {
    gpu_compute_set_sampler(id, s.id, slot);
  }

  void dispatch(int x, int y = 1, int z = 1) {
    gpu_compute_dispatch(id, x, y, z);
  }

  void end() { gpu_end_compute_pass(id); }
};

// --- Render pass ---

/// One color-attachment binding for a multi-render-target render pass.
struct ColorAttachment {
  Texture texture;
  float r = 0;
  float g = 0;
  float b = 0;
  float a = 1;
};

struct RenderPass {
  int id;

  static RenderPass begin(Texture target, float r = 0, float g = 0, float b = 0, float a = 1) {
    return { gpu_begin_render_pass(target.id, r, g, b, a) };
  }

  /// Begin a render pass that LOADS the existing texture content.
  /// Used when an upstream compute pass has already populated the
  /// target and the raster pass should blend on top instead of
  /// clearing first.
  static RenderPass beginLoad(Texture target) {
    return { gpu_begin_render_pass_load(target.id) };
  }

  /// Begin a render pass with multiple color attachments (MRT). The
  /// matching pipeline must have been created via `Device::createInstancedRenderPSOMRT`
  /// with the same number/order of target formats. Up to 8 attachments
  /// (the WebGPU spec maxColorAttachments minimum guarantee).
  static RenderPass beginMRT(std::initializer_list<ColorAttachment> atts) {
    int n = static_cast<int>(atts.size());
    int tex[8];
    float clears[8 * 4];
    int i = 0;
    for (const auto& a : atts) {
      tex[i] = a.texture.id;
      clears[i * 4 + 0] = a.r;
      clears[i * 4 + 1] = a.g;
      clears[i * 4 + 2] = a.b;
      clears[i * 4 + 3] = a.a;
      i++;
    }
    return { gpu_begin_render_pass_mrt(n, tex, clears) };
  }

  void setPSO(RenderPSO pso) { gpu_render_set_pso(id, pso.id); }

  void setVertexBuffer(Buffer buf, int slot = 0, int offset = 0) {
    gpu_render_set_vertex_buffer(id, buf.id, offset, slot);
  }

  /// Bind a buffer (storage or uniform) to the render pipeline's bind
  /// group at `slot`. Supports vertex-shader instancing via storage
  /// buffer reads (no vertex buffer required).
  void setBuffer(Buffer buf, int slot) {
    gpu_render_set_buffer(id, buf.id, slot);
  }

  void draw(int vertexCount, int instanceCount = 1) {
    gpu_render_draw(id, vertexCount, instanceCount);
  }

  void end() { gpu_end_render_pass(id); }
};

// --- Device (factory + submit) ---

struct Device {
  static Backend backend() { return static_cast<Backend>(gpu_get_backend()); }

  /// Look up a shader by name. The host owns the SPIR-V → platform
  /// translation (WGSL on the web, MSL on native Metal); the effect
  /// just references the name it registered earlier.
  static ShaderModule createShaderModuleByName(const char* name) {
    return ShaderModule(gpu_create_shader_module_named(name, std::strlen(name)));
  }

  static Buffer createBuffer(int size, BufferUsage usage) {
    return Buffer(gpu_create_buffer(size, static_cast<int>(usage)));
  }

  /// Default format is the sketch's working format (8-bit today, 16F when
  /// the sketch opts in) — intermediates inherit the sketch's precision
  /// unless the effect pins one explicitly.
  static Texture createTexture(int w, int h, TextureFormat format = TextureFormat::SketchDefault) {
    return Texture(gpu_create_texture(w, h, static_cast<int>(format)));
  }

  /// Texture allocated with a mip chain. mip 0 is `(w, h)`; each
  /// subsequent mip halves both dimensions (clamped to ≥1). Useful
  /// for dual-filter blur, generated detail levels, anything that
  /// needs LOD-resolved sampling. Mip data is *not* generated
  /// automatically — fill each level via compute writes (use
  /// `ComputePass::setTextureMip` to bind a specific mip as the
  /// storage write target) and read at any LOD via WGSL
  /// `textureSampleLevel(tex, samp, uv, lod)`.
  static Texture createTextureWithMips(int w, int h, int mip_count,
                                        TextureFormat format = TextureFormat::SketchDefault) {
    return Texture(gpu_create_texture_mips(w, h, static_cast<int>(format), mip_count));
  }

  /// 3D texture (texture_3d / texture_storage_3d in WGSL). Useful for
  /// color LUTs (16³–32³ rgba8 cube), particle/density volumes, anything
  /// with three-axis sampling. The format choices match createTexture.
  static Texture createTexture3D(int w, int h, int d,
                                  TextureFormat format = TextureFormat::RGBA8) {
    return Texture(gpu_create_texture_3d(w, h, d, static_cast<int>(format)));
  }

  static Sampler createSampler(FilterMode filter = FilterMode::Linear,
                                AddressMode address = AddressMode::ClampToEdge) {
    return Sampler(gpu_create_sampler(static_cast<int>(filter), static_cast<int>(address)));
  }

  /// Compute PSO with an explicit bind group layout. The `bindings`
  /// describe what the host *binds* — not what the shader currently
  /// declares — so this stays correct under `#ifdef`s, naga pruning
  /// unused bindings, and shaders shared between PSOs that bind
  /// different subsets. WebGPU only requires the shader's actual
  /// bindings to be a subset of the layout, so extras are fine.
  ///
  /// Pass an empty `Bindings()` for shaders that take no bind group
  /// (rare for compute, but valid).
  static ComputePSO createComputePSO(ShaderModule shader, const char* entryPoint,
                                      const Bindings& bindings) {
    int packed[Bindings::MAX_ENTRIES * 4];
    int n = detail::packBindings(bindings, packed);
    return ComputePSO(gpu_create_compute_pso_layout(
        shader.id, entryPoint, std::strlen(entryPoint), n, packed));
  }

  /// Compute PSO with pipeline-creation-time specialization constants.
  /// `constants` map names → values; names must match the HLSL
  /// `[[vk::constant_id(N)]]` declarations the SPV was built with.
  /// Recreating a PSO with different constants is the recommended way
  /// to swap quality presets — it skips the WGSL re-translation entirely
  /// (only the pipeline object is rebuilt). Pass an empty `Constants{}`
  /// to use shader-declared defaults.
  static ComputePSO createComputePSO(ShaderModule shader, const char* entryPoint,
                                      const Bindings& bindings,
                                      const Constants& constants) {
    int packed_bindings[Bindings::MAX_ENTRIES * 4];
    int bn = detail::packBindings(bindings, packed_bindings);
    unsigned char packed_consts[detail::CONSTANTS_PACK_MAX];
    int cn = constants.pack(packed_consts);
    return ComputePSO(gpu_create_compute_pso_v2(
        shader.id, entryPoint, std::strlen(entryPoint),
        bn, packed_bindings, packed_consts, cn));
  }

  /// Render pipeline with the standard float2-pos + float4-color
  /// vertex buffer layout. Bindings (visible to vertex+fragment) are
  /// declared explicitly — pass `Bindings()` for shaders that read
  /// nothing from a bind group (vertex-buffer-only effects).
  static RenderPSO createRenderPSO(ShaderModule vs, const char* vsEntry,
                                    ShaderModule fs, const char* fsEntry,
                                    TextureFormat format,
                                    const Bindings& bindings) {
    int packed[Bindings::MAX_ENTRIES * 4];
    int n = detail::packBindings(bindings, packed);
    return RenderPSO(gpu_create_render_pso_layout(
        vs.id, vsEntry, std::strlen(vsEntry),
        fs.id, fsEntry, std::strlen(fsEntry),
        static_cast<int>(format), n, packed));
  }

  /// Vertex-buffer-free render pipeline (the vertex shader uses
  /// vertex_index / instance_index, possibly with a storage buffer of
  /// per-instance data bound via a slot in `bindings`). Bindings are
  /// declared explicitly for vertex+fragment visibility.
  static RenderPSO createInstancedRenderPSO(
      ShaderModule vs, const char* vsEntry,
      ShaderModule fs, const char* fsEntry,
      TextureFormat format,
      const Bindings& bindings) {
    int packed[Bindings::MAX_ENTRIES * 4];
    int n = detail::packBindings(bindings, packed);
    return RenderPSO(gpu_create_instanced_render_pso_layout(
        vs.id, vsEntry, std::strlen(vsEntry),
        fs.id, fsEntry, std::strlen(fsEntry),
        static_cast<int>(format), n, packed));
  }

  /// Color blend equation for `createInstancedRenderPSO`. Picked at
  /// pipeline-creation time and stamped into the WebGPU pipeline state
  /// — switching at runtime requires a different PSO.
  enum class BlendMode : int {
    AlphaOver = 0,  ///< src*src.a + dst*(1 - src.a). Default.
    Additive  = 1,  ///< src*src.a + dst. Particles accumulate.
    Replace   = 2,  ///< No blending: the fragment output overwrites dst.
  };

  /// Same as the bindings-only `createInstancedRenderPSO` overload, but
  /// lets the caller pick the blend equation. Particle-style effects
  /// often want both alpha-over and additive variants of the same
  /// shader and create one PSO of each.
  static RenderPSO createInstancedRenderPSO(
      ShaderModule vs, const char* vsEntry,
      ShaderModule fs, const char* fsEntry,
      TextureFormat format,
      const Bindings& bindings,
      BlendMode blendMode) {
    int packed[Bindings::MAX_ENTRIES * 4];
    int n = detail::packBindings(bindings, packed);
    return RenderPSO(gpu_create_instanced_render_pso_blend_layout(
        vs.id, vsEntry, std::strlen(vsEntry),
        fs.id, fsEntry, std::strlen(fsEntry),
        static_cast<int>(format), n, packed,
        static_cast<int>(blendMode)));
  }

  /// Multi-render-target render pipeline. Fragment outputs at
  /// `@location(i)` write to target i; `formats` declares each target
  /// format. Bindings (visible to vertex+fragment) are explicit; pass
  /// `Bindings()` for MRT shaders with no bind group.
  static RenderPSO createInstancedRenderPSOMRT(
      ShaderModule vs, const char* vsEntry,
      ShaderModule fs, const char* fsEntry,
      std::initializer_list<TextureFormat> formats,
      const Bindings& bindings) {
    int n = static_cast<int>(formats.size());
    int fmts[8];
    int i = 0;
    for (auto f : formats) fmts[i++] = static_cast<int>(f);
    int packed[Bindings::MAX_ENTRIES * 4];
    int bn = detail::packBindings(bindings, packed);
    return RenderPSO(gpu_create_instanced_render_pso_mrt_layout(
        vs.id, vsEntry, std::strlen(vsEntry),
        fs.id, fsEntry, std::strlen(fsEntry),
        n, fmts, bn, packed));
  }

  /// Get texture handle for a named field path (unified texture access).
  static Texture textureForField(const char* fieldPath) {
    return Texture(gpu_texture_for_field(fieldPath, std::strlen(fieldPath)));
  }

  /// Resolve a GPU buffer handle stored in state at `fieldPath`. Returns
  /// an invalid Buffer if the field is unassigned (handle == 0).
  /// Counterpart to state::setGpuBuffer on the producer side.
  static Buffer bufferForField(const char* fieldPath) {
    return Buffer(gpu_buffer_for_field(fieldPath, std::strlen(fieldPath)));
  }

  // Legacy — kept during migration
  static Texture inputTexture(int index) { return Texture(gpu_get_input_texture(index)); }
  static int inputTextureCount() { return gpu_get_input_texture_count(); }
  static Texture renderTarget() { return Texture(gpu_get_render_target()); }
  static int renderTargetWidth() { return gpu_get_render_target_width(); }
  static int renderTargetHeight() { return gpu_get_render_target_height(); }

  // --- Format queries ---
  // Effects that allocate internals matching their input/output (or that
  // branch on precision) read these instead of assuming RGBA8.

  /// Concrete format of a live texture (never Surface/SketchDefault).
  static TextureFormat textureFormat(Texture t) {
    return static_cast<TextureFormat>(gpu_get_texture_format(t.id));
  }
  /// What SketchDefault resolves to for this sketch: RGBA8 or RGBA16F.
  static TextureFormat defaultTextureFormat() {
    return static_cast<TextureFormat>(gpu_get_default_texture_format());
  }
  /// Format of input texture `index` (invalid input → RGBA8).
  static TextureFormat inputTextureFormat(int index) {
    return static_cast<TextureFormat>(gpu_get_texture_format(gpu_get_input_texture(index)));
  }
  /// Format of the currently bound render target (tex_out).
  static TextureFormat renderTargetFormat() {
    return static_cast<TextureFormat>(gpu_get_texture_format(gpu_get_render_target()));
  }

  static void submit() { gpu_submit(); }

  /// Clear a texture to a constant color. Implemented as a 1-pixel render
  /// pass with `loadOp: clear`, so `texture` must be a renderable format
  /// (rgba8unorm / bgra8unorm / rgba16float). For r32float / rgba32float,
  /// dispatch a compute shader that writes the constant — there is no
  /// portable WebGPU clear for non-renderable formats.
  static void clear(Texture texture, float r, float g, float b, float a = 1.0f) {
    gpu_clear_texture(texture.id, r, g, b, a);
  }

  /// 1:1 copy between two textures of identical format and size. Both
  /// textures carry COPY_SRC and COPY_DST usage: `createTexture` textures,
  /// and the executor's field textures (tex_in / tex_out, render targets)
  /// all allocate the superset, so a stage can copy(in, out) to skip a
  /// passthrough dispatch. Also useful for ping-pong "rebroadcast" without
  /// re-running a compute shader. (Native blits regardless of usage; the
  /// superset is what satisfies WebGPU's strict copy validation.)
  static void copy(Texture src, Texture dst) {
    gpu_copy_texture(src.id, dst.id);
  }
};

} // namespace gpu
