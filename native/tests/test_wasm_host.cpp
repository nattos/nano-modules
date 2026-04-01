#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "bridge/param_cache.h"
#include "wasm/wasm_host.h"

using bridge::ParamCache;
using wasm::WasmHost;

// Minimal valid WASM module (empty, just has the magic header + version)
static const uint8_t EMPTY_MODULE[] = {
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
};

// Auto-generated WASM test modules (from tools/gen_wasm.cpp)

// (module (func (export "tick")))
static const uint8_t TICK_MODULE[] = {
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02,
    0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x74, 0x69, 0x63, 0x6b, 0x00, 0x00, 0x0a, 0x04, 0x01, 0x02,
    0x00, 0x0b,
};

// Imports get/set param, exports "double_param" (doubles param 42) and "tick"
static const uint8_t PARAM_MODULE[] = {
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x0e, 0x03, 0x60, 0x01, 0x7e, 0x01, 0x7c,
    0x60, 0x02, 0x7e, 0x7c, 0x00, 0x60, 0x00, 0x00, 0x02, 0x33, 0x02, 0x03, 0x65, 0x6e, 0x76, 0x12,
    0x72, 0x65, 0x73, 0x6f, 0x6c, 0x75, 0x6d, 0x65, 0x5f, 0x67, 0x65, 0x74, 0x5f, 0x70, 0x61, 0x72,
    0x61, 0x6d, 0x00, 0x00, 0x03, 0x65, 0x6e, 0x76, 0x12, 0x72, 0x65, 0x73, 0x6f, 0x6c, 0x75, 0x6d,
    0x65, 0x5f, 0x73, 0x65, 0x74, 0x5f, 0x70, 0x61, 0x72, 0x61, 0x6d, 0x00, 0x01, 0x03, 0x03, 0x02,
    0x02, 0x02, 0x07, 0x17, 0x02, 0x0c, 0x64, 0x6f, 0x75, 0x62, 0x6c, 0x65, 0x5f, 0x70, 0x61, 0x72,
    0x61, 0x6d, 0x00, 0x02, 0x04, 0x74, 0x69, 0x63, 0x6b, 0x00, 0x03, 0x0a, 0x19, 0x02, 0x14, 0x00,
    0x42, 0x2a, 0x42, 0x2a, 0x10, 0x00, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0xa2,
    0x10, 0x01, 0x0b, 0x02, 0x00, 0x0b,
};

// Imports "log", has memory with "hello" data, exports "say_hello"
static const uint8_t LOG_MODULE[] = {
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x09, 0x02, 0x60, 0x02, 0x7f, 0x7f, 0x00,
    0x60, 0x00, 0x00, 0x02, 0x0b, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x03, 0x6c, 0x6f, 0x67, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x01, 0x05, 0x03, 0x01, 0x00, 0x01, 0x07, 0x16, 0x02, 0x06, 0x6d, 0x65, 0x6d,
    0x6f, 0x72, 0x79, 0x02, 0x00, 0x09, 0x73, 0x61, 0x79, 0x5f, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00,
    0x01, 0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0x41, 0x05, 0x10, 0x00, 0x0b, 0x0b, 0x0b, 0x01,
    0x00, 0x41, 0x00, 0x0b, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
};


TEST_CASE("init and shutdown", "[wasm_host]") {
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());
  REQUIRE(host.is_initialized());
  host.shutdown();
  REQUIRE_FALSE(host.is_initialized());
}

TEST_CASE("load_module succeeds for valid bytecode", "[wasm_host]") {
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(TICK_MODULE, sizeof(TICK_MODULE));
  REQUIRE(id >= 0);

  host.shutdown();
}

TEST_CASE("load_module fails for garbage bytes", "[wasm_host]") {
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  uint8_t garbage[] = {0xDE, 0xAD, 0xBE, 0xEF};
  int32_t id = host.load_module(garbage, sizeof(garbage));
  REQUIRE(id == -1);

  host.shutdown();
}

TEST_CASE("load_module fails for null/empty", "[wasm_host]") {
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  REQUIRE(host.load_module(nullptr, 0) == -1);
  REQUIRE(host.load_module(TICK_MODULE, 0) == -1);

  host.shutdown();
}

