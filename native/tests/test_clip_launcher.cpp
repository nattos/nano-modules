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

TEST_CASE("piano off stuck-on with an empty clip: escalates via eviction",
          "[clip_launcher]") {
  Harness h(/*debounce=*/100);
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, false), 1000);
  h.launcher.tick({}, Harness::clips(1, true), 1100);
  h.cmds.clear();
  // Off edge; stuck-on. First = gated disconnect.
  h.launcher.tick({Harness::ev(1, false)}, Harness::clips(1, true), 1200);
  REQUIRE(h.cmds.size() == 1);
  CHECK(h.cmds[0].path == "C");
  CHECK(h.cmds[0].value == false);
  // Still stuck after debounce → escalate by EVICTING (connect "E"), never by
  // re-connecting the target (which would oscillate).
  h.launcher.tick({}, Harness::clips(1, true), 1310);
  REQUIRE(h.cmds.size() == 2);
  CHECK(h.cmds[1].path == "E");
  CHECK(h.cmds[1].value == true);
  // Note: no command re-connects "C" — the escalation cannot toggle the clip.
  for (const auto& c : h.cmds) CHECK_FALSE((c.path == "C" && c.value == true));
}

TEST_CASE("piano off stuck-on, no empty clip: re-arm toggle",
          "[clip_launcher]") {
  Harness h(/*debounce=*/100, /*dwell=*/50);
  h.launcher.tick({Harness::ev(1, true)},
                  Harness::clips(1, false, /*piano=*/true, /*evict=*/""), 1000);
  h.launcher.tick({}, Harness::clips(1, true, true, ""), 1100);
  h.cmds.clear();
  h.launcher.tick({Harness::ev(1, false)}, Harness::clips(1, true, true, ""), 1200);
  REQUIRE(h.cmds.size() == 1);
  CHECK(h.cmds[0].value == false);  // simple disconnect
  h.launcher.tick({}, Harness::clips(1, true, true, ""), 1310);
  REQUIRE(h.cmds.size() == 2);
  CHECK(h.cmds[1].value == true);   // re-arm connect (last-resort toggle)
  h.launcher.tick({}, Harness::clips(1, true, true, ""), 1330);
  CHECK(h.cmds.size() == 2);        // within dwell
  h.launcher.tick({}, Harness::clips(1, true, true, ""), 1370);
  REQUIRE(h.cmds.size() == 3);
  CHECK(h.cmds[2].value == false);  // deferred disconnect after dwell
}

TEST_CASE("gives up after max attempts (bounds oscillation)", "[clip_launcher]") {
  Harness h(/*debounce=*/10);
  h.launcher.set_max_attempts(4);
  // Observed never converges (always disconnected while we want it on) — a
  // wrong/laggy observed. Drive many ticks; the launcher must stop, not spin.
  h.launcher.tick({Harness::ev(1, true)}, Harness::clips(1, false), 1000);
  for (uint64_t t = 1020; t < 2000; t += 20)
    h.launcher.tick({}, Harness::clips(1, false), t);
  // 4 attempts: 1 plain connect + 3 re-arms (each 2 cmds) = 1 + 6 = 7 commands,
  // then it gives up — bounded, not unbounded.
  CHECK(h.cmds.size() <= 7);
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

// ── fireOnce: best-effort single edge, no reconcile/retry state ───────────────

TEST_CASE("fireOnce issues a one-shot connect and tracks nothing",
          "[clip_launcher]") {
  Harness h;
  // Even though observed is already ON (which tick() would treat as converged →
  // no command), fireOnce is unconditional best-effort — it just punches.
  h.launcher.fireOnce({Harness::ev(1, true)}, Harness::clips(1, /*observed=*/true));
  REQUIRE(h.cmds.size() == 1);
  CHECK(h.cmds[0].path == "C");
  CHECK(h.cmds[0].value == true);
  // No desired/recon state recorded: a following tick with the clip observed OFF
  // does NOT re-drive it (fireOnce never set a desire), so no extra command.
  h.cmds.clear();
  h.launcher.tick({}, Harness::clips(1, /*observed=*/false), 2000);
  CHECK(h.cmds.empty());
}

// ── planStrict: the pure strict-queue fold ───────────────────────────────────

namespace {
trigger_bus::Event strictEv(uint64_t seq, int channel, bool on, uint32_t deadline) {
  trigger_bus::Event e;
  e.seq = seq;
  e.rail = trigger_bus::kGlobalRail;
  e.channel = channel;
  e.on = on;
  e.strict = true;
  e.deadline_ms = deadline;
  return e;
}
}  // namespace

TEST_CASE("planStrict passes non-strict events straight through", "[strict]") {
  std::vector<bridge::StrictPending> pending;
  auto plan = bridge::planStrict({Harness::ev(1, true)}, pending,
                                 /*now_ms=*/1000, /*present_seq=*/10);
  CHECK(plan.reconcile.size() == 1);
  CHECK(plan.best_effort.empty());
  CHECK(pending.empty());  // "any" never queues
}

TEST_CASE("planStrict holds a strict event until a frame is presented",
          "[strict]") {
  std::vector<bridge::StrictPending> pending;

  // Enqueue at present_seq=10 — held (nothing reconciles this tick).
  auto p0 = bridge::planStrict({strictEv(1, 3, true, 120)}, pending,
                               /*now_ms=*/1000, /*present_seq=*/10);
  CHECK(p0.reconcile.empty());
  CHECK(p0.best_effort.empty());
  REQUIRE(pending.size() == 1);

  // Same frame (present_seq still 10), before the deadline → still held.
  auto p1 = bridge::planStrict({}, pending, /*now_ms=*/1005, /*present_seq=*/10);
  CHECK(p1.reconcile.empty());
  REQUIRE(pending.size() == 1);

  // A frame has been presented (present_seq advanced) → release + full reconcile.
  auto p2 = bridge::planStrict({}, pending, /*now_ms=*/1020, /*present_seq=*/11);
  REQUIRE(p2.reconcile.size() == 1);
  CHECK(p2.reconcile[0].seq == 1);
  CHECK(p2.best_effort.empty());
  CHECK(pending.empty());
}

TEST_CASE("planStrict deadline flushes all, reconciling only the newest",
          "[strict]") {
  std::vector<bridge::StrictPending> pending;

  // Three strict events pile up while no frame is presented (present_seq stuck).
  bridge::planStrict({strictEv(1, 3, true, 100)}, pending, 1000, /*present=*/5);
  bridge::planStrict({strictEv(2, 3, true, 100)}, pending, 1030, /*present=*/5);
  bridge::planStrict({strictEv(3, 4, true, 100)}, pending, 1060, /*present=*/5);
  REQUIRE(pending.size() == 3);

  // At now=1101 the oldest (arrived 1000, deadline 100) has expired → flush all.
  auto plan = bridge::planStrict({}, pending, /*now_ms=*/1101, /*present=*/5);
  // Newest = seq 3 → full reconcile; the other two → best-effort.
  REQUIRE(plan.reconcile.size() == 1);
  CHECK(plan.reconcile[0].seq == 3);
  REQUIRE(plan.best_effort.size() == 2);
  CHECK(plan.best_effort[0].seq == 1);
  CHECK(plan.best_effort[1].seq == 2);
  CHECK(pending.empty());  // queue drained
}
