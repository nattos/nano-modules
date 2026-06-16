// wasm_executor_driver.cpp — see wasm_executor_driver.h.
//
// Mirrors the marshalling the FFGL barrel did inline (setupWasmExecutor /
// executeViaWasm), extracted so the barrel and the benchmark share ONE copy.

#include "sketch/wasm_executor_driver.h"

#include <cstring>
#include <fstream>
#include <vector>

#include "bridge/param_cache.h"
#include "sketch/executor_host.h"
#include "wasm/wasm_host.h"

namespace sketch_executor {

// Defined in effrt_impls.cpp (no public header; the barrel forward-declares it
// the same way). Rebinds effrt's process-global runtime pointer + clears the
// frame-local instance handle table.
void effrtSetRuntime(effect_runtime::EffectRuntime* rt);

namespace {
std::vector<uint8_t> readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg();
  f.seekg(0);
  std::vector<uint8_t> bytes(static_cast<size_t>(size));
  f.read(reinterpret_cast<char*>(bytes.data()), size);
  return bytes;
}
}  // namespace

WasmExecutorDriver::WasmExecutorDriver() = default;

WasmExecutorDriver::~WasmExecutorDriver() {
  if (host_ && module_ >= 0 && ptr_) {
    uint32_t d[1] = {ptr_};
    host_->call_export_v(module_, "executor_destroy", 1, d);
  }
}

bool WasmExecutorDriver::init(
    const std::string& wasmDir,
    effect_runtime::EffectRuntime* rt,
    gpu::GPUBackend* gpu,
    const std::unordered_map<std::string, nlohmann::json>& schemas) {
  if (!rt || !gpu) return false;

  std::string base = wasmDir;
  if (!base.empty() && base.back() != '/') base += '/';

  // Prefer an AOT-compiled module (no interpreter) when one was produced at
  // build (wamrc → executor.aot). Falls back to the portable .wasm.
  std::vector<uint8_t> bytes = readFile(base + "executor.aot");
  usingAot_ = !bytes.empty();
  if (bytes.empty()) bytes = readFile(base + "executor.wasm");
  if (bytes.empty()) return false;

  // WasmHost::init() initialises the WAMR runtime (refcounted; first host wins)
  // and registers the gpu/state/val/io/... imports the executor needs. It MUST
  // run before registerEffrtHostFunctions() — wasm_runtime_register_natives
  // allocates from the runtime, which doesn't exist until init. (In the barrel
  // the effect-bundles host inits the runtime first; the benchmark's in-process
  // path has no prior host, so the driver must init it here.)
  paramCache_ = std::make_unique<bridge::ParamCache>();
  host_ = std::make_unique<wasm::WasmHost>(*paramCache_);
  if (!host_->init()) { host_.reset(); return false; }

  // effrt + trace imports are process-global; register once (idempotent).
  if (!registerEffrtHostFunctions()) { host_.reset(); return false; }

  module_ = host_->load_module(bytes.data(), static_cast<uint32_t>(bytes.size()));
  if (module_ < 0) { host_.reset(); return false; }
  host_->set_gpu_backend(module_, gpu);

  uint32_t argv[16] = {0};
  if (!host_->call_export_v(module_, "executor_create", 0, argv) || !argv[0]) {
    host_.reset();
    return false;
  }
  ptr_ = argv[0];

  // Push every effect's schema (the executor walks these for wire routing).
  for (const auto& kv : schemas) {
    const std::string& mt = kv.first;
    std::string schema = kv.second.dump();
    uint32_t mtOff = push(mt.data(), mt.size());
    uint32_t scOff = push(schema.data(), schema.size());
    uint32_t a[5] = {ptr_, mtOff, static_cast<uint32_t>(mt.size()),
                     scOff, static_cast<uint32_t>(schema.size())};
    host_->call_export_v(module_, "executor_register_schema", 5, a);
    host_->app_free(module_, mtOff);
    host_->app_free(module_, scOff);
  }

  valid_ = true;
  return true;
}

uint32_t WasmExecutorDriver::push(const void* data, size_t len) {
  void* native = nullptr;
  uint32_t off = host_->app_malloc(module_, static_cast<uint32_t>(len), &native);
  if (off && native && len) std::memcpy(native, data, len);
  return off;
}

int32_t WasmExecutorDriver::execute(
    effect_runtime::EffectRuntime* rt, const std::string& sketchJson,
    int32_t inHandle, int32_t outHandle, int W, int H, double dt, bool dirty) {
  if (!valid_) return inHandle;
  effrtSetRuntime(rt);

  // Reuse one linear-memory buffer for the sketch JSON; grow on demand.
  size_t len = sketchJson.size();
  if (len + 1 > sketchCap_) {
    if (sketchOff_) {
      host_->app_free(module_, sketchOff_);
      sketchOff_ = 0;
      sketchCap_ = 0;
    }
    void* native = nullptr;
    sketchOff_ = host_->app_malloc(module_, static_cast<uint32_t>(len + 1), &native);
    sketchCap_ = sketchOff_ ? static_cast<uint32_t>(len + 1) : 0;
  }
  if (!sketchOff_) return inHandle;
  void* native = host_->app_to_native(module_, sketchOff_, static_cast<uint32_t>(len));
  if (!native) return inHandle;
  std::memcpy(native, sketchJson.data(), len);

  uint32_t a[10] = {0};
  a[0] = ptr_;
  a[1] = sketchOff_;
  a[2] = static_cast<uint32_t>(len);
  a[3] = static_cast<uint32_t>(inHandle);
  a[4] = static_cast<uint32_t>(outHandle);
  a[5] = static_cast<uint32_t>(W);
  a[6] = static_cast<uint32_t>(H);
  std::memcpy(&a[7], &dt, sizeof(double));  // f64 dt occupies a[7..8]
  a[9] = dirty ? 1u : 0u;
  if (!host_->call_export_v(module_, "executor_execute", 10, a)) return inHandle;
  return static_cast<int32_t>(a[0]);
}

}  // namespace sketch_executor
