// test_trigger_probe.cpp — the event-out host imports, driven through the real
// WAMR host by debug.trigger_probe (testonly):
//
//   host.trigger_audio              → audio_bus, tagged with the firing
//                                     instance's key
//   resolume.trigger_clip           → links and returns (no host sink yet)
//   state.console_log_structured    → the runtime's console log
//
// These used to be exercised only by control.nanolooper, which lives in the
// extras repository now; our own coverage must not depend on it.

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <utility>
#include <vector>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/wasm_bundles.h"
#include "wasm/audio_bus.h"

#include "wasm_paths.h"

namespace {

struct Capture {
  std::vector<std::pair<std::string, int>> events;
};

void capture(void* ud, const char* key, int channel) {
  static_cast<Capture*>(ud)->events.emplace_back(key ? key : "", channel);
}

int countContaining(const std::vector<std::string>& lines, const std::string& s) {
  int n = 0;
  for (const auto& l : lines)
    if (l.find(s) != std::string::npos) ++n;
  return n;
}

}  // namespace

TEST_CASE("trigger_probe fires audio, clip and a structured log on each rising edge",
          "[trigger_probe]") {
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device available");
  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  effect_runtime::EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(kTestonlyWasm, registry, backend.get(), nullptr) > 1);

  auto* inst = rt.instanceFor("debug.trigger_probe", "probe@0");
  REQUIRE(inst);
  rt.drainConsoleLog();

  Capture cap;
  const uint64_t token = audio_bus::add(capture, &cap);
  REQUIRE(token != 0);

  inst->setParamFloat("channel", 5);
  // off → on (fire) → on (held: no re-fire) → off → on (fire)
  for (float fire : {0.0f, 1.0f, 1.0f, 0.0f, 1.0f}) {
    inst->setParamFloat("fire", fire);
    inst->doTick(1.0 / 60.0);
  }
  audio_bus::remove(token);

  REQUIRE(cap.events.size() == 2);
  for (const auto& [key, channel] : cap.events) {
    CHECK(channel == 5);
    // Tagged with the instance that fired, so one looper's synth hears only
    // its own triggers.
    CHECK(key.find("probe@0") != std::string::npos);
  }

  const auto logs = rt.drainConsoleLog();
  INFO("console log:\n" << [&] {
    std::string all;
    for (const auto& l : logs) all += l + "\n";
    return all;
  }());
  CHECK(countContaining(logs, "trigger_probe: fired") == 2);
}
