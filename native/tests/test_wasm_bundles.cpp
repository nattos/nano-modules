// test_wasm_bundles.cpp — the barrel cutover's bundle loader. Loads core.wasm
// through WasmEffectBundles and verifies its effects register. No GPU backend:
// an effect still publishes its schema even when module_init skips shader
// compilation (backend == None), so registration is verifiable without Metal.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include "bridge/param_cache.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/wasm_bundles.h"
#include "wasm/wasm_host.h"
#include "../wasm_modules/include/module_api.h"  // NANO_ABI_VERSION

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
      registry.find("color.tone.brightness_contrast");
  REQUIRE(bc != nullptr);
  CHECK(bc->schemaFields.contains("brightness"));
  CHECK(bc->schemaFields.contains("tex_in"));

  // A missing / non-bundle path returns 0 without crashing.
  CHECK(bundles.loadBundleFile("/no/such/bundle.wasm", registry, nullptr, nullptr) == 0);
}

TEST_CASE("temporal capabilities round-trip from schema to the registry", "[wasm_bundles]") {
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(nullptr);  // no GPU — schema still publishes
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, nullptr, nullptr) > 1);

  auto has = [&](const char* id, const char* cap) -> bool {
    const auto* m = registry.find(id);
    REQUIRE(m != nullptr);
    return std::find(m->capabilities.begin(), m->capabilities.end(),
                     std::string(cap)) != m->capabilities.end();
  };

  // Stateless tone op → declares time_independent, and none of the seek tags.
  CHECK(has("color.tone.brightness_contrast", "time_independent"));
  CHECK_FALSE(has("color.tone.brightness_contrast", "seekable_approximate"));
  CHECK_FALSE(has("color.tone.brightness_contrast", "seekable_prefill"));

  // Free-running LFO (phase + random-walk) → seekable_approximate, NOT
  // time_independent, and (since no effect implements it) not seekable_prefill.
  CHECK(has("mod.source.lfo", "seekable_approximate"));
  CHECK_FALSE(has("mod.source.lfo", "time_independent"));
  CHECK_FALSE(has("mod.source.lfo", "seekable_prefill"));

  // ADSR is a trigger/voice state machine → no temporal tag at all (the
  // conservative "fully stateful, not safely seekable" default).
  CHECK_FALSE(has("mod.source.adsr", "time_independent"));
  CHECK_FALSE(has("mod.source.adsr", "seekable_approximate"));
  CHECK_FALSE(has("mod.source.adsr", "seekable_prefill"));

  // seekable_prefill is declared in the ABI but added to NO effect yet.
  for (const char* id : {"color.tone.brightness_contrast", "mod.source.lfo",
                         "mod.source.adsr", "motion.blur"})
    CHECK_FALSE(has(id, "seekable_prefill"));

  // The dashboard exposes sketch INPUTS; util.sketch_output the symmetric
  // OUTPUTS. Both are identity passthroughs → also time_independent.
  CHECK(has("util.dashboard", "sketch_input_source"));
  CHECK(has("util.sketch_output", "sketch_output_source"));
  CHECK(has("util.sketch_output", "time_independent"));
  CHECK_FALSE(has("util.sketch_output", "sketch_input_source"));
}

TEST_CASE("bundle reports its host<->effect ABI version", "[wasm_bundles]") {
  WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  EffectRuntime rt(nullptr);
  ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(CORE_WASM_PATH, registry, nullptr, nullptr) > 1);

  // core.wasm is built against the current headers, so every effect it
  // registers carries the current NANO_ABI_VERSION (read from the bundle's
  // nano_abi_version() export before nano_module_main). A value of 0 would mean
  // the export wasn't found / wired.
  const auto* bc = registry.find("color.tone.brightness_contrast");
  REQUIRE(bc != nullptr);
  CHECK(bc->abiVersion == NANO_ABI_VERSION);
  CHECK(bc->abiVersion >= 1);

  // Every effect in one bundle shares the bundle's ABI version.
  const auto* lfo = registry.find("mod.source.lfo");
  REQUIRE(lfo != nullptr);
  CHECK(lfo->abiVersion == bc->abiVersion);
}