TEST_CASE("call_function invokes exported function", "[wasm_host]") {
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(TICK_MODULE, sizeof(TICK_MODULE));
  REQUIRE(id >= 0);

  REQUIRE(host.call_function(id, "tick") == 0);

  host.shutdown();
}

TEST_CASE("call_function fails for nonexistent function", "[wasm_host]") {
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(TICK_MODULE, sizeof(TICK_MODULE));
  REQUIRE(id >= 0);

  REQUIRE(host.call_function(id, "nonexistent") == -1);

  host.shutdown();
}

TEST_CASE("call_function fails for invalid module_id", "[wasm_host]") {
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  REQUIRE(host.call_function(999, "tick") == -1);

  host.shutdown();
}

TEST_CASE("unload then load new module", "[wasm_host]") {
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id1 = host.load_module(TICK_MODULE, sizeof(TICK_MODULE));
  REQUIRE(id1 >= 0);

  host.unload_module(id1);

  // Should fail after unload
  REQUIRE(host.call_function(id1, "tick") == -1);

  // Load a new module
  int32_t id2 = host.load_module(TICK_MODULE, sizeof(TICK_MODULE));
  REQUIRE(id2 >= 0);
  REQUIRE(id2 != id1); // New ID

  REQUIRE(host.call_function(id2, "tick") == 0);

  host.shutdown();
}

TEST_CASE("resolume_get_param reads from param cache via WASM", "[wasm_host]") {
  ParamCache cache;
  cache.set(42, 5.0);

  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(PARAM_MODULE, sizeof(PARAM_MODULE));
  INFO("last_error: " << host.last_error());
  REQUIRE(id >= 0);

  // double_param should read param 42 (5.0) and write 42 = 10.0
  REQUIRE(host.call_function(id, "double_param") == 0);
  REQUIRE(cache.get(42) == 10.0);

  host.shutdown();
}

TEST_CASE("resolume_set_param queues write to outbox via WASM", "[wasm_host]") {
  ParamCache cache;
  cache.set(42, 3.0);

  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(PARAM_MODULE, sizeof(PARAM_MODULE));
  REQUIRE(id >= 0);

  REQUIRE(host.call_function(id, "double_param") == 0);

  auto outbox = cache.drain_outbox();
  REQUIRE(outbox.size() == 1);
  REQUIRE(outbox[0].first == 42);
  REQUIRE(outbox[0].second == 6.0);

  host.shutdown();
}

TEST_CASE("host_log captures output", "[wasm_host]") {
  ParamCache cache;
  WasmHost host(cache);

  std::vector<std::string> log_messages;
  host.set_log_callback([&](const std::string& msg) {
    log_messages.push_back(msg);
  });

  REQUIRE(host.init());

  int32_t id = host.load_module(LOG_MODULE, sizeof(LOG_MODULE));
  INFO("last_error: " << host.last_error());
  REQUIRE(id >= 0);

  REQUIRE(host.call_function(id, "say_hello") == 0);
  REQUIRE(log_messages.size() == 1);
  REQUIRE(log_messages[0] == "hello");

  host.shutdown();
}

TEST_CASE("hot-replace module", "[wasm_host]") {
  ParamCache cache;
  cache.set(42, 7.0);

  WasmHost host(cache);
  REQUIRE(host.init());

  // Load module, run it (doubles param 42: 7.0 -> 14.0)
  int32_t id1 = host.load_module(PARAM_MODULE, sizeof(PARAM_MODULE));
  REQUIRE(id1 >= 0);
  REQUIRE(host.call_function(id1, "double_param") == 0);
  REQUIRE(cache.get(42) == 14.0);

  // Unload and load a different module (tick-only, does nothing to params)
  host.unload_module(id1);
  int32_t id2 = host.load_module(TICK_MODULE, sizeof(TICK_MODULE));
  REQUIRE(id2 >= 0);
  REQUIRE(host.call_function(id2, "tick") == 0);

  // Param should be unchanged
  REQUIRE(cache.get(42) == 14.0);

  host.shutdown();
}
