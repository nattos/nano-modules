#include "bridge/bridge_server.h"

#include "bridge/ws_server.h"
#include "resolume/ws_client.h"
#include "wasm/wasm_host.h"

namespace bridge {

BridgeServer::BridgeServer() = default;
BridgeServer::~BridgeServer() {
  shutdown_subsystems();
}

BridgeServer& BridgeServer::instance() {
  static BridgeServer server;
  return server;
}

void BridgeServer::acquire() {
  int prev = ref_count_.fetch_add(1, std::memory_order_relaxed);
  if (prev == 0) {
    init_subsystems();
  }
}

void BridgeServer::release() {
  int prev = ref_count_.fetch_sub(1, std::memory_order_acq_rel);
  if (prev == 1) {
    shutdown_subsystems();
  }
}

void BridgeServer::init_subsystems() {
  std::lock_guard lock(tick_mutex_);
  if (subsystems_initialized_) return;

  // Initialize WASM host
  wasm_host_ = std::make_unique<wasm::WasmHost>(param_cache_);
  wasm_host_->init();

  // Start Resolume WS client
  resolume_client_ = std::make_unique<resolume::WsClient>();
  resolume_client_->connect();

  // Start WS server for web UI
  ws_server_ = std::make_unique<WsServer>();
  ws_server_->set_message_callback([this](const std::string& msg) {
    // TODO: handle incoming messages from web UI
    // (e.g., WASM module upload, config changes)
  });
  ws_server_->start(8081);

  subsystems_initialized_ = true;
}

void BridgeServer::shutdown_subsystems() {
  std::lock_guard lock(tick_mutex_);
  if (!subsystems_initialized_) return;

  if (ws_server_) {
    ws_server_->stop();
    ws_server_.reset();
  }

  if (resolume_client_) {
    resolume_client_->disconnect();
    resolume_client_.reset();
  }

  if (wasm_host_) {
    wasm_host_->shutdown();
    wasm_host_.reset();
  }

  subsystems_initialized_ = false;
}

void BridgeServer::tick() {
  std::lock_guard lock(tick_mutex_);
  if (!subsystems_initialized_) return;

  process_resolume_messages();
  flush_outbox();
}

void BridgeServer::process_resolume_messages() {
  if (!resolume_client_) return;

  auto messages = resolume_client_->poll();
  for (auto& msg : messages) {
    if (auto* ps = std::get_if<resolume::ParameterSubscribed>(&msg)) {
      // Cache the value and remember the path for later writes
      if (ps->value.is_number()) {
        param_cache_.set(ps->id, ps->value.get<double>());
      }
      param_paths_[ps->id] = ps->path;
    } else if (auto* pu = std::get_if<resolume::ParameterUpdate>(&msg)) {
      if (pu->value.is_number()) {
        param_cache_.set(pu->id, pu->value.get<double>());
      }
    }
    // CompositionState and ErrorMessage handled as needed later
  }
}

void BridgeServer::flush_outbox() {
  if (!resolume_client_) return;

  auto writes = param_cache_.drain_outbox();
  for (auto& [param_id, value] : writes) {
    auto it = param_paths_.find(param_id);
    if (it != param_paths_.end()) {
      resolume_client_->set(it->second, param_id, value);
    }
  }
}

int32_t BridgeServer::load_wasm(const uint8_t* bytecode, uint32_t len) {
  std::lock_guard lock(tick_mutex_);
  if (!wasm_host_) return -1;
  return wasm_host_->load_module(bytecode, len);
}

void BridgeServer::unload_wasm(int32_t module_id) {
  std::lock_guard lock(tick_mutex_);
  if (!wasm_host_) return;
  wasm_host_->unload_module(module_id);
}

int32_t BridgeServer::call_wasm(int32_t module_id, const char* func_name) {
  std::lock_guard lock(tick_mutex_);
  if (!wasm_host_) return -1;
  return wasm_host_->call_function(module_id, func_name);
}

} // namespace bridge
