#include "resolume/ws_client.h"

#include <ixwebsocket/IXWebSocket.h>

namespace resolume {

WsClient::WsClient() = default;

WsClient::~WsClient() {
  disconnect();
}

void WsClient::connect(const std::string& url) {
  if (ws_) return;

  ws_ = std::make_unique<ix::WebSocket>();
  ws_->setUrl(url);

  ws_->setOnMessageCallback([this](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Message) {
      try {
        auto j = nlohmann::json::parse(msg->str);
        auto parsed = parse_incoming(j);
        std::lock_guard lock(inbox_mutex_);
        inbox_.push_back(std::move(parsed));
      } catch (...) {
        // Ignore parse errors
      }
    }
  });

  ws_->start();
}

void WsClient::disconnect() {
  if (ws_) {
    ws_->stop();
    ws_.reset();
  }
}

bool WsClient::is_connected() const {
  return ws_ && ws_->getReadyState() == ix::ReadyState::Open;
}

std::vector<IncomingMessage> WsClient::poll() {
  std::lock_guard lock(inbox_mutex_);
  std::vector<IncomingMessage> result(inbox_.begin(), inbox_.end());
  inbox_.clear();
  return result;
}

void WsClient::subscribe(const std::string& path) {
  if (!ws_) return;
  auto j = to_json(SubscribeMessage{path});
  ws_->send(j.dump());
}

void WsClient::subscribe_by_id(int64_t id) {
  subscribe("/parameter/by-id/" + std::to_string(id));
}

void WsClient::set(const std::string& path, int64_t id, const nlohmann::json& value) {
  if (!ws_) return;
  auto j = to_json(SetMessage{path, id, value});
  ws_->send(j.dump());
}

void WsClient::trigger(const std::string& path, bool value) {
  if (!ws_) return;
  auto j = to_json(TriggerMessage{path, value});
  ws_->send(j.dump());
}

} // namespace resolume
