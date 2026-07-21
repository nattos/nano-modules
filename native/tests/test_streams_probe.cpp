// test_streams_probe.cpp — the seekable-streams ABI end-to-end through WAMR:
// testonly.streams_probe (a real wasm effect) reads the streams.* imports
// against a StreamsTable built from the shared fixture and republishes what it
// saw; we assert the published mirror. This is the native half of the
// integration contract (web half: the wasm-host streams suite driving the
// same probe against a stub StreamsRegistry).

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "bridge/param_cache.h"
#include "bridge/state_document.h"
#include "sketch/comp/streams_table.h"
#include "wasm/effect_host_sink.h"
#include "wasm/wasm_host.h"

using bridge::ParamCache;
using bridge::StateDocument;
using json = nlohmann::json;
using wasm::WasmEffectDesc;
using wasm::WasmHost;

#ifndef TESTONLY_WASM_PATH
#error "TESTONLY_WASM_PATH must be defined"
#endif
#ifndef COMP_FIXTURES_DIR
#error "COMP_FIXTURES_DIR must be defined"
#endif

namespace {

std::vector<uint8_t> load_file(const char* path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg();
  f.seekg(0);
  std::vector<uint8_t> buf(static_cast<size_t>(size));
  f.read(reinterpret_cast<char*>(buf.data()), size);
  return buf;
}

/** Test sink: only instanceKey() matters (streams.* self-scoping). */
struct KeySink : wasm::EffectHostSink {
  std::string key;
  explicit KeySink(std::string k) : key(std::move(k)) {}
  void hostSetMetadata(std::string, std::string) override {}
  void hostSetSchema(std::string) override {}
  void hostRegisterShaderSpv(std::string_view, const unsigned char*, int,
                             std::string_view, std::string_view) override {}
  int createShaderModuleByName(const std::string&, gpu::GPUBackend*) override { return -1; }
  void hostRegisterWasmFusion(int, std::string, int, int, uint32_t) override {}
  int textureField(const std::string&) const override { return -1; }
  void setTextureField(const std::string&, int) override {}
  int bufferField(const std::string&) const override { return -1; }
  void setBufferField(const std::string&, int) override {}
  bool isInputConnected(const std::string&) const override { return false; }
  bool isOutputConnected(const std::string&) const override { return false; }
  bool willRender() const override { return true; }
  std::string instanceKey() const override { return key; }
};

/** Load testonly.wasm, drive the probe's module_init/create/init once, and
 *  return everything needed to tick it under different stream worlds. */
struct ProbeHarness {
  ParamCache cache;
  WasmHost host{cache};
  StateDocument doc;
  int32_t moduleId = -1;
  const WasmEffectDesc* probe = nullptr;
  uint32_t self = 0;
  std::string pluginKey;

  bool init() {
    auto bytecode = load_file(TESTONLY_WASM_PATH);
    if (bytecode.empty() || !host.init()) return false;
    moduleId = host.load_module(bytecode.data(), bytecode.size());
    if (moduleId < 0) return false;
    host.set_state_doc(moduleId, &doc);
    if (host.call_function(moduleId, "nano_module_main") != 0) return false;
    for (const auto& e : host.registered_effects(moduleId)) {
      if (e.id == "testonly.streams_probe") { probe = &e; break; }
    }
    if (!probe) return false;
    uint32_t argv[8] = {0};
    if (!host.call_indirect(moduleId, probe->fn("module_init"), 0, argv)) return false;
    pluginKey = host.plugin_key(moduleId);
    argv[0] = 0;
    if (!host.call_indirect(moduleId, probe->fn("create"), 0, argv)) return false;
    self = argv[0];
    argv[0] = self;
    return self != 0 && host.call_indirect(moduleId, probe->fn("init"), 1, argv);
  }

  bool tick() {
    uint32_t argv[8] = {0};
    argv[0] = self;
    double dt = 0.016;
    std::memcpy(&argv[1], &dt, sizeof(double));
    return host.call_indirect(moduleId, probe->fn("tick"), 3, argv);
  }

