#include "sketch/wasm_bundles.h"

#include <fstream>
#include <string>
#include <vector>

#include "sketch/module_registry.h"

namespace sketch_executor {

// text_host_wasm.cpp — registers the "text" WAMR namespace so text.wasm /
// richtext.wasm resolve their text.* imports to the native TextEngine service.
bool registerTextHostFunctions();

namespace {
// Optional per-arch AOT sidecar. Given a bundle's `<base>.wasm` path, return the
// `<base>-<arch>.aot` next to it when AOT loading is compiled in AND that file
// exists — it runs at ~native speed. Otherwise return the original `.wasm` (the
// portable fallback, the only artifact a bundle must ship). The arch is the
// compile-time target, so a universal binary's two slices each pick correctly.
// WAMR auto-detects the module format from the bytes, so the caller just reads
// whichever path this returns.
std::string preferredBundlePath(const std::string& wasmPath) {
#ifdef NANO_WASM_AOT_ENABLED
#if defined(__aarch64__)
  const char* arch = "aarch64";
#elif defined(__x86_64__)
  const char* arch = "x86_64";
#else
  const char* arch = nullptr;
#endif
  if (arch) {
    std::string base = wasmPath;
    const std::string ext = ".wasm";
    if (base.size() > ext.size() &&
        base.compare(base.size() - ext.size(), ext.size(), ext) == 0)
      base.resize(base.size() - ext.size());
    std::string aot = base + "-" + arch + ".aot";
    if (std::ifstream(aot, std::ios::binary).good()) return aot;
  }
#endif
  return wasmPath;
}
}  // namespace

WasmEffectBundles::WasmEffectBundles() : host_(cache_) {}

bool WasmEffectBundles::init() {
  initialized_ = host_.init();
  // Register the "text" namespace once the WAMR runtime is up (host_.init
  // refcounts wasm_runtime_full_init). Bundles that import text.* (text.wasm /
  // richtext.wasm) need this before they instantiate; effect-only bundles ignore
  // it. Idempotent + process-global, mirroring the effrt/gpu native tables.
  if (initialized_) registerTextHostFunctions();
  return initialized_;
}

int WasmEffectBundles::loadBundle(const uint8_t* bytecode, uint32_t len,
                                  ModuleRegistry& registry, gpu::GPUBackend* gpu,
                                  bridge::StateDocument* stateDoc) {
  if (!initialized_ || !bytecode || len == 0) return 0;

  int32_t id = host_.load_module(bytecode, len);
  if (id < 0) return 0;

  // Attach per-module host services before nano_module_main / module_init runs:
  // the GPU backend (shader compile) and the state doc (schema publish to the
  // editor bridge). Both optional.
  if (gpu) host_.set_gpu_backend(id, gpu);
  if (stateDoc) host_.set_state_doc(id, stateDoc);

  // Read the bundle's host<->effect ABI version BEFORE nano_module_main so
  // each captured effect can carry it as a coarse compatibility signal
  // (0 = legacy bundle without the export).
  host_.query_abi_version(id);

  // Point this module's host.* timing imports at our shared frame clock. The
  // address is stable (a member); setHostClock mutates the struct in place, so
  // this one registration keeps working every frame.
  host_.set_frame_state(id, &frame_state_);
  if (streams_table_) host_.set_streams_table(id, streams_table_, streams_clock_);
  module_ids_.push_back(id);

  // Bundles register their effects from nano_module_main. A non-effect module
  // (no such export) fails here and contributes nothing.
  if (host_.call_function(id, "nano_module_main") != 0) return 0;

  return registry.registerWasmBundle(host_, id);
}

void WasmEffectBundles::setStreamsTable(const comp::StreamsTable* table,
                                        const comp::WarpClock* clock) {
  streams_table_ = table;
  streams_clock_ = clock;
  for (const int32_t id : module_ids_) host_.set_streams_table(id, table, clock);
}

void WasmEffectBundles::setHostClock(double elapsedTime, double deltaTime,
                                     double barPhase, double bpm,
                                     int viewportW, int viewportH) {
  frame_state_.elapsed_time = elapsedTime;
  frame_state_.delta_time = deltaTime;
  frame_state_.bar_phase = barPhase;
  frame_state_.bpm = bpm;
  frame_state_.viewport_w = viewportW;
  frame_state_.viewport_h = viewportH;
}

int WasmEffectBundles::loadBundleFile(const std::string& path,
                                      ModuleRegistry& registry,
                                      gpu::GPUBackend* gpu,
                                      bridge::StateDocument* stateDoc) {
  std::ifstream f(preferredBundlePath(path), std::ios::binary | std::ios::ate);
  if (!f) return 0;
  auto size = f.tellg();
  if (size <= 0) return 0;
  std::vector<uint8_t> buf(static_cast<size_t>(size));
  f.seekg(0);
  if (!f.read(reinterpret_cast<char*>(buf.data()), size)) return 0;
  return loadBundle(buf.data(), static_cast<uint32_t>(buf.size()), registry,
                    gpu, stateDoc);
}

}  // namespace sketch_executor
