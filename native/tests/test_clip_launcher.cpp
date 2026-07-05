// Unit tests for ClipLauncher — the trigger-event → Resolume-clip-launch
// reconcile loop that works around the "piano-trigger stuck-on" bug.

#include <catch2/catch_test_macros.hpp>

#include <map>
#include <string>
#include <vector>

#include "bridge/clip_launcher.h"
#include "sketch/trigger_bus.h"

using bridge::ClipLauncher;
using bridge::LaunchTarget;

namespace {

struct Cmd { int64_t clip_id; bool on; };

// A launcher wired to capture its commands, with a helper to build the
// channel→clips map for one clip on one channel + a given observed state.
struct Harness {
  ClipLauncher launcher;
  std::vector<Cmd> cmds;

  Harness(uint64_t debounce = 100) {
    launcher.set_debounce_ms(debounce);
    launcher.set_writer([this](const LaunchTarget& t, bool on) {
      cmds.push_back({t.clip_id, on});
    });
  }

  static trigger_bus::Event ev(int channel, bool on) {
    trigger_bus::Event e;
    e.rail = trigger_bus::kGlobalRail;
    e.channel = channel;
    e.on = on;
    return e;
  }

  // channel N → one clip (id 42) whose observed connected state is `observed`.
  static std::map<int, std::vector<LaunchTarget>> clips(int channel, bool observed,
                                                        int64_t id = 42) {
    LaunchTarget t;
    t.clip_id = id;
    t.connect_path = "/composition/layers/0/clips/0/connect";
    t.connected_param_id = 1000 + id;
    t.observed_connected = observed;
    return {{channel, {t}}};
  }
};

}  // namespace

TEST_CASE("an on event connects a matching disconnected clip", "[clip_launcher]") {
  Harness h;
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, /*observed=*/false), 1000);
  REQUIRE(h.cmds.size() == 1);
  CHECK(h.cmds[0].clip_id == 42);
  CHECK(h.cmds[0].on == true);
}

TEST_CASE("no command once the clip is observed in the desired state",
          "[clip_launcher]") {
  Harness h;
  // Desired on; clip already connected → nothing to do.
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, /*observed=*/true), 1000);
  CHECK(h.cmds.empty());
}

TEST_CASE("reconcile resends after the debounce until observed matches",
          "[clip_launcher]") {
  Harness h(/*debounce=*/100);
  // t=1000: connect issued.
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, false), 1000);
  REQUIRE(h.cmds.size() == 1);
  // t=1050: still disconnected, within debounce → no resend.
  h.launcher.tick({}, Harness::clips(1, false), 1050);
  CHECK(h.cmds.size() == 1);
  // t=1150: still disconnected, debounce elapsed → resend.
  h.launcher.tick({}, Harness::clips(1, false), 1150);
  REQUIRE(h.cmds.size() == 2);
  CHECK(h.cmds[1].on == true);
  // t=1300: now observed connected → stop.
  h.launcher.tick({}, Harness::clips(1, true), 1300);
  CHECK(h.cmds.size() == 2);
}

TEST_CASE("an off event keeps driving disconnect (piano-trigger fix)",
          "[clip_launcher]") {
  Harness h(/*debounce=*/100);
  // Get it connected first (desired on, observed becomes true).
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, false), 1000);
  h.launcher.tick({}, Harness::clips(1, true), 1100);
  h.cmds.clear();

  // Off edge: desired disconnect. Resolume is "stuck on" (observed stays true),
  // so we keep issuing disconnect every debounce until it releases.
  h.launcher.tick({Harness::ev(1, false)}, Harness::clips(1, true), 1200);
  REQUIRE(h.cmds.size() == 1);
  CHECK(h.cmds[0].on == false);
  h.launcher.tick({}, Harness::clips(1, true), 1350);  // still stuck → resend
  REQUIRE(h.cmds.size() == 2);
  CHECK(h.cmds[1].on == false);
  // Finally releases.
  h.launcher.tick({}, Harness::clips(1, false), 1500);
  CHECK(h.cmds.size() == 2);
}

TEST_CASE("an event on an unmapped channel does nothing", "[clip_launcher]") {
  Harness h;
  h.launcher.tick({Harness::ev(7, true)}, Harness::clips(1, false), 1000);
  CHECK(h.cmds.empty());
}

TEST_CASE("one event fans out to every clip on the channel", "[clip_launcher]") {
  Harness h;
  LaunchTarget a, b;
  a.clip_id = 1; a.connect_path = "/composition/layers/0/clips/0/connect"; a.observed_connected = false;
  b.clip_id = 2; b.connect_path = "/composition/layers/1/clips/0/connect"; b.observed_connected = false;
  std::map<int, std::vector<LaunchTarget>> clips = {{3, {a, b}}};
  h.launcher.tick({Harness::ev(3, true)}, clips, 1000);
  REQUIRE(h.cmds.size() == 2);
  CHECK(h.cmds[0].on == true);
  CHECK(h.cmds[1].on == true);
}