  double seen(const char* field) {
    auto state = doc.get_plugin_state(pluginKey);
    REQUIRE(state.contains(field));
    return state[field].get<double>();
  }
};

json loadFixture(const std::string& name) {
  std::ifstream f(std::string(COMP_FIXTURES_DIR) + "/" + name);
  REQUIRE(f.good());
  json j = json::parse(f, nullptr, false);
  REQUIRE(!j.is_discarded());
  return j;
}

}  // namespace

TEST_CASE("streams probe: session-clock-only world (no registry)", "[streams_probe]") {
  ProbeHarness h;
  REQUIRE(h.init());

  wasm::FrameState fs;
  fs.elapsed_time = 7.25;
  h.host.set_frame_state(h.moduleId, &fs);

  REQUIRE(h.tick());
  CHECK(h.seen("seen_parent_kind") == 1);      // KindSessionClock
  CHECK(h.seen("seen_parent_pos") == 7.25);    // the frame clock
  CHECK(h.seen("seen_parent_playing") == 1);
  CHECK(h.seen("seen_content_kind") == -1);    // no content stream
  CHECK(h.seen("seen_event_count") == 0);
  CHECK(h.seen("seen_rev") == 0);
  CHECK(h.seen("seen_stream_count") == 1);
  // transport_time_sec = rate(1) x parent seconds.
  CHECK(h.seen("transport_time_sec") == 7.25);

  h.host.shutdown();
}

TEST_CASE("streams probe: full registry world through WAMR", "[streams_probe]") {
  ProbeHarness h;
  REQUIRE(h.init());

  // The shared fixture world (test_streams_abi assertions are its spec).
  comp::CompositionM compDoc = comp::parseComposition(loadFixture("streams.json"));
  comp::WarpClock clock(
      comp::WarpCurve(comp::derivedWarpSegments(compDoc), comp::compositionLengthBeats(compDoc)),
      compDoc.baseBPM);
  comp::StreamsTable table = comp::buildStreamsTable(compDoc, clock, 7);
  table.frame.posBeat = 10.0;
  table.frame.posSec = 5.0;
  table.frame.playing = 1;

  wasm::FrameState fs;
  fs.elapsed_time = 99.0;  // must NOT leak through once a registry is attached
  h.host.set_frame_state(h.moduleId, &fs);
  h.host.set_streams_table(h.moduleId, &table, &clock);

  // Scope the probe as a device in clipB's chain.
  KeySink sink("clip_clipB_transport_dev1");
  h.host.set_effect_instance(h.moduleId, &sink);

  REQUIRE(h.tick());
  CHECK(h.seen("seen_parent_kind") == 3);      // KindTimelineTrack (trackA)
  CHECK(h.seen("seen_parent_pos") == 10.0);    // transport beat
  CHECK(h.seen("seen_parent_playing") == 1);
  CHECK(h.seen("seen_content_kind") == 5);     // KindVideoContent
  // clipB 'time' mode anchored at beat 8 → 1 real second in at 120 BPM.
  CHECK(h.seen("seen_content_pos") == Catch::Approx(1.0).margin(1e-9));
  CHECK(h.seen("seen_event_count") == 4);      // start/stop A + start/stop B
  CHECK(h.seen("seen_first_time") == 0.0);
  CHECK(h.seen("seen_first_channel") == -1);   // NaN channel → sentinel
  CHECK(h.seen("seen_rev") == 7);
  CHECK(h.seen("seen_stream_count") == 4);
  CHECK(h.seen("transport_time_sec") == 5.0);  // rate(1) x parent posSec

  // A transport-controller override re-routes the content position 1:1.
  table.appliedContentSec["clipB"] = 3.5;
  REQUIRE(h.tick());
  CHECK(h.seen("seen_content_pos") == 3.5);

  // An effect OUTSIDE any clip (track FX / standalone key) scopes to the
  // session clock even with a registry attached.
  KeySink trackSink("track_t1_dev");
  h.host.set_effect_instance(h.moduleId, &trackSink);
  REQUIRE(h.tick());
  CHECK(h.seen("seen_parent_kind") == 1);
  CHECK(h.seen("seen_content_kind") == -1);

  h.host.shutdown();
}
