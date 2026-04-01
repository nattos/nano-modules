#include <catch2/catch_test_macros.hpp>

#include "plugin/bridge_loader.h"

#ifndef BRIDGE_DYLIB_PATH
#error "BRIDGE_DYLIB_PATH must be defined at compile time"
#endif

TEST_CASE("load fails gracefully for nonexistent path", "[bridge_loader]") {
  plugin::BridgeLoader loader;
  REQUIRE_FALSE(loader.load("/nonexistent/path/libfoo.dylib"));
  REQUIRE_FALSE(loader.is_loaded());
}

TEST_CASE("load succeeds for built bridge dylib", "[bridge_loader]") {
  plugin::BridgeLoader loader;
  REQUIRE(loader.load(BRIDGE_DYLIB_PATH));
  REQUIRE(loader.is_loaded());
}

TEST_CASE("function pointers are non-null after successful load", "[bridge_loader]") {
  plugin::BridgeLoader loader;
  REQUIRE(loader.load(BRIDGE_DYLIB_PATH));

  REQUIRE(loader.bridge_init != nullptr);
  REQUIRE(loader.bridge_release != nullptr);
  REQUIRE(loader.bridge_get_param != nullptr);
  REQUIRE(loader.bridge_set_param != nullptr);
  REQUIRE(loader.bridge_tick != nullptr);
  REQUIRE(loader.bridge_load_wasm != nullptr);
  REQUIRE(loader.bridge_unload_wasm != nullptr);
  REQUIRE(loader.bridge_call_wasm != nullptr);
}

TEST_CASE("round-trip through loaded dylib", "[bridge_loader]") {
  plugin::BridgeLoader loader;
  REQUIRE(loader.load(BRIDGE_DYLIB_PATH));

  BridgeHandle h = loader.bridge_init();
  REQUIRE(h != nullptr);

  loader.bridge_set_param(h, 100, 2.71828);
  REQUIRE(loader.bridge_get_param(h, 100) == 2.71828);

  loader.bridge_tick(h);
  loader.bridge_release(h);
}

TEST_CASE("unload then reload works", "[bridge_loader]") {
  plugin::BridgeLoader loader;
  REQUIRE(loader.load(BRIDGE_DYLIB_PATH));
  loader.unload();
  REQUIRE_FALSE(loader.is_loaded());

  REQUIRE(loader.load(BRIDGE_DYLIB_PATH));
  REQUIRE(loader.is_loaded());

  BridgeHandle h = loader.bridge_init();
  REQUIRE(h != nullptr);
  loader.bridge_release(h);
}
