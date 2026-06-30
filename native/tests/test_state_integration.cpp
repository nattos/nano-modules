#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include <ixwebsocket/IXWebSocket.h>
#include <nlohmann/json.hpp>

#include "bridge/bridge_api.h"
#include "bridge/bridge_server.h"
#include "json/json_patch.h"

using json = nlohmann::json;

// ABI helper: register and return the actual key the server assigned.
static std::string abi_register(BridgeHandle h, const char* id,
                                const char* requested_key) {
  char buf[128] = {0};
  int n = bridge_register_plugin(h, id, 0, 1, 0, "", requested_key,
                                 buf, sizeof(buf));
  return std::string(buf, (n > 0 && n < (int)sizeof(buf)) ? n : (int)strlen(buf));
}

template <typename Pred>
bool wait_for(Pred pred, int timeout_ms = 3000) {
  auto start = std::chrono::steady_clock::now();
  while (!pred()) {
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::steady_clock::now() - start).count();
    if (elapsed >= timeout_ms) return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return true;
}

TEST_CASE("state: register plugin and retrieve via WS", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  REQUIRE(h != nullptr);

  auto& doc = static_cast<bridge::BridgeServer*>(h)->state_document();
  auto key = doc.register_plugin({"com.test.integration", 1, 0, 0});
  REQUIRE(key == "com.test.integration@0");

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:8081");

  std::vector<std::string> received;
  client.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Message) {
      received.push_back(msg->str);
    }
  });
  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));
  std::this_thread::sleep_for(std::chrono::milliseconds(100));

  client.send(R"({"action":"get","path":"/"})");
  REQUIRE(wait_for([&] { return !received.empty(); }));

  auto snapshot = json::parse(received[0]);
  INFO("snapshot: " << snapshot.dump(2));
  REQUIRE(snapshot["type"] == "snapshot");
  REQUIRE(snapshot["data"]["global"]["plugins"].size() >= 1);

  // Find our plugin in the listing
  bool found = false;
  for (auto& p : snapshot["data"]["global"]["plugins"]) {
    if (p["key"] == key) {
      REQUIRE(p["metadata"]["id"] == "com.test.integration");
      found = true;
    }
  }
  REQUIRE(found);

  doc.unregister_plugin(key);
  client.stop();
  bridge_release(h);
}

TEST_CASE("state: observe path and receive patches", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  auto& doc = static_cast<bridge::BridgeServer*>(h)->state_document();
  auto key = doc.register_plugin({"com.test.observe", 1, 0, 0});
  doc.drain_patches();

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:8081");

  std::vector<std::string> received;
  client.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Message) {
      received.push_back(msg->str);
    }
  });
  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));

  std::string observe_path = "/plugins/" + key + "/state";
  client.send(json({{"action", "observe"}, {"path", observe_path}}).dump());
  std::this_thread::sleep_for(std::chrono::milliseconds(100));

  doc.set_plugin_state(key, {{"counter", 42}});
  bridge_tick(h);

  REQUIRE(wait_for([&] { return !received.empty(); }));

  auto patch_msg = json::parse(received[0]);
  REQUIRE(patch_msg["type"] == "patch");
  REQUIRE(patch_msg["ops"].is_array());
  REQUIRE(patch_msg["ops"].size() > 0);

  bool found = false;
  for (auto& op : patch_msg["ops"]) {
    std::string path = op["path"].get<std::string>();
    if (path.find(observe_path) == 0) found = true;
  }
  REQUIRE(found);

  doc.unregister_plugin(key);
  client.stop();
  bridge_release(h);
}

TEST_CASE("state: client writes to plugin state via patch", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  auto& doc = static_cast<bridge::BridgeServer*>(h)->state_document();
  auto key = doc.register_plugin({"com.test.write", 1, 0, 0});
  doc.set_plugin_state(key, {{"value", 0}});
  doc.drain_patches();

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:8081");
  client.setOnMessageCallback([](const ix::WebSocketMessagePtr&) {});
  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));

  std::string target = "/plugins/" + key + "/state";
  json patch_msg = {
    {"action", "patch"},
    {"target", target},
    {"ops", json::array({
      {{"op", "replace"}, {"path", "/value"}, {"value", 999}},
    })},
  };
  client.send(patch_msg.dump());

  std::this_thread::sleep_for(std::chrono::milliseconds(200));

  auto state = doc.get_plugin_state(key);
  REQUIRE(state["value"] == 999);

  doc.unregister_plugin(key);
  client.stop();
  bridge_release(h);
}

TEST_CASE("mux: requested keys are honored and collisions reminted", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();

  std::string a = abi_register(h, "com.nano.nanobarrel", "uuid-AAA");
  std::string b = abi_register(h, "com.nano.nanobarrel", "uuid-BBB");
  std::string dup = abi_register(h, "com.nano.nanobarrel", "uuid-AAA"); // collision

  REQUIRE(a == "uuid-AAA");
  REQUIRE(b == "uuid-BBB");
  REQUIRE(dup != "uuid-AAA");      // reminted to a unique derivative
  REQUIRE(dup.rfind("uuid-AAA", 0) == 0); // derived from the requested key

  // Empty requested key falls back to the legacy <id>@<n> minting.
  std::string legacy = abi_register(h, "com.test.legacy", "");
  REQUIRE(legacy == "com.test.legacy@0");

  bridge_unregister_plugin(h, a.c_str());
  bridge_unregister_plugin(h, b.c_str());
  bridge_unregister_plugin(h, dup.c_str());
  bridge_unregister_plugin(h, legacy.c_str());
  bridge_release(h);
}

