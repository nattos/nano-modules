// Unit tests for ClipLauncher — the per-clip re-arm reconcile state machine that
// drives Resolume clips to the desired connected state despite its trigger
// latches (piano stuck-on, Normal-clip connect:false no-op + stuck-off). See
// clip_launcher.h and native/tools/piano_spike_FINDINGS.md.

#include <catch2/catch_test_macros.hpp>

#include <map>
#include <string>
#include <vector>

#include "bridge/clip_launcher.h"
#include "sketch/trigger_bus.h"

using bridge::ClipLauncher;
using bridge::LaunchTarget;

namespace {

struct Cmd { std::string path; bool value; };

struct Harness {
  ClipLauncher launcher;
  std::vector<Cmd> cmds;

  Harness(uint64_t debounce = 100, uint64_t dwell = 50) {
    launcher.set_debounce_ms(debounce);
    launcher.set_rearm_dwell_ms(dwell);
    launcher.set_writer(
        [this](const std::string& p, bool v) { cmds.push_back({p, v}); });
  }

  static trigger_bus::Event ev(int channel, bool on) {
    trigger_bus::Event e;
    e.rail = trigger_bus::kGlobalRail;
    e.channel = channel;
    e.on = on;
    return e;
  }

  // channel N → one clip (id 42): connect path "C", evict path "E".
  static std::map<int, std::vector<LaunchTarget>> clips(
      int channel, bool observed, bool piano = true,
      const std::string& evict = "E", int64_t id = 42) {
    LaunchTarget t;
    t.clip_id = id;
    t.connect_path = "C";
    t.connected_param_id = 1000 + id;
    t.observed_connected = observed;
    t.is_piano = piano;
    t.evict_path = evict;
    return {{channel, {t}}};
  }
};

}  // namespace

TEST_CASE("on event connects a disconnected clip", "[clip_launcher]") {
  Harness h;
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, /*observed=*/false), 1000);
  REQUIRE(h.cmds.size() == 1);
  CHECK(h.cmds[0].path == "C");
  CHECK(h.cmds[0].value == true);
}

TEST_CASE("no command once the clip is observed in the desired state",
          "[clip_launcher]") {
  Harness h;
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, /*observed=*/true), 1000);
  CHECK(h.cmds.empty());
}

TEST_CASE("want-on escalates to a re-arm (false,true) when connect doesn't take",
          "[clip_launcher]") {
  Harness h(/*debounce=*/100);
  // t=1000: first attempt = plain connect.
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, false), 1000);
  REQUIRE(h.cmds.size() == 1);
  CHECK(h.cmds[0].value == true);
  // t=1050: within debounce, still off → no resend.
  h.launcher.tick({}, Harness::clips(1, false), 1050);
  CHECK(h.cmds.size() == 1);
  // t=1150: still off, debounce elapsed → re-arm: connect:false then connect:true
  // (clears a stuck-off latch, then connects).
  h.launcher.tick({}, Harness::clips(1, false), 1150);
  REQUIRE(h.cmds.size() == 3);
  CHECK(h.cmds[1].value == false);
  CHECK(h.cmds[2].value == true);
  // t=1300: now connected → stop.
  h.launcher.tick({}, Harness::clips(1, true), 1300);
  CHECK(h.cmds.size() == 3);
}

TEST_CASE("piano off: gated disconnect while observed connected",
          "[clip_launcher]") {
  Harness h(/*debounce=*/100);
  // Connect it first.
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, false), 1000);
  h.launcher.tick({}, Harness::clips(1, true), 1100);
  h.cmds.clear();
  // Off edge, observed connected → single disconnect.
  h.launcher.tick({Harness::ev(1, false)}, Harness::clips(1, /*observed=*/true), 1200);
  REQUIRE(h.cmds.size() == 1);
  CHECK(h.cmds[0].path == "C");
  CHECK(h.cmds[0].value == false);
  // It releases → converged, no more commands.
  h.launcher.tick({}, Harness::clips(1, false), 1300);
  CHECK(h.cmds.size() == 1);
}

