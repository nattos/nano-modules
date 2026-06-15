#pragma once
// effect_host_sink.h — the executor-facing slice of the effect host API.
//
// A WASM effect's lifecycle makes host calls that the SketchExecutor later
// reads back off the instance: it publishes its schema, registers shaders,
// reads/writes named texture/buffer fields, queries connection state, and
// checks whether it will render. For statically-linked effects those calls
// land directly on effect_runtime::EffectInstance (via host_impls.cpp). For
// WASM effects the calls arrive in host_functions.cpp and must reach the SAME
// instance so the executor's view stays uniform.
//
// This abstract sink is that bridge. It has NO dependencies, so wasm_host /
// host_functions can call through it (via WasmContext.effect_instance) without
// taking a dependency on the runtime — avoiding a wasm <-> runtime include
// cycle. effect_runtime::EffectInstance implements it.

#include <string>
#include <string_view>

namespace gpu { class GPUBackend; }

namespace wasm {

class EffectHostSink {
 public:
  virtual ~EffectHostSink() = default;

  // Type-level metadata + schema (published from module_init).
  virtual void hostSetMetadata(std::string id, std::string version) = 0;
  virtual void hostSetSchema(std::string schemaJson) = 0;

  // SPV shader registration (resolved later by createShaderModuleByName).
  virtual void hostRegisterShaderSpv(std::string_view name,
                                     const unsigned char* spv, int spv_len,
                                     std::string_view format,
                                     std::string_view access) = 0;

  // Compile a previously-registered SPV shader (by name) into a backend shader
  // module, returning its handle (-1 on failure). The runtime owns the SPV and
  // the SPV→MSL translation; for WASM effects this replaces the build-time
  // pre-baked MSL that gpu::Device::createShaderModuleByName uses natively.
  virtual int createShaderModuleByName(const std::string& name,
                                       gpu::GPUBackend* backend) = 0;

  // Named texture/buffer field wiring. The executor sets inputs before render;
  // the effect reads them via gpu.texture_for_field / buffer_for_field and
  // publishes outputs via state.set_gpu_texture / set_gpu_buffer.
  virtual int textureField(const std::string& path) const = 0;
  virtual void setTextureField(const std::string& path, int handle) = 0;
  virtual int bufferField(const std::string& path) const = 0;
  virtual void setBufferField(const std::string& path, int handle) = 0;

  // Connection + render-skip introspection (state.is_field_connected /
  // will_render).
  virtual bool isInputConnected(const std::string& path) const = 0;
  virtual bool isOutputConnected(const std::string& path) const = 0;
  virtual bool willRender() const = 0;
};

}  // namespace wasm
