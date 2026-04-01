#pragma once

#include <deque>
#include <mutex>
#include <string>
#include <vector>

#include "resolume/protocol.h"

namespace ix {
class WebSocket;
}

namespace resolume {

/// WebSocket client for connecting to Resolume's API.
/// Runs a background thread for the WS connection; main thread polls via poll().
class WsClient {
public:
  WsClient();
  ~WsClient();

  /// Connect to the Resolume WebSocket server.
  void connect(const std::string& url = "ws://127.0.0.1:8080/api/v1");

  /// Disconnect from the server.
  void disconnect();

  /// Check if connected.
  bool is_connected() const;

  /// Poll for incoming messages (call from main thread).
  std::vector<IncomingMessage> poll();

  /// Send a subscribe message.
  void subscribe(const std::string& path);

  /// Send a subscribe-by-id message.
  void subscribe_by_id(int64_t id);

  /// Send a set message.
  void set(const std::string& path, int64_t id, const nlohmann::json& value);

  /// Send a trigger message.
  void trigger(const std::string& path, bool value = true);

private:
  std::unique_ptr<ix::WebSocket> ws_;
  std::mutex inbox_mutex_;
  std::deque<IncomingMessage> inbox_;
};

} // namespace resolume
