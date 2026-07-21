// test_streams_abi.cpp — the seekable-streams registry (streams_table.h):
// handle derivation, enumeration shape, event derivation/ordering, scene
// channel/ordinal mapping, and the lazy content-position eval. The fixture
// (fixtures/comp/streams.json) is shared with the web StreamsRegistry twin
// (streams-goldens.test.ts) — assertions here are the lock-step contract.

#include "sketch/comp/streams_table.h"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <cmath>
#include <fstream>
#include <string>

#include <nlohmann/json.hpp>

using Catch::Matchers::WithinAbs;
using json = nlohmann::json;

namespace {

constexpr double kTol = 1e-9;

json loadFixture(const std::string& name) {
  const std::string path = std::string(COMP_FIXTURES_DIR) + "/" + name;
  std::ifstream f(path);
  REQUIRE(f.good());
  json j = json::parse(f, nullptr, false);
  REQUIRE(!j.is_discarded());
  return j;
}

struct Built {
  comp::CompositionM doc;
  comp::WarpClock clock;
  comp::StreamsTable table;
};

Built build() {
  Built b{comp::parseComposition(loadFixture("streams.json")),
          comp::WarpClock(comp::WarpCurve({}, 0), 120), {}};
  // Mirrors CompExecutor::rebuildClock.
  b.clock = comp::WarpClock(
      comp::WarpCurve(comp::derivedWarpSegments(b.doc), comp::compositionLengthBeats(b.doc)),
      b.doc.baseBPM);
  b.table = comp::buildStreamsTable(b.doc, b.clock, 7);
  return b;
}

const comp::StreamInfo& streamOf(const comp::StreamsTable& t, int64_t h) {
  const comp::StreamInfo* s = t.find(h);
  REQUIRE(s != nullptr);
  return *s;
}

}  // namespace

TEST_CASE("handles are deterministic, identity-derived, MSB-tagged", "[streams]") {
  const int64_t h1 = comp::streamHandleOf("track:trackA");
  CHECK(h1 == comp::streamHandleOf("track:trackA"));
  CHECK(h1 != comp::streamHandleOf("track:scenes"));
  CHECK(h1 != comp::streamHandleOf("content:trackA"));
  // MSB forced 1 ⇒ negative as i64, never colliding with reserved 0/1/2.
  CHECK(h1 < 0);
  CHECK(comp::streamHandleOf("") < 0);
}

TEST_CASE("registry enumeration: clocks + timeline + Track/Scene tracks only", "[streams]") {
  Built b = build();
  const auto& t = b.table;
  CHECK(t.docRev == 7);
  // [session clock, timeline, trackA, scenes] — the group is excluded.
  REQUIRE(t.enumCount == 4);
  CHECK(t.streams[0].handle == comp::kStreamSessionClock);
  CHECK(t.streams[0].kind == comp::kStreamKindSessionClock);
  CHECK(t.streams[0].flags == comp::kStreamLiveOnly);
  CHECK(t.streams[0].axis == comp::kStreamAxisSeconds);
  CHECK(t.streams[0].durationPrimary == -1);

  CHECK(t.streams[1].handle == comp::kStreamTimeline);
  CHECK(t.streams[1].kind == comp::kStreamKindTimeline);
  CHECK(t.streams[1].axis == comp::kStreamAxisBeats);
  CHECK(t.streams[1].flags == (comp::kStreamSeekInstant | comp::kStreamFinite));
  // compositionLengthBeats floors at 64; 120 BPM ⇒ 0.5 s/beat.
  CHECK_THAT(t.streams[1].durationPrimary, WithinAbs(64.0, kTol));
  CHECK_THAT(t.streams[1].durationSec, WithinAbs(32.0, kTol));

  const auto& trackA = t.streams[2];
  CHECK(trackA.handle == comp::streamHandleOf("track:trackA"));
  CHECK(trackA.kind == comp::kStreamKindTimelineTrack);
  CHECK(trackA.axis == comp::kStreamAxisBeats);
  CHECK(trackA.flags == (comp::kStreamHasEvents | comp::kStreamTriggerOnSeek |
                         comp::kStreamSeekInstant | comp::kStreamFinite));
  CHECK(trackA.name == "Video A");
  CHECK(trackA.clipCount == 3);
  CHECK_THAT(trackA.durationPrimary, WithinAbs(16.0, kTol));  // clipC ends at 16
  CHECK_THAT(trackA.durationSec, WithinAbs(8.0, kTol));

  const auto& scenes = t.streams[3];
  CHECK(scenes.kind == comp::kStreamKindSceneTrack);
  CHECK(scenes.axis == comp::kStreamAxisOrdinal);
  CHECK(scenes.flags == (comp::kStreamHasEvents | comp::kStreamTriggerOnSeek));
  CHECK_THAT(scenes.durationPrimary, WithinAbs(3.0, kTol));
  CHECK(scenes.durationSec == -1);

  // Every clip resolves its parent track stream.
  CHECK(t.parentByClipId.at("clipA") == trackA.handle);
  CHECK(t.parentByClipId.at("clipC") == trackA.handle);
  CHECK(t.parentByClipId.at("s3") == scenes.handle);
}