TEST_CASE("mux: a patch routes only to its instance's listener", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  std::string a = abi_register(h, "com.nano.nanobarrel", "key-A");
  std::string b = abi_register(h, "com.nano.nanobarrel", "key-B");
  bridge_set_at(h, ("/plugins/" + a + "/state/v").c_str(), "0");
  bridge_set_at(h, ("/plugins/" + b + "/state/v").c_str(), "0");

  std::atomic<int> a_hits{0}, b_hits{0};
  bridge_register_patch_listener(h, a.c_str(),
      [](const char*, void* ud) { (*static_cast<std::atomic<int>*>(ud))++; }, &a_hits);
  bridge_register_patch_listener(h, b.c_str(),
      [](const char*, void* ud) { (*static_cast<std::atomic<int>*>(ud))++; }, &b_hits);

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:8081");
  client.setOnMessageCallback([](const ix::WebSocketMessagePtr&) {});
  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));

  json patch_msg = {
    {"action", "patch"},
    {"target", "/plugins/" + b + "/state"},
    {"ops", json::array({ {{"op", "replace"}, {"path", "/v"}, {"value", 7}} })},
  };
  client.send(patch_msg.dump());

  REQUIRE(wait_for([&] { return b_hits.load() > 0; }));
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  REQUIRE(b_hits.load() == 1);
  REQUIRE(a_hits.load() == 0);   // A's listener must NOT fire for B's patch
  REQUIRE(bridge_get_at(h, ("/plugins/" + b + "/state/v").c_str()) != nullptr);

  bridge_unregister_patch_listener(h, a.c_str());
  bridge_unregister_patch_listener(h, b.c_str());
  bridge_unregister_plugin(h, a.c_str());
  bridge_unregister_plugin(h, b.c_str());
  client.stop();
  bridge_release(h);
}

TEST_CASE("mux: get/set_at round-trips JSON through the ABI", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  std::string k = abi_register(h, "com.nano.nanobarrel", "key-RT");

  bridge_set_at(h, ("/plugins/" + k + "/state/sketch").c_str(),
                R"({"anchor":null,"hello":"world"})");
  char* got = bridge_get_at(h, ("/plugins/" + k + "/state/sketch").c_str());
  REQUIRE(got != nullptr);
  auto j = json::parse(got, nullptr, false);
  bridge_free_string(got);
  REQUIRE(!j.is_discarded());
  REQUIRE(j["hello"] == "world");

  bridge_unregister_plugin(h, k.c_str());
  bridge_release(h);
}

TEST_CASE("mux: broadcast_binary reaches a connected client", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:8081");
  std::atomic<int> bin_frames{0};
  std::string last;
  client.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Message && msg->binary) {
      last = msg->str;
      bin_frames++;
    }
  });
  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));
  std::this_thread::sleep_for(std::chrono::milliseconds(100));

  const uint8_t payload[] = {'N', 'B', 'P', 'V', 2, 1, 9, 9};
  bridge_broadcast_binary(h, payload, sizeof(payload));

  REQUIRE(wait_for([&] { return bin_frames.load() > 0; }));
  REQUIRE(last.size() == sizeof(payload));
  REQUIRE((uint8_t)last[4] == 2);   // NBPV version 2

  client.stop();
  bridge_release(h);
}

TEST_CASE("mux: key_observed reflects client subscriptions", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  std::string k = abi_register(h, "com.nano.nanobarrel", "key-OBS");
  bridge_set_at(h, ("/plugins/" + k + "/state/v").c_str(), "0");

  REQUIRE(bridge_key_observed(h, k.c_str()) == 0);

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:8081");
  client.setOnMessageCallback([](const ix::WebSocketMessagePtr&) {});
  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));
  client.send(json({{"action", "observe"}, {"path", "/plugins/" + k + "/state"}}).dump());

  REQUIRE(wait_for([&] { return bridge_key_observed(h, k.c_str()) == 1; }));

  bridge_unregister_plugin(h, k.c_str());
  client.stop();
  bridge_release(h);
}

TEST_CASE("state: console log entries via state document", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  auto& doc = static_cast<bridge::BridgeServer*>(h)->state_document();
  auto key = doc.register_plugin({"com.test.console", 1, 0, 0});
  doc.drain_patches();

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:8081");

  std::vector<std::string> received;
  client.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Message) received.push_back(msg->str);
  });
  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));

  std::string observe_path = "/plugins/" + key + "/console";
  client.send(json({{"action", "observe"}, {"path", observe_path}}).dump());
  std::this_thread::sleep_for(std::chrono::milliseconds(100));

  doc.log(key, {1.0, "log", "hello from integration test"});
  bridge_tick(h);

  REQUIRE(wait_for([&] { return !received.empty(); }));

  auto patch_msg = json::parse(received[0]);
  REQUIRE(patch_msg["type"] == "patch");

  bool has_console_add = false;
  for (auto& op : patch_msg["ops"]) {
    if (op["op"] == "add" && op["path"].get<std::string>().find("console") != std::string::npos) {
      has_console_add = true;
    }
  }
  REQUIRE(has_console_add);

  doc.unregister_plugin(key);
  client.stop();
  bridge_release(h);
}
