// test_comp_host_prune.cpp — a comp host frees the effect instances it no
// longer needs, and only its own.
//
// The web prunes to comp_required_json every frame (pruneInstancesExcept); the
// native host kept every instance it ever made, so a long session grew one per
// clip it had composited. CompHost::pruneInstances is the native twin, scoped to
// the comp's key namespace so other barrels sharing the runtime are untouched.
//
// And the revive case the web guards against: a pruned instance that re-enters
// the chain must render with its params, not the defaults a fresh instance
// holds (the executor's applied-state cache would otherwise skip the apply).

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "bridge/comp_host.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/wasm_bundles.h"

#include "wasm_paths.h"

using effect_runtime::EffectRuntime;
using json = nlohmann::json;

namespace {

json mkDevice(const std::string& id, const std::string& type, json state = json::object()) {
  return {{"id", id}, {"moduleType", type}, {"name", type}, {"capabilities", json::array()},
          {"state", std::move(state)}};
}

json mkClip(const std::string& id, double startBeat, double lengthBeat, json devices) {
  return {{"id", id}, {"name", id}, {"startBeat", startBeat}, {"lengthBeat", lengthBeat},
          {"kind", "effect"}, {"sketch", {{"devices", std::move(devices)}}},
          {"loop", {{"mode", "time"}, {"startSec", 0}, {"speed", 1}, {"direction", "forward"}}},
          {"automation", json::array()}, {"exports", json::array()}, {"warps", json::array()}};
}

json mkDoc() {
  const auto solid = [](const std::string& id, double r) {
    return mkDevice(id, "source.solid_color", {{"color", {r, 0.0, 0.0}}});
  };
  json tracks = json::array({
      {{"id", "t1"}, {"name", "t1"}, {"kind", "track"}, {"parentId", nullptr},
       {"sketch", {{"devices", json::array()}}}, {"automation", json::array()},
       {"clips", json::array({mkClip("a", 0, 4, json::array({solid("da", 0.8)})),
                              mkClip("b", 8, 4, json::array({solid("db", 0.3)}))})}},
      {{"id", "main-bus"}, {"name", "Main Bus"}, {"kind", "group"}, {"parentId", nullptr},
       {"sketch", {{"devices", json::array()}}}, {"automation", json::array()},
       {"clips", json::array()}},
  });
  return {{"meta", {{"resolution", {{"width", 1920}, {"height", 1080}}}, {"baseBPM", 120},
                    {"timeSignature", {4, 4}}}},
          {"tracks", tracks}, {"rails", json::array()},
          {"playMode", {{"defaultMode", "time"}}}};
}

struct Harness {
  std::unique_ptr<gpu::GPUBackend> backend;
  sketch_executor::WasmEffectBundles bundles;
  std::unique_ptr<EffectRuntime> rt;
  std::unique_ptr<sketch_executor::ModuleRegistry> registry;

  bool init() {
    backend = gpu::createBackend();
    if (!backend) return false;
    if (!bundles.init()) return false;
    rt = std::make_unique<EffectRuntime>(backend.get());
    registry = std::make_unique<sketch_executor::ModuleRegistry>(rt.get());
    return bundles.loadBundleFile(kCoreWasm, *registry, backend.get(), nullptr) > 1;
  }
};

std::vector<std::pair<std::string, std::string>> required(bridge::CompHost& h) {
  std::vector<std::pair<std::string, std::string>> out;
  for (const auto& r : json::parse(h.executor().requiredJson()))
    out.emplace_back(r["moduleType"].get<std::string>(), r["instanceKey"].get<std::string>());
  return out;
}

/// Pooled instances whose key mentions `needle` (a clip id is in every key the
/// comp mints for it).
size_t countWith(EffectRuntime& rt, const std::string& needle) {
  size_t n = 0;
  rt.destroyInstancesIf([&](const std::string&, const std::string& key) {
    if (key.find(needle) != std::string::npos) n++;
    return false;
  });
  return n;
}

double centreRed(Harness& hx, bridge::CompHost& h) {
  hx.backend->submit();
  const auto px = hx.backend->readbackTexture(h.outputTexture(), h.width(), h.height());
  const size_t o = ((h.height() / 2) * h.width() + h.width() / 2) * 4;
  return px[o];
}

}  // namespace

TEST_CASE("a comp host prunes to its required set, in its own namespace only",
          "[comp_host][gpu]") {
  Harness hx;
  if (!hx.init()) SKIP("no GPU / core.wasm");
  bridge::CompHost::Config cfg;
  cfg.width = 16;
  cfg.height = 16;
  cfg.keyNamespace = "comp1/";
  bridge::CompHost host(hx.backend.get(), hx.rt.get(), hx.registry.get(), &hx.bundles, cfg);
  host.loadDocument(mkDoc());

  // Someone else's instance in the same pool (another barrel).
  REQUIRE(hx.rt->instanceFor("source.solid_color", "other/x"));

  host.executor().seekBeat(1);
  host.step(0);
  host.step(0);
  const double redA = centreRed(hx, host);
  REQUIRE(countWith(*hx.rt, "comp1/") > 0);
  const size_t aInstances = countWith(*hx.rt, "_a_");
  REQUIRE(aInstances > 0);
  CHECK(host.pruneInstances(required(host)) == 0);  // everything live is needed

  // Past clip A, into clip B: A's instances are no longer required.
  host.executor().seekBeat(9);
  host.step(0);
  CHECK(host.pruneInstances(required(host)) == aInstances);
  CHECK(countWith(*hx.rt, "_a_") == 0);
  CHECK(countWith(*hx.rt, "_b_") > 0);
  CHECK(hx.rt->findInstance("source.solid_color", "other/x") != nullptr);

  // Back to A: a FRESH instance, which must still get its colour (0.8 red),
  // not the effect's default.
  host.executor().seekBeat(1);
  host.step(0);
  host.step(0);
  CHECK(countWith(*hx.rt, "_a_") > 0);
  CHECK(centreRed(hx, host) == redA);
  CHECK(redA > 150);
}
