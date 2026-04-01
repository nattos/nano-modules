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

  wasm_host_ = std::make_unique<wasm::WasmHost>(param_cache_);
  wasm_host_->init();

  resolume_client_ = std::make_unique<resolume::WsClient>();
  resolume_client_->connect();

  ws_server_ = std::make_unique<WsServer>();
  ws_server_->set_message_callback([this](const std::string& msg) {
    // TODO: handle incoming messages from web UI
  });
  ws_server_->start(8081);

  subsystems_initialized_ = true;
}

void BridgeServer::shutdown_subsystems() {
  std::lock_guard lock(tick_mutex_);
  if (!subsystems_initialized_) return;

  if (ws_server_) { ws_server_->stop(); ws_server_.reset(); }
  if (resolume_client_) { resolume_client_->disconnect(); resolume_client_.reset(); }
  if (wasm_host_) { wasm_host_->shutdown(); wasm_host_.reset(); }

  draw_lists_.clear();
  frame_states_.clear();
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
    if (auto* cs = std::get_if<resolume::CompositionState>(&msg)) {
      auto comp = resolume::parse_composition(cs->data);
      composition_cache_.rebuild(comp);

      // Extract BPM from tempo controller
      if (cs->data.contains("tempocontroller") &&
          cs->data["tempocontroller"].contains("tempo")) {
        auto& tempo = cs->data["tempocontroller"]["tempo"];
        if (tempo.contains("value") && tempo["value"].is_number()) {
          composition_cache_.set_bpm(tempo["value"].get<double>());
        }
      }
    } else if (auto* ps = std::get_if<resolume::ParameterSubscribed>(&msg)) {
      if (ps->value.is_number()) {
        param_cache_.set(ps->id, ps->value.get<double>());
      }
      param_paths_[ps->id] = ps->path;
    } else if (auto* pu = std::get_if<resolume::ParameterUpdate>(&msg)) {
      if (pu->value.is_number()) {
        param_cache_.set(pu->id, pu->value.get<double>());
      }
    }
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
  int32_t id = wasm_host_->load_module(bytecode, len);
  if (id >= 0) {
    draw_lists_[id] = {};
    frame_states_[id] = {};
  }
  return id;
}

void BridgeServer::unload_wasm(int32_t module_id) {
  std::lock_guard lock(tick_mutex_);
  if (!wasm_host_) return;
  wasm_host_->unload_module(module_id);
  draw_lists_.erase(module_id);
  frame_states_.erase(module_id);
}

int32_t BridgeServer::call_wasm(int32_t module_id, const char* func_name) {
  std::lock_guard lock(tick_mutex_);
  if (!wasm_host_) return -1;
  return wasm_host_->call_function(module_id, func_name);
}

void BridgeServer::set_frame_state(int32_t module_id,
    double elapsed, double dt, double bar_phase, double bpm,
    int vp_w, int vp_h) {
  std::lock_guard lock(tick_mutex_);
  auto& fs = frame_states_[module_id];
  fs.elapsed_time = elapsed;
  fs.delta_time = dt;
  fs.bar_phase = bar_phase;
  fs.bpm = bpm;
  fs.viewport_w = vp_w;
  fs.viewport_h = vp_h;
  if (wasm_host_) {
    wasm_host_->set_frame_state(module_id, &fs);
    wasm_host_->set_draw_list(module_id, &draw_lists_[module_id]);
  }
}

void BridgeServer::set_ffgl_param(int32_t module_id, int index, double value) {
  std::lock_guard lock(tick_mutex_);
  if (index >= 0 && index < wasm::FrameState::MAX_PARAMS) {
    frame_states_[module_id].ffgl_params[index] = value;
  }
}

canvas::DrawList* BridgeServer::render(int32_t module_id, int vp_w, int vp_h) {
  std::lock_guard lock(tick_mutex_);
  if (!wasm_host_) return nullptr;

  auto& dl = draw_lists_[module_id];
  dl.clear();

  // Ensure draw list and frame state are set
  wasm_host_->set_draw_list(module_id, &dl);

  wasm_host_->call_function_i32_i32(module_id, "render", vp_w, vp_h);
  return &dl;
}

int32_t BridgeServer::call_tick(int32_t module_id, double dt) {
  std::lock_guard lock(tick_mutex_);
  if (!wasm_host_) return -1;
  return wasm_host_->call_function_f64(module_id, "tick", dt);
}

int32_t BridgeServer::call_on_param(int32_t module_id, int index, double value) {
  std::lock_guard lock(tick_mutex_);
  if (!wasm_host_) return -1;
  return wasm_host_->call_function_i32_f64(module_id, "on_param_change", index, value);
}

void BridgeServer::set_audio_callback(int32_t module_id,
    wasm::AudioTriggerCallback cb, void* userdata) {
  std::lock_guard lock(tick_mutex_);
  if (wasm_host_) {
    wasm_host_->set_audio_callback(module_id, cb, userdata);
  }
}

} // namespace bridge
