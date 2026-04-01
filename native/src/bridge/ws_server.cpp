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
        if (msg->type != ix::WebSocketMessageType::Message) return;
        if (message_callback_) {
          message_callback_(msg->str);
        } else {
          // Default: echo
          ws.send(msg->str);
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
  running_ = false;
}

void WsServer::broadcast(const std::string& msg) {
  if (!server_ || !running_) return;
  for (auto& client : server_->getClients()) {
    client->send(msg);
  }
}

} // namespace bridge
