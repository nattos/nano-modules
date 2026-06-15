// test_wasm_bundles.cpp — the barrel cutover's bundle loader. Loads core.wasm
// through WasmEffectBundles and verifies its effects register. No GPU backend:
// an effect still publishes its schema even when module_init skips shader
// compilation (backend == None), so registration is verifiable without Metal.

#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <memory>
#include <vector>

#include "bridge/param_cache.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/wasm_bundles.h"
#include "wasm/wasm_host.h"

using sketch_executor::WasmEffectBundles;
using sketch_executor::ModuleRegistry;
using effect_runtime::EffectRuntime;

#ifndef CORE_WASM_PATH
#error "CORE_WASM_PATH must be defined"
#endif

// Multiple plugin instances each own a WasmHost. WAMR's runtime init/destroy is
// process-GLOBAL, so a per-instance init()/shutdown() must NOT tear the runtime
// out from under other live instances. This reproduces the Resolume multi-
// instance crash: instance A loads, B loads, A is destroyed, then C must still
// load — and B must stay usable.
TEST_CASE("WAMR runtime survives overlapping WasmHost lifetimes", "[wasm_bundles]") {
  auto load_count = [](wasm::WasmHost& h) -> int {
    std::ifstream f(CORE_WASM_PATH, std::ios::binary | std::ios::ate);
    if (!f) return -1;
    auto size = f.tellg(); f.seekg(0);
    std::vector<uint8_t> buf(static_cast<size_t>(size));
    f.read(reinterpret_cast<char*>(buf.data()), size);
    int32_t id = h.load_module(buf.data(), static_cast<uint32_t>(buf.size()));
    if (id < 0) return -1;
    if (h.call_function(id, "nano_module_main") != 0) return -1;
    return static_cast<int>(h.registered_effects(id).size());
  };

  bridge::ParamCache cacheA;
  wasm::WasmHost A(cacheA);
  REQUIRE(A.init());
  const int nA = load_count(A);
  REQUIRE(nA > 1);

  // A second instance is created and then destroyed (Resolume probes/churns
  // plugin instances constantly). Its shutdown() must NOT tear down the
  // process-global WAMR runtime that A is still using.
  {
    bridge::ParamCache cacheB;
    wasm::WasmHost B(cacheB);
    REQUIRE(B.init());
    REQUIRE(load_count(B) == nA);
  }  // B destroyed here

  // A must still be able to load + run a module. In the buggy (non-refcounted)
  // version B's shutdown called wasm_runtime_destroy(), invalidating A.
  CHECK(load_count(A) == nA);
}

TEST_CASE("WasmEffectBundles loads core.wasm and registers its effects", "[wasm_bundles]") {
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());

  EffectRuntime rt(nullptr);  // no GPU — effects publish schema, skip shaders
  ModuleRegistry registry(&rt);

  int n = bundles.loadBundleFile(CORE_WASM_PATH, registry, nullptr, nullptr);
  INFO("registered " << n << " effect(s)");
  REQUIRE(n > 1);
  REQUIRE(registry.size() == static_cast<size_t>(n));

  const sketch_executor::RegisteredModule* bc =
      registry.find("video.brightness_contrast");
  REQUIRE(bc != nullptr);
  CHECK(bc->schemaFields.contains("brightness"));
  CHECK(bc->schemaFields.contains("tex_in"));

  // A missing / non-bundle path returns 0 without crashing.
  CHECK(bundles.loadBundleFile("/no/such/bundle.wasm", registry, nullptr, nullptr) == 0);
}