TEST_CASE("timeline-track events: grid order, stop-before-start ties, bypass skip",
          "[streams]") {
  Built b = build();
  const auto& s = streamOf(b.table, comp::streamHandleOf("track:trackA"));
  // Doc order is [clipB, clipA, clipC]; GRID order (startBeat) is
  // [clipA(ord 0, 0..8), clipB(ord 1, 8..12), clipC(ord 2, bypassed → no events)].
  REQUIRE(s.events.size() == 4);
  const auto& ev = s.events;
  CHECK(ev[0].time == 0.0);
  CHECK(ev[0].kind == 0);
  CHECK(ev[0].clipOrdinal == 0);
  // The tie at beat 8: clipA's STOP sorts before clipB's START.
  CHECK(ev[1].time == 8.0);
  CHECK(ev[1].kind == 1);
  CHECK(ev[1].clipOrdinal == 0);
  CHECK(ev[2].time == 8.0);
  CHECK(ev[2].kind == 0);
  CHECK(ev[2].clipOrdinal == 1);
  CHECK(ev[3].time == 12.0);
  CHECK(ev[3].kind == 1);
  CHECK(ev[3].clipOrdinal == 1);
  // Identity hashes: stable per clip, exact-in-f64 48-bit values.
  CHECK(ev[0].idHash48 == comp::clipIdHash48("clipA"));
  CHECK(ev[2].idHash48 == comp::clipIdHash48("clipB"));
  CHECK(ev[0].idHash48 != ev[2].idHash48);
  CHECK(ev[0].idHash48 < 281474976710656.0);  // 2^48
  // Non-scene events carry NaN channels.
  CHECK(std::isnan(ev[0].channel));
}

TEST_CASE("scene-track events: ordinal axis, lock-step channels, empty-scene skip",
          "[streams]") {
  Built b = build();
  const auto& s = streamOf(b.table, comp::streamHandleOf("track:scenes"));
  // s1 explicit ch3; s2 auto → 1 (lowest unclaimed); s3 EMPTY → no event but
  // still occupies ordinal 2 (ordinals index the full grid list).
  REQUIRE(s.events.size() == 2);
  CHECK(s.events[0].time == 0.0);
  CHECK(s.events[0].kind == 0);
  CHECK(s.events[0].clipOrdinal == 0);
  CHECK(s.events[0].channel == 3.0);
  CHECK(s.events[1].time == 1.0);
  CHECK(s.events[1].clipOrdinal == 1);
  CHECK(s.events[1].channel == 1.0);
}

