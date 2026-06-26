// test_effect_abi.cpp — validates the effect ABI load path used by the
// barrel-loads-WASM migration: a real effect bundle's nano_module_main() runs
// under WAMR, its name-keyed `module.register_effect_*` builder imports land,
// and the host captures each effect's metadata strings + lifecycle callback
// table indices (keyed by name). testonly.wasm bundles mod.source.lfo
// (env_lfo), a pure data effect with no GPU dependency — the smallest
// end-to-end exercise.

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <cmath>
#include <cstring>
#include <fstream>
#include <vector>

#include "bridge/param_cache.h"
#include "bridge/state_document.h"
#include "wasm/wasm_host.h"

using bridge::ParamCache;
using bridge::StateDocument;
using wasm::WasmHost;
using wasm::WasmEffectDesc;
using wasm::FrameState;

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

TEST_CASE("testonly.wasm registers mod.source.lfo via nano_module_main", "[effect_abi]") {
  auto bytecode = load_file(TESTONLY_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  INFO("last_error: " << host.last_error());
  REQUIRE(id >= 0);

  // nano_module_main() is the bundle entry point; it registers each effect via
  // the module.register_effect_* builder imports.
  INFO("nano_module_main error: " << host.last_error());
  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const auto& effects = host.registered_effects(id);
  INFO("registered " << effects.size() << " effect(s)");
  REQUIRE(!effects.empty());

  const WasmEffectDesc* lfo = nullptr;
  for (const auto& e : effects) {
    if (e.id == "mod.source.lfo") { lfo = &e; break; }
  }
  REQUIRE(lfo != nullptr);

  // Metadata captured via the name-keyed register_effect_str builder calls.
  CHECK(!lfo->name.empty());

  // Lifecycle table indices the runtime will call_indirect, captured by name.
  // clang reserves table slot 0, so every address-taken function gets a
  // non-zero index; env_lfo supplies these four (it omits is_identity /
  // on_active, which therefore never appear in the map).
  CHECK(lfo->fn("module_init") != 0);
  CHECK(lfo->fn("create") != 0);
  CHECK(lfo->fn("tick") != 0);
  CHECK(lfo->fn("on_state_patched") != 0);
  CHECK(lfo->fn("is_identity") == 0);  // not provided → absent from the map

  host.shutdown();
}

TEST_CASE("mod.source.lfo executes via call_indirect and writes output", "[effect_abi]") {
  auto bytecode = load_file(TESTONLY_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  INFO("last_error: " << host.last_error());
  REQUIRE(id >= 0);

  // Wire the per-instance host services the effect's lifecycle touches:
  // a state doc (schema + output land here) and a frame clock.
  StateDocument doc;
  host.set_state_doc(id, &doc);
  FrameState fs;
  fs.elapsed_time = 0.0;  // host::time()==0 => sin(0)==0 => output 0.5
  host.set_frame_state(id, &fs);

  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  const WasmEffectDesc* lfo = nullptr;
  for (const auto& e : host.registered_effects(id)) {
    if (e.id == "mod.source.lfo") { lfo = &e; break; }
  }
  REQUIRE(lfo != nullptr);

  // WAMR packed-argv convention: a buffer of uint32 slots, f64 occupies two,
  // results overwrite from argv[0]. This is exactly what the EffectInstance
  // WASM driver will marshal; proving it here de-risks that wrapper.
  uint32_t argv[8] = {0};

  // module_init() — registers the schema (sets plugin_key) + state defaults.
  REQUIRE(host.call_indirect(id, lfo->fn("module_init"), 0, argv));
  const std::string key = host.plugin_key(id);
  INFO("plugin_key: " << key);
  REQUIRE(!key.empty());

  // create() -> self (a State* in the module's linear memory).
  argv[0] = 0;
  REQUIRE(host.call_indirect(id, lfo->fn("create"), 0, argv));
  const uint32_t self = argv[0];
  REQUIRE(self != 0);

  // init(self) — applies defaults (rate 0.5, amplitude 1.0).
  argv[0] = self;
  REQUIRE(host.call_indirect(id, lfo->fn("init"), 1, argv));

  // tick(self, dt): self i32 @argv[0], dt f64 @argv[1..2].
  argv[0] = self;
  double dt = 0.016;
  std::memcpy(&argv[1], &dt, sizeof(double));
  REQUIRE(host.call_indirect(id, lfo->fn("tick"), 3, argv));

  // tick wrote state::setValPath("output", ...) into the state doc.
  auto state = doc.get_plugin_state(key);
  INFO("state: " << state.dump());
  REQUIRE(state.contains("output"));
  // tick advances a phase accumulator by dt*rate (style guide §2.1) rather than
  // reading time()*rate, so turning the rate knob never causes a phase jump.
  // Default rate 0.5 → 5 Hz; one 16 ms tick advances phase to 0.08 cycles.
  const double kPi = 3.14159265358979323846;
  double expected = std::sin(0.08 * 2.0 * kPi) * 0.5 + 0.5;
  CHECK(state["output"].get<double>() == Catch::Approx(expected).margin(1e-6));

  host.shutdown();
}
