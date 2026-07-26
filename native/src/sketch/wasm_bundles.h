#pragma once
// wasm_bundles.h — load effect .wasm bundles into a ModuleRegistry.
//
// The barrel-loads-WASM replacement for the statically-generated
// nano_barrel_gen::registerAllBarrelEffects. Owns the WasmHost that keeps the
// loaded modules alive (effects call_indirect into them every frame), loads
// each bundle, runs its nano_module_main, and registers every effect it
// declares via ModuleRegistry::registerWasmBundle.

#include <cstdint>
#include <string>
#include <vector>

#include "bridge/param_cache.h"
#include "wasm/wasm_host.h"

namespace gpu { class GPUBackend; }
namespace bridge { class StateDocument; }

namespace sketch_executor {

class ModuleRegistry;

class WasmEffectBundles {
 public:
  WasmEffectBundles();

  // Initialize the WAMR runtime. Must succeed before loading bundles.
  bool init();
  bool initialized() const { return initialized_; }

  // Load an effect bundle from bytecode and register every effect it declares
  // into `registry`. `gpu`/`stateDoc` are attached to the module so an effect's
  // module_init can compile its shaders and publish its schema (both may be
  // null — schema still publishes; GPU effects skip shader compile). Returns
  // the number of effects registered (0 on any failure / no nano_module_main).
  int loadBundle(const uint8_t* bytecode, uint32_t len, ModuleRegistry& registry,
                 gpu::GPUBackend* gpu, bridge::StateDocument* stateDoc);

  // Same, reading the bundle from a file path. Returns 0 if unreadable.
  int loadBundleFile(const std::string& path, ModuleRegistry& registry,
                     gpu::GPUBackend* gpu, bridge::StateDocument* stateDoc);

  wasm::WasmHost& host() { return host_; }

  // Publish the host frame clock (elapsed/dt/beat/viewport) to every loaded
  // bundle's `host.*` imports — host::barPhase()/bpm()/time() etc. Effects that
  // beat-sync (control.nanolooper) read barPhase from here; without this call it
  // stays 0 (the loaded modules have no per-frame FrameState otherwise). Call
  // once per frame before SketchExecutor::execute; the render lock serializes it.
  // `referenceH` is the output height the viewport STANDS IN FOR when the engine
  // renders a scaled proxy of a larger composition (host::pxScale keeps effects'
  // pixel-denominated params a fixed fraction of the frame across sizes). 0 =
  // "the viewport IS the output", the native default.
  void setHostClock(double elapsedTime, double deltaTime, double barPhase,
                    double bpm, int viewportW, int viewportH, int referenceH = 0);

  // Publish the seekable-streams registry (+ its warp clock) to every loaded
  // bundle's streams.* imports. A pointer store — the comp executor mutates the
  // table/clock in place; call again only when the executor is recreated.
  // Applied automatically to bundles loaded afterwards. Null = comp inactive
  // (the imports answer as the session-clock-only world).
  void setStreamsTable(comp::StreamsTable* table, const comp::WarpClock* clock);

 private:
  bridge::ParamCache cache_;  // declared before host_ (host_ binds to it)
  wasm::WasmHost host_;
  // One frame clock shared by all bundles. Its address is registered with each
  // module at load; setHostClock mutates it in place (no re-registration).
  wasm::FrameState frame_state_{};
  comp::StreamsTable* streams_table_ = nullptr;
  const comp::WarpClock* streams_clock_ = nullptr;
  std::vector<int32_t> module_ids_;
  bool initialized_ = false;
};

}  // namespace sketch_executor
