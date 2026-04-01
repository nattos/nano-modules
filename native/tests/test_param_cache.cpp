#include <catch2/catch_test_macros.hpp>

#include <thread>
#include <vector>

#include "bridge/param_cache.h"

using bridge::ParamCache;

TEST_CASE("get returns 0 for unknown param", "[param_cache]") {
  ParamCache cache;
  REQUIRE(cache.get(999) == 0.0);
}

TEST_CASE("set then get round-trips", "[param_cache]") {
  ParamCache cache;
  cache.set(42, 3.14);
  REQUIRE(cache.get(42) == 3.14);
}

TEST_CASE("has returns false for unknown, true for known", "[param_cache]") {
  ParamCache cache;
  REQUIRE_FALSE(cache.has(42));
  cache.set(42, 1.0);
  REQUIRE(cache.has(42));
}

TEST_CASE("set overwrites previous value", "[param_cache]") {
  ParamCache cache;
  cache.set(42, 1.0);
  cache.set(42, 2.0);
  REQUIRE(cache.get(42) == 2.0);
}

TEST_CASE("drain_outbox returns queued writes and clears", "[param_cache]") {
  ParamCache cache;
  cache.queue_write(1, 10.0);
  cache.queue_write(2, 20.0);

  auto writes = cache.drain_outbox();
  REQUIRE(writes.size() == 2);
  REQUIRE(writes[0].first == 1);
  REQUIRE(writes[0].second == 10.0);
  REQUIRE(writes[1].first == 2);
  REQUIRE(writes[1].second == 20.0);

  // Second drain should be empty
  auto writes2 = cache.drain_outbox();
  REQUIRE(writes2.empty());
}

TEST_CASE("concurrent reads do not block each other", "[param_cache]") {
  ParamCache cache;
  cache.set(1, 42.0);

  constexpr int N = 8;
  std::vector<std::thread> threads;
  std::atomic<int> success_count{0};

  for (int i = 0; i < N; ++i) {
    threads.emplace_back([&] {
      for (int j = 0; j < 1000; ++j) {
        double val = cache.get(1);
        if (val == 42.0) success_count.fetch_add(1, std::memory_order_relaxed);
      }
    });
  }

  for (auto& t : threads) t.join();
  REQUIRE(success_count == N * 1000);
}

TEST_CASE("concurrent read+write is safe", "[param_cache]") {
  ParamCache cache;
  constexpr int N = 4;
  constexpr int ITERS = 1000;

  std::vector<std::thread> threads;

  // Writers
  for (int i = 0; i < N; ++i) {
    threads.emplace_back([&, i] {
      for (int j = 0; j < ITERS; ++j) {
        cache.set(i, static_cast<double>(j));
      }
    });
  }

  // Readers
  for (int i = 0; i < N; ++i) {
    threads.emplace_back([&, i] {
      for (int j = 0; j < ITERS; ++j) {
        cache.get(i); // Should not crash or deadlock
      }
    });
  }

  for (auto& t : threads) t.join();

  // Verify final values are the last written
  for (int i = 0; i < N; ++i) {
    REQUIRE(cache.get(i) == static_cast<double>(ITERS - 1));
  }
}
