// test_effect_abi.cpp — validates the v2 effect ABI load path used by the
// barrel-loads-WASM migration: a real effect bundle's nano_module_main() runs
// under WAMR, its `module.register_effect` import lands, and the host captures
// each nano::EffectDesc_v2 (strings + indirect-function-table indices) out of
// the module's linear memory. testonly.wasm bundles data.lfo (env_lfo), a pure
// data effect with no GPU dependency — the smallest end-to-end exercise.

#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <vector>

#include "bridge/param_cache.h"
#include "wasm/wasm_host.h"

using bridge::ParamCache;
using wasm::WasmHost;
using wasm::WasmEffectDesc;

static std::vector<uint8_t> load_file(const char* path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg();
  f.seekg(0);
  std::vector<uint8_t> buf(static_cast<size_t>(size));
  f.read(reinterpret_cast<char*>(buf.data()), size);
  return buf;
}

#ifndef TESTONLY_WASM_PATH
#error "TESTONLY_WASM_PATH must be defined"
#endif

TEST_CASE("testonly.wasm registers data.lfo via nano_module_main", "[effect_abi]") {
  auto bytecode = load_file(TESTONLY_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  INFO("last_error: " << host.last_error());
  REQUIRE(id >= 0);

  // nano_module_main() is the bundle entry point; it calls
  // module.register_effect once per effect the bundle provides.
  INFO("nano_module_main error: " << host.last_error());
  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const auto& effects = host.registered_effects(id);
  INFO("registered " << effects.size() << " effect(s)");
  REQUIRE(!effects.empty());

  const WasmEffectDesc* lfo = nullptr;
  for (const auto& e : effects) {
    if (e.id == "data.lfo") { lfo = &e; break; }
  }
  REQUIRE(lfo != nullptr);

  // Descriptor fields marshalled out of linear memory.
  CHECK(lfo->struct_version == 2);
  CHECK(!lfo->name.empty());

  // Lifecycle table indices the runtime will call_indirect. clang reserves
  // table slot 0, so every address-taken function gets a non-zero index;
  // env_lfo supplies these four (it omits is_identity / on_active → 0).
  CHECK(lfo->idx_module_init != 0);
  CHECK(lfo->idx_create != 0);
  CHECK(lfo->idx_tick != 0);
  CHECK(lfo->idx_on_state_patched != 0);

  host.shutdown();
}
