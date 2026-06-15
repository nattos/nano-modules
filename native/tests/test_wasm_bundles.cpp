// test_wasm_bundles.cpp — the barrel cutover's bundle loader. Loads core.wasm
// through WasmEffectBundles and verifies its effects register. No GPU backend:
// an effect still publishes its schema even when module_init skips shader
// compilation (backend == None), so registration is verifiable without Metal.

#include <catch2/catch_test_macros.hpp>

#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/wasm_bundles.h"

using sketch_executor::WasmEffectBundles;
using sketch_executor::ModuleRegistry;
using effect_runtime::EffectRuntime;

#ifndef CORE_WASM_PATH
#error "CORE_WASM_PATH must be defined"
#endif

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
