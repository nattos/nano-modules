#pragma once

#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace ix {
class WebSocketServer;
class WebSocket;
}

namespace bridge {

using ClientId = int;

/// WebSocket server with per-client ID tracking.
class WsServer {
public:
  using MessageCallback = std::function<void(ClientId client, const std::string& msg)>;
  using ConnectCallback = std::function<void(ClientId client)>;
  using DisconnectCallback = std::function<void(ClientId client)>;

  WsServer();
  ~WsServer();

  bool start(int port = 8081);
  void stop();
  bool is_running() const { return running_; }

  /// Broadcast a message to all connected clients.
  void broadcast(const std::string& msg);

  /// Send a message to a specific client.
  void send_to(ClientId client, const std::string& msg);

  void set_message_callback(MessageCallback cb) { message_callback_ = std::move(cb); }
  void set_connect_callback(ConnectCallback cb) { connect_callback_ = std::move(cb); }
  void set_disconnect_callback(DisconnectCallback cb) { disconnect_callback_ = std::move(cb); }

private:
  std::unique_ptr<ix::WebSocketServer> server_;
  bool running_ = false;
  int next_client_id_ = 1;

  std::mutex clients_mutex_;
  std::unordered_map<ClientId, std::shared_ptr<ix::WebSocket>> clients_;
  std::unordered_map<ix::WebSocket*, ClientId> ws_to_id_;

  MessageCallback message_callback_;
  ConnectCallback connect_callback_;
  DisconnectCallback disconnect_callback_;
};

} // namespace bridge
