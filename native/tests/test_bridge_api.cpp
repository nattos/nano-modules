#include <catch2/catch_test_macros.hpp>

#include <thread>
#include <vector>

#include "bridge/bridge_api.h"

TEST_CASE("bridge_init returns non-null handle", "[bridge_api]") {
  BridgeHandle h = bridge_init();
  REQUIRE(h != nullptr);
  bridge_release(h);
}

TEST_CASE("bridge_init is idempotent -- same handle on repeated calls", "[bridge_api]") {
  BridgeHandle h1 = bridge_init();
  BridgeHandle h2 = bridge_init();
  REQUIRE(h1 == h2);
  bridge_release(h1);
  bridge_release(h2);
}

TEST_CASE("bridge_get_param returns 0 for unknown param", "[bridge_api]") {
  BridgeHandle h = bridge_init();
  REQUIRE(bridge_get_param(h, 99999) == 0.0);
  bridge_release(h);
}

TEST_CASE("bridge_set_param then bridge_get_param round-trips", "[bridge_api]") {
  BridgeHandle h = bridge_init();
  bridge_set_param(h, 42, 3.14);
  REQUIRE(bridge_get_param(h, 42) == 3.14);
  bridge_release(h);
}

TEST_CASE("bridge_tick does not crash", "[bridge_api]") {
  BridgeHandle h = bridge_init();
  bridge_tick(h);
  bridge_release(h);
}

TEST_CASE("null handle is safe for all functions", "[bridge_api]") {
  bridge_release(nullptr);
  REQUIRE(bridge_get_param(nullptr, 1) == 0.0);
  bridge_set_param(nullptr, 1, 1.0);
  bridge_tick(nullptr);
  REQUIRE(bridge_load_wasm(nullptr, nullptr, 0) == -1);
  bridge_unload_wasm(nullptr, 0);
  REQUIRE(bridge_call_wasm(nullptr, 0, "test") == -1);
}

TEST_CASE("bridge_init from multiple threads returns same handle", "[bridge_api]") {
  constexpr int N = 10;
  std::vector<BridgeHandle> handles(N, nullptr);
  std::vector<std::thread> threads;

  for (int i = 0; i < N; ++i) {
    threads.emplace_back([&, i] {
      handles[i] = bridge_init();
    });
  }
  for (auto& t : threads) t.join();

  for (int i = 1; i < N; ++i) {
    REQUIRE(handles[i] == handles[0]);
  }

  // Release all
  for (int i = 0; i < N; ++i) {
    bridge_release(handles[i]);
  }
}
