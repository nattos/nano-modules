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