TEST_CASE("piano off stuck-on: re-arm connect, dwell, then disconnect",
          "[clip_launcher]") {
  Harness h(/*debounce=*/100, /*dwell=*/50);
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, false), 1000);
  h.launcher.tick({}, Harness::clips(1, true), 1100);
  h.cmds.clear();
  // Off edge; clip is stuck-on (observed stays true).
  h.launcher.tick({Harness::ev(1, false)}, Harness::clips(1, true), 1200);
  REQUIRE(h.cmds.size() == 1);
  CHECK(h.cmds[0].value == false);  // simple disconnect (dropped by Resolume)
  // Debounce elapses, still stuck → re-arm connect.
  h.launcher.tick({}, Harness::clips(1, true), 1310);
  REQUIRE(h.cmds.size() == 2);
  CHECK(h.cmds[1].value == true);   // re-arm connect
  // Within the dwell → nothing yet.
  h.launcher.tick({}, Harness::clips(1, true), 1330);
  CHECK(h.cmds.size() == 2);
  // Dwell elapsed → deferred disconnect (now the clip is re-armed).
  h.launcher.tick({}, Harness::clips(1, true), 1370);
  REQUIRE(h.cmds.size() == 3);
  CHECK(h.cmds[2].value == false);
  // Releases → done.
  h.launcher.tick({}, Harness::clips(1, false), 1500);
  CHECK(h.cmds.size() == 3);
}

TEST_CASE("normal off: evict via the empty clip, never connect:false",
          "[clip_launcher]") {
  Harness h(/*debounce=*/100);
  // Connect a NORMAL clip.
  h.launcher.tick({Harness::ev(1, true)},
                  Harness::clips(1, false, /*piano=*/false), 1000);
  h.launcher.tick({}, Harness::clips(1, true, /*piano=*/false), 1100);
  h.cmds.clear();
  // Off edge → evict (connect the empty clip "E"), NOT connect:false on "C".
  h.launcher.tick({Harness::ev(1, false)},
                  Harness::clips(1, true, /*piano=*/false), 1200);
  REQUIRE(h.cmds.size() == 1);
  CHECK(h.cmds[0].path == "E");
  CHECK(h.cmds[0].value == true);
}

TEST_CASE("normal on stuck-off: escalates to a re-arm", "[clip_launcher]") {
  Harness h(/*debounce=*/100);
  h.launcher.tick({Harness::ev(1, true)},
                  Harness::clips(1, false, /*piano=*/false), 1000);
  REQUIRE(h.cmds.size() == 1);  // plain connect
  // Still off (stuck-off) after debounce → re-arm (false, true).
  h.launcher.tick({}, Harness::clips(1, false, /*piano=*/false), 1150);
  REQUIRE(h.cmds.size() == 3);
  CHECK(h.cmds[1].value == false);
  CHECK(h.cmds[2].value == true);
}

TEST_CASE("normal off with no empty clip issues nothing", "[clip_launcher]") {
  Harness h(/*debounce=*/100);
  h.launcher.tick({Harness::ev(1, true)},
                  Harness::clips(1, false, /*piano=*/false, /*evict=*/""), 1000);
  h.launcher.tick({}, Harness::clips(1, true, /*piano=*/false, /*evict=*/""), 1100);
  h.cmds.clear();
  h.launcher.tick({Harness::ev(1, false)},
                  Harness::clips(1, true, /*piano=*/false, /*evict=*/""), 1200);
  CHECK(h.cmds.empty());  // cannot disconnect a Normal clip with no evict target
}

TEST_CASE("an event on an unmapped channel does nothing", "[clip_launcher]") {
  Harness h;
  h.launcher.tick({Harness::ev(7, true)}, Harness::clips(1, false), 1000);
  CHECK(h.cmds.empty());
}

TEST_CASE("one event fans out to every clip on the channel", "[clip_launcher]") {
  Harness h;
  LaunchTarget a, b;
  a.clip_id = 1; a.connect_path = "A"; a.observed_connected = false; a.is_piano = true;
  b.clip_id = 2; b.connect_path = "B"; b.observed_connected = false; b.is_piano = true;
  std::map<int, std::vector<LaunchTarget>> clips = {{3, {a, b}}};
  h.launcher.tick({Harness::ev(3, true)}, clips, 1000);
  REQUIRE(h.cmds.size() == 2);
  CHECK(h.cmds[0].value == true);
  CHECK(h.cmds[1].value == true);
}
