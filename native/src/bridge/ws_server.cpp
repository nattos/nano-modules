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

void WsServer::broadcast(const std::string& msg) {
  if (!server_ || !running_) return;
  std::lock_guard lock(clients_mutex_);
  for (auto& [id, ws] : clients_) {
    ws->send(msg);
  }
}

void WsServer::send_to(ClientId client, const std::string& msg) {
  std::lock_guard lock(clients_mutex_);
  auto it = clients_.find(client);
  if (it != clients_.end()) {
    it->second->send(msg);
  }
}

} // namespace bridge
