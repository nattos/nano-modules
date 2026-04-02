#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include <ixwebsocket/IXWebSocket.h>
#include <nlohmann/json.hpp>

#include "bridge/bridge_api.h"
#include "bridge/bridge_server.h"
#include "json/json_patch.h"

using json = nlohmann::json;

// Helper: wait for a condition with timeout
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

// All integration tests use the bridge_server dylib directly (linked, not dlopen)
// The bridge server starts its WS server on port 8081.

TEST_CASE("state: register plugin and retrieve via WS", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  REQUIRE(h != nullptr);

  // The bridge server should now have a WS server on 8081.
  // Register a plugin via the state document directly.
  auto& doc = static_cast<bridge::BridgeServer*>(h)->state_document();
  auto key = doc.register_plugin(42, {"com.test.integration", 1, 0, 0});
  REQUIRE(key == "module_42");

  // Connect a WS client and request the full document
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

  // Small delay to ensure server registers the client
  std::this_thread::sleep_for(std::chrono::milliseconds(100));

  // Request full document snapshot
  client.send(R"({"action":"get","path":"/"})");
  REQUIRE(wait_for([&] { return !received.empty(); }));

  auto snapshot = json::parse(received[0]);
  INFO("snapshot: " << snapshot.dump(2));
  REQUIRE(snapshot["type"] == "snapshot");
  REQUIRE(snapshot["data"]["global"]["plugins"].size() == 1);
  REQUIRE(snapshot["data"]["global"]["plugins"][0]["key"] == "module_42");
  REQUIRE(snapshot["data"]["global"]["plugins"][0]["metadata"]["id"] == "com.test.integration");

  // Clean up
  doc.unregister_plugin(key);
  client.stop();
  bridge_release(h);
}

TEST_CASE("state: observe path and receive patches", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  auto& doc = static_cast<bridge::BridgeServer*>(h)->state_document();
  auto key = doc.register_plugin(99, {"com.test.observe", 1, 0, 0});
  doc.drain_patches(); // clear registration patches

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

  // Subscribe to the plugin's state path
  client.send(R"({"action":"observe","path":"/plugins/module_99/state"})");
  std::this_thread::sleep_for(std::chrono::milliseconds(100));

  // Modify the plugin state
  doc.set_plugin_state(key, {{"counter", 42}});

  // Tick the bridge to broadcast patches
  bridge_tick(h);

  REQUIRE(wait_for([&] { return !received.empty(); }));

  auto patch_msg = json::parse(received[0]);
  REQUIRE(patch_msg["type"] == "patch");
  REQUIRE(patch_msg["ops"].is_array());
  REQUIRE(patch_msg["ops"].size() > 0);

  // The patch should affect the state path
  bool found = false;
  for (auto& op : patch_msg["ops"]) {
    std::string path = op["path"].get<std::string>();
    if (path.find("/plugins/module_99/state") == 0) found = true;
  }
  REQUIRE(found);

  doc.unregister_plugin(key);
  client.stop();
  bridge_release(h);
}

TEST_CASE("state: client writes to plugin state via patch", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  auto& doc = static_cast<bridge::BridgeServer*>(h)->state_document();
  auto key = doc.register_plugin(77, {"com.test.write", 1, 0, 0});
  doc.set_plugin_state(key, {{"value", 0}});
  doc.drain_patches();

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:8081");
  client.setOnMessageCallback([](const ix::WebSocketMessagePtr&) {});
  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));

  // Send a patch to the plugin's state
  json patch_msg = {
    {"action", "patch"},
    {"target", "/plugins/module_77/state"},
    {"ops", json::array({
      {{"op", "replace"}, {"path", "/value"}, {"value", 999}},
    })},
  };
  client.send(patch_msg.dump());

  // Wait for the message to be processed
  std::this_thread::sleep_for(std::chrono::milliseconds(200));

  // Verify the state was updated
  auto state = doc.get_plugin_state(key);
  REQUIRE(state["value"] == 999);

  doc.unregister_plugin(key);
  client.stop();
  bridge_release(h);
}

TEST_CASE("state: console log entries via state document", "[state_integration][integration]") {
  BridgeHandle h = bridge_init();
  auto& doc = static_cast<bridge::BridgeServer*>(h)->state_document();
  auto key = doc.register_plugin(55, {"com.test.console", 1, 0, 0});
  doc.drain_patches();

  // Subscribe to console
  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:8081");

  std::vector<std::string> received;
  client.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Message) received.push_back(msg->str);
  });
  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));

  client.send(R"({"action":"observe","path":"/plugins/module_55/console"})");
  std::this_thread::sleep_for(std::chrono::milliseconds(100));

  // Log a message
  doc.log(key, {1.0, "log", "hello from integration test"});
  bridge_tick(h);

  REQUIRE(wait_for([&] { return !received.empty(); }));

  auto patch_msg = json::parse(received[0]);
  REQUIRE(patch_msg["type"] == "patch");

  // Verify the log entry is in the patch
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
