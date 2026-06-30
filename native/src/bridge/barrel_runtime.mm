#include "bridge/barrel_runtime.h"

#import <Metal/Metal.h>

#include <cstdio>
#include <mutex>
#include <unordered_map>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

// Host frame-state setters live in effect_runtime (host_impls.cpp); forward
// declare to avoid pulling a heavier header (mirrors nano_barrel_plugin.mm).
namespace effect_runtime {
void setHostTime(double t);
void setHostDeltaTime(double dt);
void setHostViewport(int w, int h);
void textInstallDefaultFonts(const char* primaryTtfPath);
}  // namespace effect_runtime

namespace bridge {

namespace {
constexpr const char* kBundleNames[] = {"core", "lights", "nano", "text", "richtext"};

#define BRT_LOG(fmt, ...) \
  std::fprintf(stderr, "[barrel_runtime] " fmt "\n", ##__VA_ARGS__)
}  // namespace

struct BarrelRuntime::Impl {
  std::mutex lifecycle_mu;          // guards build/teardown + refcount + table
  std::mutex render_mu;             // global render serializer
  int refcount = 0;
  bool built = false;
  bool usable = false;

  id<MTLDevice> device = nil;
  std::unique_ptr<gpu::GPUBackend> gpu;
  // bundles_ owns the WasmHost; declared before rt so it is destroyed AFTER rt
  // (EffectInstance dtors call_indirect into the WasmHost).
  std::unique_ptr<sketch_executor::WasmEffectBundles> bundles;
  std::unique_ptr<effect_runtime::EffectRuntime> rt;
  std::unique_ptr<sketch_executor::ModuleRegistry> registry;

