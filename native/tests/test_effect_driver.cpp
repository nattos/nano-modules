// test_effect_driver.cpp — drives a WASM effect through the EffectInstance /
// EffectRuntime path (the barrel's dispatch layer), proving the WASM-backed
// EffectDesc driver wraps call_indirect correctly end-to-end: registerEffect →
// doModuleInit, instanceFor → doCreate (create+init), doTick. Uses data.lfo
// (env_lfo) — a pure data effect, no GPU.

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <vector>

#include "bridge/param_cache.h"
#include "bridge/state_document.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
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
  FrameState fs;  // present for the lifecycle's frame-clock imports; the LFO no
  fs.elapsed_time = 0.0;  // longer reads it (phase is a dt accumulator now).
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

  // Schema forwarding: module_init's state.set_schema host call routed onto the
  // instance (via the EffectHostSink), so the executor/registry can read it.
  CHECK(proto->metadataId() == "data.lfo");
  CHECK(!proto->schemaJson().empty());
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
  // Phase is a dt accumulator (style guide §2.1): default rate 0.5 → 5 Hz, so a
  // single 16 ms tick advances phase to 0.08 cycles → sin(0.08*2π)*0.5+0.5.
  const double kPi = 3.14159265358979323846;
  CHECK(state["output"].get<double>() ==
        Catch::Approx(std::sin(0.08 * 2.0 * kPi) * 0.5 + 0.5).margin(1e-6));

  host.shutdown();
}

TEST_CASE("WASM effect receives params via on_state_patched (data.lfo)", "[effect_driver]") {
  auto bytecode = load_file(TESTONLY_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);

  StateDocument doc;
  host.set_state_doc(id, &doc);
  // phase accumulates as dt*(rate*10) cycles. rate=0.5 (default) => 5 Hz, so a
  // dt=0.05 tick advances phase to 0.25 cycles (=pi/2 in radians) => sin=1 and
  // amplitude becomes observable: output = sin(phase*2π)*amplitude*0.5 + 0.5.
  FrameState fs;
  fs.elapsed_time = 0.0;
  host.set_frame_state(id, &fs);

  REQUIRE(host.call_function(id, "nano_module_main") == 0);
  const WasmEffectDesc* w = nullptr;
  for (const auto& e : host.registered_effects(id)) {
    if (e.id == "data.lfo") { w = &e; break; }
  }
  REQUIRE(w != nullptr);

  EffectDesc desc;
  desc.id = w->id;
  desc.wasm_host = &host;
  desc.wasm_module_id = id;
  desc.w_module_init = w->idx_module_init;
  desc.w_create = w->idx_create;
  desc.w_destroy = w->idx_destroy;
  desc.w_init = w->idx_init;
  desc.w_tick = w->idx_tick;
  desc.w_on_state_patched = w->idx_on_state_patched;

  EffectRuntime rt(nullptr);
  rt.registerEffect(desc);
  const std::string key = host.plugin_key(id);
  REQUIRE(!key.empty());
  EffectInstance* inst = rt.instanceFor("data.lfo", "k0");
  REQUIRE(inst != nullptr);

  // Defaults (amplitude 1.0): advance phase to 0.25 cycles → sin(pi/2)*1*0.5+0.5
  // = 1.0 (clamped).
  inst->doTick(0.05);
  CHECK(doc.get_plugin_state(key)["output"].get<double>() ==
        Catch::Approx(1.0).margin(1e-4));

  // Patch amplitude -> 0.5, then a dt=0 tick holds phase at 0.25:
  // sin(pi/2)*0.5*0.5+0.5 = 0.75. Proves the patch marshalled into linear memory
  // and on_state_patched applied it.
  inst->setParamFloat("amplitude", 0.5f);
  inst->doTick(0.0);
  CHECK(doc.get_plugin_state(key)["output"].get<double>() ==
        Catch::Approx(0.75).margin(1e-4));

  host.shutdown();
}

TEST_CASE("WASM ModuleRegistry registers a bundle with parsed schema", "[effect_driver]") {
  auto bytecode = load_file(TESTONLY_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);
  REQUIRE(host.call_function(id, "nano_module_main") == 0);

  // No state doc: the schema reaches the registry purely through the
  // EffectHostSink forwarding (set_schema -> EffectInstance -> schemaJson()).
  EffectRuntime rt(nullptr);
  sketch_executor::ModuleRegistry registry(&rt);
  int n = registry.registerWasmBundle(host, id);
  INFO("registered " << n << " effect(s)");
  CHECK(n >= 1);

  const sketch_executor::RegisteredModule* reg = registry.find("data.lfo");
  REQUIRE(reg != nullptr);
  // schemaFields parsed from the forwarded schema JSON.
  CHECK(reg->schemaFields.contains("rate"));
  CHECK(reg->schemaFields.contains("amplitude"));
  CHECK(reg->schemaFields.contains("waveform"));
  CHECK(reg->schemaFields.contains("shape"));
  CHECK(reg->schemaFields.contains("output"));

  host.shutdown();
}

