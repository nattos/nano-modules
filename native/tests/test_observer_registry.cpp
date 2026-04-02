#include <catch2/catch_test_macros.hpp>

#include "bridge/observer_registry.h"

using bridge::ObserverRegistry;
using json_patch::PatchOp;

TEST_CASE("observe and check", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "/plugins/m0/state");
  REQUIRE(reg.is_observing(1, "/plugins/m0/state"));
  REQUIRE_FALSE(reg.is_observing(1, "/plugins/m1/state"));
  REQUIRE_FALSE(reg.is_observing(2, "/plugins/m0/state"));
}

TEST_CASE("unobserve removes subscription", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "/plugins/m0/state");
  reg.unobserve(1, "/plugins/m0/state");
  REQUIRE_FALSE(reg.is_observing(1, "/plugins/m0/state"));
}

TEST_CASE("remove_client clears all subscriptions", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "/plugins/m0/state");
  reg.observe(1, "/plugins/m0/console");
  reg.remove_client(1);
  REQUIRE(reg.client_paths(1).empty());
}

TEST_CASE("filter_patches delivers to exact match", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "/plugins/m0/state");

  std::vector<PatchOp> patches = {
    {"replace", "/plugins/m0/state/x", 5, {}},
  };

  auto result = reg.filter_patches(patches);
  REQUIRE(result.count(1) == 1);
  REQUIRE(result[1].size() == 1);
  REQUIRE(result[1][0].path == "/plugins/m0/state/x");
}

TEST_CASE("filter_patches delivers child mutations to parent observer", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "/plugins/m0/state");

  std::vector<PatchOp> patches = {
    {"replace", "/plugins/m0/state/nested/deep", 42, {}},
  };

  auto result = reg.filter_patches(patches);
  REQUIRE(result.count(1) == 1);
  REQUIRE(result[1].size() == 1);
}

TEST_CASE("filter_patches delivers parent mutations to child observer", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "/plugins/m0/state/nested");

  std::vector<PatchOp> patches = {
    {"replace", "/plugins/m0/state", {{"nested", 99}}, {}},
  };

  auto result = reg.filter_patches(patches);
  REQUIRE(result.count(1) == 1);
  REQUIRE(result[1].size() == 1);
}

TEST_CASE("filter_patches ignores unrelated paths", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "/plugins/m0/state");

  std::vector<PatchOp> patches = {
    {"replace", "/plugins/m1/state/x", 5, {}},
    {"add", "/global/plugins/-", {}, {}},
  };

  auto result = reg.filter_patches(patches);
  REQUIRE(result.count(1) == 0);
}

TEST_CASE("filter_patches multiple clients", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "/plugins/m0/state");
  reg.observe(2, "/plugins/m1/state");
  reg.observe(3, "/plugins/m0/state");

  std::vector<PatchOp> patches = {
    {"replace", "/plugins/m0/state/x", 10, {}},
    {"replace", "/plugins/m1/state/y", 20, {}},
  };

  auto result = reg.filter_patches(patches);
  REQUIRE(result[1].size() == 1);
  REQUIRE(result[2].size() == 1);
  REQUIRE(result[3].size() == 1);
  REQUIRE(result[1][0].path == "/plugins/m0/state/x");
  REQUIRE(result[2][0].path == "/plugins/m1/state/y");
}

TEST_CASE("filter_patches root observer gets everything", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "");

  std::vector<PatchOp> patches = {
    {"replace", "/plugins/m0/state/x", 1, {}},
    {"add", "/global/plugins/-", {}, {}},
  };

  auto result = reg.filter_patches(patches);
  REQUIRE(result[1].size() == 2);
}

TEST_CASE("filter_patches no duplicate when multiple subscriptions match", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "/plugins/m0");
  reg.observe(1, "/plugins/m0/state");

  std::vector<PatchOp> patches = {
    {"replace", "/plugins/m0/state/x", 5, {}},
  };

  auto result = reg.filter_patches(patches);
  // Should get the patch once, not twice
  REQUIRE(result[1].size() == 1);
}

TEST_CASE("client_paths returns all observed paths", "[observer_registry]") {
  ObserverRegistry reg;
  reg.observe(1, "/a");
  reg.observe(1, "/b");
  reg.observe(1, "/c");

  auto paths = reg.client_paths(1);
  REQUIRE(paths.size() == 3);
  REQUIRE(paths.count("/a"));
  REQUIRE(paths.count("/b"));
  REQUIRE(paths.count("/c"));
}
