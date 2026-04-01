#pragma once

#include <functional>
#include <string>

namespace ix {
class WebSocketServer;
}

namespace bridge {

/// WebSocket server for the nano-repatch web UI to connect to.
/// Runs on a background thread.
class WsServer {
public:
  using MessageCallback = std::function<void(const std::string& msg)>;

  WsServer();
  ~WsServer();

  /// Start the server on the given port. Returns true on success.
  bool start(int port = 8081);

  /// Stop the server.
  void stop();

  /// Check if the server is running.
  bool is_running() const { return running_; }

  /// Broadcast a message to all connected clients.
  void broadcast(const std::string& msg);

  /// Set callback for incoming messages from clients.
  void set_message_callback(MessageCallback cb) { message_callback_ = std::move(cb); }

private:
  std::unique_ptr<ix::WebSocketServer> server_;
  bool running_ = false;
  MessageCallback message_callback_;
};

} // namespace bridge
