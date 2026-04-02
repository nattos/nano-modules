#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include <ixwebsocket/IXWebSocket.h>

#include "bridge/ws_server.h"

using bridge::WsServer;

// Helper: wait for a condition with timeout
template <typename Pred>
bool wait_for(Pred pred, int timeout_ms = 2000) {
  auto start = std::chrono::steady_clock::now();
  while (!pred()) {
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::steady_clock::now() - start)
                       .count();
    if (elapsed >= timeout_ms) return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return true;
}

TEST_CASE("server starts and accepts connection", "[ws_server][integration]") {
  WsServer server;
  REQUIRE(server.start(19081));

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:19081");
  client.setOnMessageCallback([](const ix::WebSocketMessagePtr&) {});
  client.start();

  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));

  client.stop();
  server.stop();
}

TEST_CASE("server echoes received message", "[ws_server][integration]") {
  WsServer server;
  REQUIRE(server.start(19082));

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:19082");

  std::string received;
  client.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Message) {
      received = msg->str;
    }
  });

  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));

  client.send("test message");
  REQUIRE(wait_for([&] { return !received.empty(); }));
  REQUIRE(received == "test message");

  client.stop();
  server.stop();
}

TEST_CASE("broadcast reaches all connected clients", "[ws_server][integration]") {
  WsServer server;
  REQUIRE(server.start(19083));

  ix::WebSocket client1, client2;
  client1.setUrl("ws://127.0.0.1:19083");
  client2.setUrl("ws://127.0.0.1:19083");

  std::string received1, received2;
  client1.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Message) received1 = msg->str;
  });
  client2.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Message) received2 = msg->str;
  });

  client1.start();
  client2.start();
  REQUIRE(wait_for([&] {
    return client1.getReadyState() == ix::ReadyState::Open &&
           client2.getReadyState() == ix::ReadyState::Open;
  }));

  // Small delay to ensure server registers both clients
  std::this_thread::sleep_for(std::chrono::milliseconds(50));

  server.broadcast("broadcast msg");
  REQUIRE(wait_for([&] { return !received1.empty() && !received2.empty(); }));
  REQUIRE(received1 == "broadcast msg");
  REQUIRE(received2 == "broadcast msg");

  client1.stop();
  client2.stop();
  server.stop();
}

TEST_CASE("server stops cleanly", "[ws_server][integration]") {
  WsServer server;
  REQUIRE(server.start(19084));

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:19084");

  bool closed = false;
  client.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Close) closed = true;
  });

  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));

  server.stop();
  REQUIRE_FALSE(server.is_running());

  // Client should detect the close
  REQUIRE(wait_for([&] { return client.getReadyState() != ix::ReadyState::Open; }));

  client.stop();
}

TEST_CASE("message callback receives client messages", "[ws_server][integration]") {
  WsServer server;

  std::string received;
  server.set_message_callback([&](int /*client_id*/, const std::string& msg) {
    received = msg;
  });

  REQUIRE(server.start(19085));

  ix::WebSocket client;
  client.setUrl("ws://127.0.0.1:19085");
  client.setOnMessageCallback([](const ix::WebSocketMessagePtr&) {});
  client.start();
  REQUIRE(wait_for([&] { return client.getReadyState() == ix::ReadyState::Open; }));

  client.send("hello server");
  REQUIRE(wait_for([&] { return !received.empty(); }));
  REQUIRE(received == "hello server");

  client.stop();
  server.stop();
}