TEST_CASE("content streams: per video-backed clip, seek-cost classified", "[streams]") {
  Built b = build();
  const auto& t = b.table;
  // clipA (a still), clipB, s2 — clipC/s1/s3 have no source.
  CHECK(t.contentByClipId.size() == 3);
  CHECK(t.contentByClipId.count("clipC") == 0);

  const auto& still = streamOf(t, t.contentByClipId.at("clipA"));
  CHECK(still.kind == comp::kStreamKindVideoContent);
  CHECK(still.axis == comp::kStreamAxisSeconds);
  CHECK(still.index == -1);  // content streams are not enumerated
  CHECK((still.flags & comp::kStreamSeekInstant) != 0);
  CHECK(still.frameCount == 1);

  const auto& vid = streamOf(t, t.contentByClipId.at("clipB"));
  CHECK((vid.flags & comp::kStreamSeekSlow) != 0);
  CHECK((vid.flags & comp::kStreamFinite) != 0);
  CHECK(vid.frameCount == 120);
  CHECK_THAT(vid.fps, WithinAbs(30.0, kTol));
  CHECK_THAT(vid.durationSec, WithinAbs(4.0, kTol));
  CHECK_THAT(vid.anchorBeat, WithinAbs(8.0, kTol));
  CHECK(vid.name == "B");
  CHECK(vid.ownerId == "clipB");
}

TEST_CASE("content position: lazy clip-time mapping, override wins, NaN off-ends",
          "[streams]") {
  Built b = build();
  auto& t = b.table;
  const auto& vid = streamOf(t, t.contentByClipId.at("clipB"));

  // 'time' mode, speed 1, anchored at beat 8: two beats past the anchor at
  // 120 BPM is one real second into the slice.
  t.frame.posBeat = 10.0;
  CHECK_THAT(comp::contentPosSec(vid, t, b.clock), WithinAbs(1.0, kTol));

  // A transport-controller override beats the built-in mapping.
  t.appliedContentSec["clipB"] = 2.75;
  CHECK_THAT(comp::contentPosSec(vid, t, b.clock), WithinAbs(2.75, kTol));
  t.appliedContentSec.clear();

  // A still shows source second 0 for its whole span.
  const auto& still = streamOf(t, t.contentByClipId.at("clipA"));
  t.frame.posBeat = 2.0;
  CHECK_THAT(comp::contentPosSec(still, t, b.clock), WithinAbs(0.0, kTol));
}

TEST_CASE("clip refs: standard duration, grid slots, ordinal lookup", "[streams]") {
  Built b = build();
  const auto& scenes = streamOf(b.table, comp::streamHandleOf("track:scenes"));
  // byOrdinal inverts the grid order: s1(0), s2(4), s3(8) at 4 beats/bar.
  REQUIRE(scenes.byOrdinalClipId.size() == 3);
  CHECK(scenes.byOrdinalClipId[0] == "s1");
  CHECK(scenes.byOrdinalClipId[1] == "s2");
  CHECK(scenes.byOrdinalClipId[2] == "s3");
  // Grid slots = startBeat / timeSignature numerator (default 4).
  CHECK_THAT(scenes.clipsById.at("s1").gridSlot, WithinAbs(0.0, kTol));
  CHECK_THAT(scenes.clipsById.at("s2").gridSlot, WithinAbs(1.0, kTol));
  CHECK_THAT(scenes.clipsById.at("s3").gridSlot, WithinAbs(2.0, kTol));
  // Standard duration: s2 is video (60f @ 30fps → 2 s slice at speed 1);
  // s1/s3 are effect-only (lengthBeat 4 at 120 BPM → 2 s).
  CHECK_THAT(scenes.clipsById.at("s2").stdDurationSec, WithinAbs(2.0, kTol));
  CHECK_THAT(scenes.clipsById.at("s1").stdDurationSec, WithinAbs(2.0, kTol));
  // The video slice honors endSec−startSec ÷ |speed| when present: clipB has
  // no endSec → 120f/30 = 4 s at speed 1.
  const auto& trackA = streamOf(b.table, comp::streamHandleOf("track:trackA"));
  CHECK_THAT(trackA.clipsById.at("clipB").stdDurationSec, WithinAbs(4.0, kTol));
}

