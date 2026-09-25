// test_barrel_field_visibility.cpp — a remote editor learns which fields each
// card hides from the barrel.
//
// An effect whose field set depends on its mode (mod.source.lfo shows `rate`,
// `period` or `period_beats`) declares the union and hides the rest. In the
// browser the engine answers that per card. Connected to Resolume, the browser
// runs no engine, so the barrel does: it runs each effect's static
// eval_visibility over the instance's state whenever the sketch changes and
// publishes {instance_key: [hidden...]} at /plugins/<key>/state/hidden_fields.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "barrel_bridge_harness.h"
#include "barrel_probe_tex.h"
#include "wasm_paths.h"

using namespace barrel_harness;

namespace {

constexpr int kW = 16;
constexpr int kH = 16;

nlohmann::json lfoSketch(const nlohmann::json& aState, const nlohmann::json& bState) {
  auto entry = [](const char* type, const char* key) {
    return nlohmann::json{{"type", "module"}, {"module_type", type}, {"instance_key", key}};
  };
  auto inst = [](const char* type, const nlohmann::json& st) {
    return nlohmann::json{{"module_type", type}, {"state", st}};
  };
  return {
    {"chain", {entry("mod.source.lfo", "a"), entry("mod.source.lfo", "b"),
               entry("color.tone.brightness_contrast", "bc")}},
    {"instances", {{"a", inst("mod.source.lfo", aState)},
                   {"b", inst("mod.source.lfo", bState)},
                   {"bc", inst("color.tone.brightness_contrast", nlohmann::json::object())}}},
    {"wires", nlohmann::json::array()},
  };
}

using Names = std::vector<std::string>;

}  // namespace

TEST_CASE("the barrel publishes each card's hidden fields to an observing editor",
          "[barrel_render][field_visibility]") {
  // Core only, and none of this machine's module folders.
  const std::string root = tempRoot("nano-visibility");
  const std::string builtin = root + "/builtin", defaults = root + "/default",
                    pathsFile = root + "/module-paths.json";
  for (const auto& d : {root, builtin, defaults}) makeDir(d);
  copyFile(kCoreWasm, builtin + "/core.wasm");
  setEnv("NANO_MODULES_DIR", defaults);
  setEnv("NANO_MODULE_PATHS_FILE", pathsFile);

  Barrel b;
  if (!b.start(builtin, "test-field-visibility")) {
    if (b.device) FAIL("runtime acquired no effects from " << builtin);
    SKIP("no GPU device");
  }
  void* in_tex = barrel_probe::createTexture(b.device, kW, kH);
  void* out_tex = barrel_probe::createTexture(b.device, kW, kH);
  REQUIRE(in_tex);
  REQUIRE(out_tex);

  const std::string path = "/plugins/" + b.key + "/state/hidden_fields";

  // Nobody watching: nothing computed, nothing published.
  b.setSketch(lfoSketch(nlohmann::json::object(), {{"mode", 1}}).dump());
  b.render(in_tex, out_tex, true);
  CHECK(b.get(path).is_null());

  const char* portEnv = getenv("NANO_BRIDGE_PORT");
  Editor editor;
  REQUIRE(editor.connect(portEnv ? atoi(portEnv) : 8081));
  editor.ws.send(nlohmann::json{{"action", "observe"},
                                {"path", "/plugins/" + b.key + "/state"}}.dump());

  // Render until the published set satisfies `ok` (the observe crosses the
  // WebSocket onto the pump, so the first frames may not see it yet).
  auto awaitHidden = [&](bool dirty, auto ok) -> nlohmann::json {
    nlohmann::json h;
    for (int i = 0; i < 200; i++) {
      b.render(in_tex, out_tex, dirty);
      h = b.get(path);
      if (h.is_object() && ok(h)) return h;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return h;
  };

  // A dirty frame once observed: the pending sketch is evaluated.
  auto h = awaitHidden(true, [](const nlohmann::json& j) { return j.contains("a"); });
  INFO(h.dump());
  REQUIRE(h.is_object());
  // `a` has no mode in its state: the default (Freq) shows only `rate`.
  CHECK(h["a"].get<Names>() == Names{"period", "period_beats"});
  // `b` is in Period mode — resolved per card, not per type.
  CHECK(h["b"].get<Names>() == Names{"period_beats", "rate"});
  // brightness_contrast declares no evaluator: no entry, the schema stands.
  CHECK_FALSE(h.contains("bc"));

  // An edit (b → Beats) republishes on its dirty frame.
  b.setSketch(lfoSketch(nlohmann::json::object(), {{"mode", 2}}).dump());
  h = awaitHidden(true, [](const nlohmann::json& j) {
    return j.contains("b") && j["b"].get<Names>() == Names{"period", "rate"};
  });
  INFO(h.dump());
  CHECK(h["b"].get<Names>() == Names{"period", "rate"});
  CHECK(h["a"].get<Names>() == Names{"period", "period_beats"});

  // Removing a card drops its entry.
  b.setSketch(nlohmann::json{
    {"chain", {{{"type", "module"}, {"module_type", "mod.source.lfo"}, {"instance_key", "a"}}}},
    {"instances", {{"a", {{"module_type", "mod.source.lfo"}, {"state", {{"mode", 1}}}}}}},
    {"wires", nlohmann::json::array()}}.dump());
  h = awaitHidden(true, [](const nlohmann::json& j) { return !j.contains("b"); });
  INFO(h.dump());
  CHECK_FALSE(h.contains("b"));
  CHECK(h["a"].get<Names>() == Names{"period_beats", "rate"});

  barrel_probe::releaseTexture(in_tex);
  barrel_probe::releaseTexture(out_tex);
  std::remove((builtin + "/core.wasm").c_str());
#ifdef _WIN32
  for (const auto& d : {builtin, defaults, root}) _rmdir(d.c_str());
#else
  for (const auto& d : {builtin, defaults, root}) ::rmdir(d.c_str());
#endif
}
