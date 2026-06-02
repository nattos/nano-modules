#include "bridge/ws_server.h"

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocketServer.h>

namespace bridge {

WsServer::WsServer() = default;

WsServer::~WsServer() {
  stop();
}

bool WsServer::start(int port) {
  if (running_) return true;

  ix::initNetSystem();
  server_ = std::make_unique<ix::WebSocketServer>(port, "0.0.0.0");
  // We're a localhost-only bridge carrying mostly raw RGBA pixel
  // frames — high entropy data that the deflate codec spends CPU on
  // for almost no size reduction. The cost showed up as a
  // content-complexity-driven FPS drop on the FFGL host: the send
  // worker ran the compression synchronously, and busy worker stretches
  // back-pressured the Metal completion queue. Turning it off
  // collapses the cost to zero.
  server_->disablePerMessageDeflate();

  server_->setOnClientMessageCallback(
      [this](std::shared_ptr<ix::ConnectionState> state,
             ix::WebSocket& ws,
             const ix::WebSocketMessagePtr& msg) {
        if (msg->type == ix::WebSocketMessageType::Open) {
          std::lock_guard lock(clients_mutex_);
          int id = next_client_id_++;
          // Find the shared_ptr for this websocket from the server's client list
          for (auto& client : server_->getClients()) {
            if (client.get() == &ws) {
              clients_[id] = client;
              ws_to_id_[&ws] = id;
              break;
            }
          }
          if (connect_callback_) connect_callback_(id);
          return;
        }

        if (msg->type == ix::WebSocketMessageType::Close) {
          std::lock_guard lock(clients_mutex_);
          auto it = ws_to_id_.find(&ws);
          if (it != ws_to_id_.end()) {
            int id = it->second;
            ws_to_id_.erase(it);
            clients_.erase(id);
            if (disconnect_callback_) disconnect_callback_(id);
          }
          return;
        }

        if (msg->type == ix::WebSocketMessageType::Message) {
          ClientId id = 0;
          {
            std::lock_guard lock(clients_mutex_);
            auto it = ws_to_id_.find(&ws);
            if (it != ws_to_id_.end()) id = it->second;
          }
          if (message_callback_ && id > 0) {
            message_callback_(id, msg->str);
          } else if (!message_callback_) {
            ws.send(msg->str);
          }
        }
      });

  auto res = server_->listen();
  if (!res.first) return false;

  server_->start();
  running_ = true;
  return true;
}

void WsServer::stop() {
  if (!running_) return;
  if (server_) {
    server_->stop();
    server_.reset();
  }
  {
    std::lock_guard lock(clients_mutex_);
    clients_.clear();
    ws_to_id_.clear();
  }
  running_ = false;
}

// IMPORTANT: ixwebsocket's send()/sendBinary() can synchronously fire
// the WebSocket's onMessage callback with a Close payload when it
// detects a dead connection (sendData → flushSendBuffer → setReadyState
// → onClose). That re-enters our setOnClientMessageCallback Close
// branch, which tries to take `clients_mutex_`. If we were already
// holding it for the send loop, deadlock — and that's the exact stack
// we hit when the editor tab closes leaving a stale client_id in
// `clients_` that the next broadcast trips over. So every send below
// snapshots the target websockets under the lock and sends outside it.

void WsServer::broadcast(const std::string& msg) {
  if (!server_ || !running_) return;
  std::vector<std::shared_ptr<ix::WebSocket>> snapshot;
  {
    std::lock_guard lock(clients_mutex_);
    snapshot.reserve(clients_.size());
    for (auto& [_, ws] : clients_) snapshot.push_back(ws);
  }
  for (auto& ws : snapshot) ws->send(msg);
}

void WsServer::send_to(ClientId client, const std::string& msg) {
  std::shared_ptr<ix::WebSocket> ws;
  {
    std::lock_guard lock(clients_mutex_);
    auto it = clients_.find(client);
    if (it != clients_.end()) ws = it->second;
  }
  if (ws) ws->send(msg);
}

void WsServer::send_binary_to(ClientId client, const void* data, size_t size) {
  if (!data || size == 0) return;
  std::shared_ptr<ix::WebSocket> ws;
  {
    std::lock_guard lock(clients_mutex_);
    auto it = clients_.find(client);
    if (it != clients_.end()) ws = it->second;
  }
  if (!ws) return;
  // ixwebsocket's sendBinary takes a std::string but treats it as an
  // opaque byte buffer. The (ptr, len) string ctor here does NOT scan
  // for a null terminator, so embedded zeros pass through unchanged.
  std::string buf(reinterpret_cast<const char*>(data), size);
  ws->sendBinary(buf);
}

void WsServer::broadcast_binary(const void* data, size_t size) {
  if (!server_ || !running_ || !data || size == 0) return;
  std::vector<std::shared_ptr<ix::WebSocket>> snapshot;
  {
    std::lock_guard lock(clients_mutex_);
    snapshot.reserve(clients_.size());
    for (auto& [_, ws] : clients_) snapshot.push_back(ws);
  }
  std::string buf(reinterpret_cast<const char*>(data), size);
  for (auto& ws : snapshot) ws->sendBinary(buf);
}

} // namespace bridge
