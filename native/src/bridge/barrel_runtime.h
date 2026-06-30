#pragma once

// BarrelRuntime — the process-singleton shared effect runtime that lives inside
// libbridge_server.dylib. ONE Metal backend + WAMR/WasmHost + loaded effect
// bundles + EffectRuntime + ModuleRegistry, shared across every NanoBarrel FFGL
// instance in the process. Each instance gets a per-key SketchExecutor that
// renders through this shared runtime under a global render lock; per-instance
// effect state is isolated by namespacing the executor's instance keys with the
// barrel's stable UUID (see SketchExecutor::setKeyNamespace).
//
// Why a singleton in the dylib: the effect runtime relies on process-global
// state (effect_runtime's g_runtime, the effrt frame table, the host time
// globals, the WAMR runtime). Those are per-linked-image, so exactly ONE image
// may link the engine — the dylib. The barrel bundle links none of it and
// drives rendering purely through the C ABI (bridge_api.h).

#include <memory>
#include <string>

namespace bridge {

class BarrelRuntime {
 public:
  static BarrelRuntime& instance();

  // Build (on first call) + refcount. `wasm_dir` is the directory holding the
  // effect .wasm bundles (the barrel's Contents/Resources/wasm), `font_path`
  // the default.ttf for text effects. Returns true if the runtime is usable.
  // Subsequent acquires reuse the already-built runtime (paths ignored).
  bool acquire(const std::string& wasm_dir, const std::string& font_path);
  void release();

  // The shared MTLDevice (as void* / id<MTLDevice>) for the barrel to build its
  // InteropTexture pair against — must match the backend's device.
  void* metalDevice();

  // The effect schema catalog as a JSON object string
  // ({ module_type: {key,id,version,schema} }), for the barrel to publish into
  // its bridge state so the editor populates its inspector + insert chips.
  std::string schemasJson();

  // Per-barrel executor lifecycle, keyed by the barrel's plugin key (UUID).
  void createExecutor(const std::string& key);
  void destroyExecutor(const std::string& key);

  // Render one frame for `key` into `out_tex` (id<MTLTexture>), reading from
  // `in_tex`. `sketch_json` is this instance's sketch; when `dirty` is false a
  // cached parse is reused. Serialized across all instances by the global
  // render lock (process-global runtime/effrt/host state + unlocked backend).
  void render(const std::string& key, void* in_tex, void* out_tex,
              int w, int h, double dt, double elapsed,
              const std::string& sketch_json, bool dirty);

 private:
  BarrelRuntime();
  ~BarrelRuntime();
  BarrelRuntime(const BarrelRuntime&) = delete;
  BarrelRuntime& operator=(const BarrelRuntime&) = delete;

  struct Impl;            // Obj-C++ / engine members hidden from C++ callers.
  std::unique_ptr<Impl> impl_;
};

}  // namespace bridge
