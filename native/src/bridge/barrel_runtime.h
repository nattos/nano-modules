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

#include <cstdint>
#include <memory>
#include <string>

namespace bridge {

// Monotonic count of barrel render frames produced (process-global, thread-safe).
// The BridgeServer pump reads it as a best-effort "a frame reached the display"
// proxy for strict-precision triggers: a strict trigger's emitting frame is
// rendered before the pump drains it, so once this advances past the value
// snapshotted at enqueue, ≥1 post-emit frame has been produced and handed to
// Resolume. There is no true present callback from Resolume/FFGL — this is the
// strongest signal available. Bumped on the render thread; read on the pump.
uint64_t barrelPresentSeq();

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
  // `in_tex`. The runtime owns the state doc, so it fetches this instance's
  // sketch + preview_requests itself (re-fetched only when `dirty`); `macros`
  // (n_macros floats) are injected into any control.barrel_macros instance and
  // published as macro_outputs. After the executor runs the runtime publishes
  // rail telemetry (sketch_state) and broadcasts requested preview frames over
  // the shared WS — all in-process, no extra ABI. Serialized across all
  // instances by the global render lock (process-global runtime/effrt/host state
  // + the single unlocked backend). Returns true if the output texture was
  // written, false if the sketch passed through (present the input instead).
  bool render(const std::string& key, void* in_tex, void* out_tex,
              int w, int h, double dt, double elapsed, bool dirty,
              const float* macros, int n_macros,
              double bar_phase = 0.0, double bpm = 120.0);

 private:
  BarrelRuntime();
  ~BarrelRuntime();
  BarrelRuntime(const BarrelRuntime&) = delete;
  BarrelRuntime& operator=(const BarrelRuntime&) = delete;

  struct Impl;            // Obj-C++ / engine members hidden from C++ callers.
  std::unique_ptr<Impl> impl_;
};

}  // namespace bridge