  struct PerExecutor {
    std::unique_ptr<sketch_executor::SketchExecutor> executor;
    nlohmann::json sketch;          // cached parse, updated on dirty frames
    bool haveSketch = false;
  };
  std::unordered_map<std::string, PerExecutor> executors;
};

BarrelRuntime& BarrelRuntime::instance() {
  static BarrelRuntime inst;
  return inst;
}

BarrelRuntime::BarrelRuntime() : impl_(std::make_unique<Impl>()) {}
BarrelRuntime::~BarrelRuntime() = default;

bool BarrelRuntime::acquire(const std::string& wasm_dir, const std::string& font_path) {
  std::lock_guard<std::mutex> lk(impl_->lifecycle_mu);
  ++impl_->refcount;
  if (impl_->built) return impl_->usable;
  impl_->built = true;

  @autoreleasepool {
    impl_->device = MTLCreateSystemDefaultDevice();
  }
  if (!impl_->device) { BRT_LOG("MTLCreateSystemDefaultDevice failed"); return false; }

  impl_->gpu = gpu::createMetalBackend();
  if (!impl_->gpu) { BRT_LOG("createMetalBackend failed"); return false; }

  impl_->rt = std::make_unique<effect_runtime::EffectRuntime>(impl_->gpu.get());
  impl_->registry = std::make_unique<sketch_executor::ModuleRegistry>(impl_->rt.get());

  impl_->bundles = std::make_unique<sketch_executor::WasmEffectBundles>();
  int total = 0;
  if (impl_->bundles->init()) {
    for (const char* name : kBundleNames) {
      std::string path = wasm_dir + "/" + name + ".wasm";
      int n = impl_->bundles->loadBundleFile(path, *impl_->registry, impl_->gpu.get(), nullptr);
      BRT_LOG("wasm bundle '%s': %d effect(s) from %s", name, n, path.c_str());
      total += n;
    }
  }
  if (total == 0) {
    BRT_LOG("ERROR: no WASM effects loaded (wasm_dir=%s)", wasm_dir.c_str());
    impl_->bundles.reset();
  }

  if (!font_path.empty()) effect_runtime::textInstallDefaultFonts(font_path.c_str());

  impl_->rt->drainConsoleLog();
  impl_->usable = (total > 0);
  BRT_LOG("acquired: %d effect(s) loaded", total);
  return impl_->usable;
}

void BarrelRuntime::release() {
  std::lock_guard<std::mutex> lk(impl_->lifecycle_mu);
  if (impl_->refcount > 0) --impl_->refcount;
  // Note: we intentionally do NOT tear down the runtime at refcount 0 for now —
  // Resolume rebuilds instances frequently, and rebuilding the whole effect set
  // is expensive. The singleton lives for the process. (Per-key executors ARE
  // destroyed in destroyExecutor.)
}

void* BarrelRuntime::metalDevice() {
  return (__bridge void*)impl_->device;
}

std::string BarrelRuntime::schemasJson() {
  std::lock_guard<std::mutex> lk(impl_->render_mu);
  nlohmann::json out = nlohmann::json::object();
  if (!impl_->registry) return out.dump();
  for (const auto& [module_type, schema_fields] : impl_->registry->schemas()) {
    out[module_type] = {
      {"key", module_type},
      {"id", module_type},
      {"version", "0.0.0"},
      {"schema", schema_fields},
    };
  }
  return out.dump();
}

void BarrelRuntime::createExecutor(const std::string& key) {
  std::lock_guard<std::mutex> lk(impl_->render_mu);
  if (!impl_->usable) return;
  if (impl_->executors.count(key)) return;
  Impl::PerExecutor pe;
  pe.executor = std::make_unique<sketch_executor::SketchExecutor>(
      impl_->rt.get(), impl_->registry.get(), impl_->gpu.get());
  // Namespace this instance's effect-state keys by its plugin key so two
  // barrels with colliding bare keys (e.g. "inv@0") stay isolated in the
  // shared instance pool.
  pe.executor->setKeyNamespace(key + "/");
  if (const char* f = getenv("NANO_BARREL_FUSION"); f && (*f == '0')) {
    pe.executor->setFusionEnabled(false);
  }
  impl_->executors.emplace(key, std::move(pe));
  BRT_LOG("executor created key=%s (now %zu)", key.c_str(), impl_->executors.size());
}

void BarrelRuntime::destroyExecutor(const std::string& key) {
  std::lock_guard<std::mutex> lk(impl_->render_mu);
  auto it = impl_->executors.find(key);
  if (it == impl_->executors.end()) return;
  // Free this barrel's namespaced effect instances from the shared pool while
  // GPU-idle under the render lock (EffectInstance dtors call_indirect into the
  // shared WasmHost + GPU).
  if (impl_->rt) impl_->rt->destroyInstancesWithKeyPrefix(key + "/");
  impl_->executors.erase(it);
  BRT_LOG("executor destroyed key=%s (now %zu)", key.c_str(), impl_->executors.size());
}

void BarrelRuntime::render(const std::string& key, void* in_tex, void* out_tex,
                           int w, int h, double dt, double elapsed,
                           const std::string& sketch_json, bool dirty) {
  std::lock_guard<std::mutex> lk(impl_->render_mu);
  if (!impl_->usable) return;
  auto it = impl_->executors.find(key);
  if (it == impl_->executors.end()) return;
  Impl::PerExecutor& pe = *&it->second;

  if (dirty || !pe.haveSketch) {
    auto parsed = nlohmann::json::parse(sketch_json, nullptr, false);
    if (!parsed.is_discarded()) { pe.sketch = std::move(parsed); pe.haveSketch = true; }
  }
  if (!pe.haveSketch || !in_tex || !out_tex) return;

  effect_runtime::setHostTime(elapsed);
  effect_runtime::setHostDeltaTime(dt);
  effect_runtime::setHostViewport(w, h);

  int32_t inputHandle = impl_->gpu->adoptExternalTexture(in_tex);
  int32_t outputHandle = impl_->gpu->adoptExternalTexture(out_tex);

  (void)pe.executor->execute(pe.sketch, inputHandle, outputHandle, w, h, dt, dirty);

  impl_->gpu->submit();
  impl_->rt->drainConsoleLog();

  impl_->gpu->release(inputHandle);
  impl_->gpu->release(outputHandle);
}

}  // namespace bridge