TEST_CASE("scene-track pos() clamps strictly below the next ordinal", "[streams]") {
  Built b = build();
  auto& t = b.table;
  comp::StreamInfo* s = t.findMutable(comp::streamHandleOf("track:scenes"));
  REQUIRE(s != nullptr);
  s->liveOrdinal = 1;         // s2 playing
  s->liveAnchorBeat = 10;
  s->liveLengthBeat = 4;
  t.frame.posBeat = 100;      // way past the grid cell — the NORMAL state
  const double pos = comp::streamPos(*s, t, b.clock, 0);
  CHECK(pos < 2.0);
  CHECK(std::floor(pos) == 1.0);  // still THIS scene's ordinal
  t.frame.posBeat = 10;           // launch instant: fraction exactly 0
  CHECK_THAT(comp::streamPos(*s, t, b.clock, 0), WithinAbs(1.0, kTol));
}

TEST_CASE("streamsTableJson matches the committed golden (web twin replays it)",
          "[streams]") {
  // NATIVE is the reference implementation for the streams registry (the
  // inverse of the comp-goldens direction): NANO_UPDATE_GOLDENS=1 regenerates
  // fixtures/comp/streams-golden.json; the web StreamsRegistry test
  // (streams-registry.test.ts) replays the SAME file.
  Built b = build();
  const std::string path = std::string(COMP_FIXTURES_DIR) + "/streams-golden.json";
  const json produced = json::parse(comp::streamsTableJson(b.table), nullptr, false);
  if (std::getenv("NANO_UPDATE_GOLDENS")) {
    std::ofstream out(path);
    out << produced.dump(2) << "\n";
  }
  std::ifstream f(path);
  REQUIRE(f.good());  // missing ⇒ run NANO_UPDATE_GOLDENS=1 ./test_streams_abi
  const json stored = json::parse(f, nullptr, false);
  REQUIRE(!stored.is_discarded());
  CHECK(produced == stored);
}

TEST_CASE("streamsTableJson: static registry round-trips for the web twin", "[streams]") {
  Built b = build();
  const json j = json::parse(comp::streamsTableJson(b.table), nullptr, false);
  REQUIRE(j.is_object());
  CHECK(j["docRev"] == 7);
  CHECK(j["enumCount"] == 4);
  REQUIRE(j["streams"].is_array());
  CHECK(j["streams"].size() == b.table.streams.size());
  // Handles serialize as unsigned-decimal strings (> 2^53 territory).
  const std::string trackAHandle =
      std::to_string(static_cast<uint64_t>(comp::streamHandleOf("track:trackA")));
  bool sawTrackA = false;
  for (const auto& s : j["streams"]) {
    if (s["handle"] != trackAHandle) continue;
    sawTrackA = true;
    CHECK(s["kind"] == comp::kStreamKindTimelineTrack);
    REQUIRE(s["events"].is_array());
    CHECK(s["events"].size() == 4);
    // Event tuple: [time, kind, ordinal, idHash48, channel|null].
    const auto& ev = s["events"][0];
    CHECK(ev[0] == 0.0);
    CHECK(ev[1] == 0);
    CHECK(ev[2] == 0);
    CHECK(ev[4].is_null());  // NaN channel → null
  }
  CHECK(sawTrackA);
  // Content streams carry the lazy-eval context for the web registry.
  const std::string contentHandle =
      std::to_string(static_cast<uint64_t>(b.table.contentByClipId.at("clipB")));
  CHECK(j["contentByClipId"]["clipB"] == contentHandle);
  for (const auto& s : j["streams"]) {
    if (s["handle"] != contentHandle) continue;
    CHECK(s["loop"].is_object());
    CHECK(s["anchorBeat"] == 8.0);
    CHECK(s["videoDurSec"] == 4.0);
    CHECK(s.contains("seed"));
  }
}
