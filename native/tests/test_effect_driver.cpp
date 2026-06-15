// test_effect_driver.cpp — drives a WASM effect through the EffectInstance /
// EffectRuntime path (the barrel's dispatch layer), proving the WASM-backed
// EffectDesc driver wraps call_indirect correctly end-to-end: registerEffect →
// doModuleInit, instanceFor → doCreate (create+init), doTick. Uses data.lfo
// (env_lfo) — a pure data effect, no GPU.

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <fstream>
#include <vector>

#include "bridge/param_cache.h"
#include "bridge/state_document.h"
#include "runtime/effect_runtime.h"
#include "wasm/wasm_host.h"

using bridge::ParamCache;
using bridge::StateDocument;
using wasm::WasmHost;
using wasm::WasmEffectDesc;
using wasm::FrameState;
using effect_runtime::EffectRuntime;
using effect_runtime::EffectDesc;
using effect_runtime::EffectInstance;

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

TEST_CASE("WASM effect driven through EffectInstance (data.lfo)", "[effect_driver]") {
  auto bytecode = load_file(TESTONLY_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  INFO("last_error: " << host.last_error());
  REQUIRE(id >= 0);

  // The lifecycle's host imports need a state doc (schema + output land here)
  // and a frame clock. Wire them before module_init runs.
  StateDocument doc;
  host.set_state_doc(id, &doc);
  FrameState fs;
  fs.elapsed_time = 0.0;  // host::time()==0 => output 0.5
  host.set_frame_state(id, &fs);

  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const WasmEffectDesc* w = nullptr;
  for (const auto& e : host.registered_effects(id)) {
    if (e.id == "data.lfo") { w = &e; break; }
  }
  REQUIRE(w != nullptr);

  // Build a WASM-backed EffectDesc from the captured descriptor — this is the
  // shape the WASM-backed ModuleRegistry will produce in the next increment.
  EffectDesc desc;
  desc.id = w->id;
  desc.name = w->name;
  desc.wasm_host = &host;
  desc.wasm_module_id = id;
  desc.w_module_init = w->idx_module_init;
  desc.w_create = w->idx_create;
  desc.w_destroy = w->idx_destroy;
  desc.w_init = w->idx_init;
  desc.w_tick = w->idx_tick;
  desc.w_render = w->idx_render;
  desc.w_on_state_patched = w->idx_on_state_patched;
  desc.w_on_resolume_param = w->idx_on_resolume_param;
  desc.w_is_identity = w->idx_is_identity;
  desc.w_on_active = w->idx_on_active;
  REQUIRE(desc.isWasm());

  EffectRuntime rt(nullptr);  // data.lfo is GPU-free

  // registerEffect → doModuleInit (WASM): registers the schema + plugin key.
  EffectInstance* proto = rt.registerEffect(desc);
  REQUIRE(proto != nullptr);
  const std::string key = host.plugin_key(id);
  INFO("plugin_key: " << key);
  REQUIRE(!key.empty());

  // instanceFor → doCreate (WASM create + init): allocates the State*.
  EffectInstance* inst = rt.instanceFor("data.lfo", "k0");
  REQUIRE(inst != nullptr);
  REQUIRE(inst->userState() != nullptr);

  // doTick (WASM): computes + writes "output" through the state imports.
  inst->doTick(0.016);

  auto state = doc.get_plugin_state(key);
  INFO("state: " << state.dump());
  REQUIRE(state.contains("output"));
  CHECK(state["output"].get<double>() == Catch::Approx(0.5).margin(1e-6));

  host.shutdown();
}
