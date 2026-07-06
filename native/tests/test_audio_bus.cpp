// test_audio_bus.cpp — the process-global audio-trigger fan-out used to route
// control.nanolooper's host.trigger_audio to native Synth listeners. Covers
// add/remove/token semantics, fan-out to all listeners, and the thread-safety
// guarantee (concurrent add/remove while another thread fires).

#include <catch2/catch_test_macros.hpp>

#include "wasm/audio_bus.h"

#include <atomic>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

struct Capture {
  std::vector<std::pair<std::string, int>> events;
};

void capture_cb(void* ud, const char* key, int ch) {
  auto* c = static_cast<Capture*>(ud);
  c->events.emplace_back(key ? key : "", ch);
}

std::atomic<int> g_counter{0};
void counting_cb(void*, const char*, int) {
  g_counter.fetch_add(1, std::memory_order_relaxed);
}

}  // namespace

TEST_CASE("audio_bus fans out to every listener and filters by token", "[audio_bus]") {
  Capture a, b;
  uint64_t ta = audio_bus::add(capture_cb, &a);
  uint64_t tb = audio_bus::add(capture_cb, &b);
  REQUIRE(ta != 0);
  REQUIRE(tb != 0);
  REQUIRE(ta != tb);

  audio_bus::fire("key/looper", 2);
  REQUIRE(a.events.size() == 1);
  REQUIRE(b.events.size() == 1);
  CHECK(a.events[0].first == "key/looper");
  CHECK(a.events[0].second == 2);
  CHECK(b.events[0].first == "key/looper");

  // Removing one leaves the other receiving.
  audio_bus::remove(ta);
  audio_bus::fire("key/looper", 3);
  CHECK(a.events.size() == 1);
  REQUIRE(b.events.size() == 2);
  CHECK(b.events[1].second == 3);

  // With all removed, a fire reaches nobody.
  audio_bus::remove(tb);
  audio_bus::fire("x", 0);
  CHECK(a.events.size() == 1);
  CHECK(b.events.size() == 2);
}

TEST_CASE("audio_bus handles a null callback and unknown tokens", "[audio_bus]") {
  CHECK(audio_bus::add(nullptr, nullptr) == 0);
  audio_bus::remove(0);        // no-op, must not crash
  audio_bus::remove(999999);   // unknown token, no-op
  audio_bus::fire(nullptr, 1); // null key tolerated (no listeners)
  SUCCEED();
}

TEST_CASE("audio_bus is thread-safe under concurrent add/remove/fire", "[audio_bus]") {
  g_counter.store(0);
  std::atomic<bool> stop{false};
  std::atomic<int> fires{0};

  uint64_t stable = audio_bus::add(counting_cb, nullptr);

  std::thread firer([&] {
    while (!stop.load(std::memory_order_relaxed)) {
      audio_bus::fire("k/looper", 1);
      fires.fetch_add(1, std::memory_order_relaxed);
    }
  });
  std::thread churn([&] {
    std::vector<uint64_t> toks;
    for (int i = 0; i < 5000; ++i) {
      toks.push_back(audio_bus::add(counting_cb, nullptr));
      if (toks.size() > 8) {
        audio_bus::remove(toks.front());
        toks.erase(toks.begin());
      }
    }
    for (auto t : toks) audio_bus::remove(t);
  });

  churn.join();
  stop.store(true, std::memory_order_relaxed);
  firer.join();
  audio_bus::remove(stable);

  // Completing without deadlock/crash is the guarantee; a run under TSan would
  // additionally flag any data race. Sanity-check that work actually happened.
  CHECK(fires.load() > 0);
  CHECK(g_counter.load() > 0);
}