// Drive data.lfo through every waveform for one cycle and assert each has its
// characteristic signature (style guide §2.1 shapes). All outputs must stay in
// the declared [0,1] range; `shape` morphs the active waveform.
TEST_CASE("data.lfo waveforms produce characteristic shapes", "[effect_driver]") {
  auto bytecode = load_file(TESTONLY_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);

  StateDocument doc;
  host.set_state_doc(id, &doc);
  FrameState fs;
  fs.elapsed_time = 0.0;
  host.set_frame_state(id, &fs);

  REQUIRE(host.call_function(id, "nano_module_main") == 0);
  const WasmEffectDesc* w = nullptr;
  for (const auto& e : host.registered_effects(id)) {
    if (e.id == "data.lfo") { w = &e; break; }
  }
  REQUIRE(w != nullptr);

  EffectDesc desc;
  desc.id = w->id;
  desc.wasm_host = &host;
  desc.wasm_module_id = id;
  desc.w_module_init = w->idx_module_init;
  desc.w_create = w->idx_create;
  desc.w_destroy = w->idx_destroy;
  desc.w_init = w->idx_init;
  desc.w_tick = w->idx_tick;
  desc.w_on_state_patched = w->idx_on_state_patched;

  EffectRuntime rt(nullptr);
  rt.registerEffect(desc);
  const std::string key = host.plugin_key(id);
  REQUIRE(!key.empty());

  // env_lfo waveform selector values (mirror of the effect's Shape enum).
  enum { WfSine = 0, WfSquare = 1, WfTriangle = 2, WfSaw = 3, WfRandomWalk = 4,
         WfRandomFM = 5 };

  // One full cycle: rate 0.1 → 1 Hz, dt 0.01 → 100 samples per cycle.
  const double kRate = 0.1, kDt = 0.01;
  const int kN = 100;
  auto sweep = [&](const char* ikey, int waveform, float shape) {
    EffectInstance* inst = rt.instanceFor("data.lfo", ikey);
    REQUIRE(inst != nullptr);
    inst->setParamFloat("rate", static_cast<float>(kRate));
    inst->setParamFloat("waveform", static_cast<float>(waveform));
    inst->setParamFloat("shape", shape);
    std::vector<double> out;
    for (int i = 0; i < kN; i++) {
      inst->doTick(kDt);
      out.push_back(doc.get_plugin_state(key)["output"].get<double>());
    }
    return out;
  };
  auto inRange = [](const std::vector<double>& v) {
    for (double x : v)
      if (x < -1e-6 || x > 1.0 + 1e-6) return false;
    return true;
  };
  auto countAbove = [](const std::vector<double>& v, double t) {
    int c = 0;
    for (double x : v) if (x > t) c++;
    return c;
  };
  auto countBelow = [](const std::vector<double>& v, double t) {
    int c = 0;
    for (double x : v) if (x < t) c++;
    return c;
  };

  // Sine (shape 0): smooth, in range, reaches both rails.
  {
    auto v = sweep("sine", WfSine, 0.0f);
    CHECK(inRange(v));
    CHECK(countAbove(v, 0.95) > 0);
    CHECK(countBelow(v, 0.05) > 0);
  }
  // Square (shape 0): bimodal ±1, ~50% duty, essentially no mid values.
  {
    auto v = sweep("sq", WfSquare, 0.0f);
    CHECK(inRange(v));
    int hi = countAbove(v, 0.99), lo = countBelow(v, 0.01);
    CHECK(hi + lo >= kN - 2);
    CHECK(hi > 30);
    CHECK(hi < 70);
  }
  // Square (shape 0.8): duty narrows (0.5 → ~0.14) → fewer high samples.
  {
    auto v = sweep("sqn", WfSquare, 0.8f);
    CHECK(countAbove(v, 0.99) < 30);
  }
  // Triangle (shape 0): peak near mid-cycle.
  {
    auto v = sweep("tri", WfTriangle, 0.0f);
    CHECK(inRange(v));
    size_t argmax = 0;
    for (size_t i = 1; i < v.size(); i++)
      if (v[i] > v[argmax]) argmax = i;
    CHECK(argmax > 35);
    CHECK(argmax < 65);
  }
  // Saw (shape 0): monotonic rising ramp (one drop at the wrap is allowed).
  {
    auto v = sweep("saw", WfSaw, 0.0f);
    CHECK(inRange(v));
    int rises = 0;
    for (size_t i = 1; i < v.size(); i++)
      if (v[i] >= v[i - 1] - 1e-6) rises++;
    CHECK(rises >= static_cast<int>(v.size()) - 2);
  }
  // Random Walk: stays in range and actually moves.
  {
    auto v = sweep("rw", WfRandomWalk, 0.7f);
    CHECK(inRange(v));
    double lo = 2.0, hi = -2.0;
    for (double x : v) { lo = std::min(lo, x); hi = std::max(hi, x); }
    CHECK(hi - lo > 0.05);
  }
  // Random FM: sine carrier, stays in range and swings across both rails.
  {
    auto v = sweep("fm", WfRandomFM, 0.9f);
    CHECK(inRange(v));
    CHECK(countAbove(v, 0.9) > 0);
    CHECK(countBelow(v, 0.1) > 0);
  }

  host.shutdown();
}
