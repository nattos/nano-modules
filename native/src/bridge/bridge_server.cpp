#include "bridge/bridge_server.h"

#include "bridge/ws_server.h"
#include "resolume/ws_client.h"
#include "wasm/wasm_host.h"

#include <chrono>
#include <cstdio>
#include <utility>

#include <nlohmann/json.hpp>

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

  // NOTE: the WasmHost (and its WAMR runtime) is created LAZILY in load_wasm,
  // NOT here. The FFGL barrel already runs its own WAMR runtime in-process to
  // execute effects; if this dylib also called wasm_runtime_init() eagerly on
  // acquire(), the two runtimes' process-global SIGSEGV stack-guard handlers
  // collide and abort ("Could not determine thread index for stack guard
  // region"). Only the looper path uses bridge_load_wasm, so defer WAMR init
  // until it's actually needed — the barrel never triggers a second runtime.

  resolume_client_ = std::make_unique<resolume::WsClient>();
  resolume_client_->connect();

  ws_server_ = std::make_unique<WsServer>();
  // The ix callbacks ONLY enqueue — never touch tick_mutex_ or core_ (see
  // the deadlock note in the header). The pump thread drains + processes.
  ws_server_->set_message_callback([this](int client_id, const std::string& msg) {
    std::lock_guard lock(inbox_mu_);
    inbox_.push_back({client_id, /*is_message=*/true, msg});
  });
  ws_server_->set_disconnect_callback([this](int client_id) {
    std::lock_guard lock(inbox_mu_);
    inbox_.push_back({client_id, /*is_message=*/false, std::string()});
  });

  // Wire up BridgeCore's send callback to the WS server. send_to snapshots
  // the target socket under clients_mutex_ and sends outside it, so this is
  // safe to call from the pump thread while holding tick_mutex_.
  core_.set_send_callback([this](int client_id, const std::string& msg) {
    ws_server_->send_to(client_id, msg);
  });

  if (!ws_server_->start(8081)) {
    std::fprintf(stderr,
        "[bridge] WsServer failed to bind port 8081 (already in use?)\n");
  }

  pump_stop_.store(false, std::memory_order_release);
  pump_thread_ = std::thread([this] { pump_loop(); });

  subsystems_initialized_ = true;
}

void BridgeServer::shutdown_subsystems() {
  {
    std::lock_guard lock(tick_mutex_);
    if (!subsystems_initialized_) return;
    // Mark down first so any concurrent ABI op bails out, then drop the lock
    // so the pump (which takes tick_mutex_ each iteration) can finish its
    // current pass and observe pump_stop_.
    subsystems_initialized_ = false;
  }

  // Stop + join the pump BEFORE tearing down the WS server, so no in-flight
  // broadcast touches a destroyed ws_server_. Join outside tick_mutex_.
  pump_stop_.store(true, std::memory_order_release);
  if (pump_thread_.joinable()) pump_thread_.join();

  std::lock_guard lock(tick_mutex_);
  if (ws_server_) { ws_server_->stop(); ws_server_.reset(); }
  if (resolume_client_) { resolume_client_->disconnect(); resolume_client_.reset(); }
  if (wasm_host_) { wasm_host_->shutdown(); wasm_host_.reset(); }

  {
    std::lock_guard ilock(inbox_mu_);
    inbox_.clear();
  }
  draw_lists_.clear();
  frame_states_.clear();
}

void BridgeServer::pump_loop() {
  using namespace std::chrono_literals;
  while (!pump_stop_.load(std::memory_order_acquire)) {
    {
      // Drain WS inbox, then do resolume polling + state broadcast, all
      // under tick_mutex_ so doc reads/writes from render threads (which
      // also take tick_mutex_ via the ABI) stay serialized.
      std::vector<InboxEvent> events;
      {
        std::lock_guard ilock(inbox_mu_);
        events.swap(inbox_);
      }
      // ws_server_/core_/resolume_client_ stay alive until after the pump is
      // joined, so it's safe to use them here even once subsystems_initialized_
      // has been flipped false at the start of shutdown.
      std::lock_guard lock(tick_mutex_);
      for (auto& e : events) {
        if (e.is_message) core_.handle_message(e.cid, e.msg);
        else core_.remove_client(e.cid);
      }
      process_resolume_messages();
      flush_outbox();
      core_.broadcast_state_patches();
    }
    std::this_thread::sleep_for(5ms);
  }
}

void BridgeServer::tick() {
  // The pump thread now drives message processing + resolume polling +
  // broadcasting. tick() is retained as a no-op for ABI back-compat (the
  // looper calls bridge_tick() every frame).
}

// --- Multiplexed plugin instances ---

std::string BridgeServer::register_plugin(const std::string& id, int major, int minor,
    int patch, const std::string& schema_json, const std::string& requested_key) {
  std::lock_guard lock(tick_mutex_);
  PluginMetadata meta{id, major, minor, patch};
  if (schema_json.empty()) {
    return core_.state_document().register_plugin(meta, requested_key);
  }
  return core_.state_document().register_plugin_with_schema(meta, schema_json, requested_key);
}

void BridgeServer::unregister_plugin(const std::string& key) {
  std::lock_guard lock(tick_mutex_);
  core_.state_document().unregister_plugin(key);
}

void BridgeServer::register_patch_listener(const std::string& key,
    BridgeCore::ClientPatchCallback cb) {
  // BridgeCore guards its own listener registry; no tick_mutex_ needed and
  // taking it here could deadlock against the pump (which holds tick_mutex_
  // while invoking listeners).
  core_.register_patch_listener(key, std::move(cb));
}

void BridgeServer::unregister_patch_listener(const std::string& key) {
  core_.unregister_patch_listener(key);
}

void BridgeServer::set_plugin_state(const std::string& key, const std::string& state_json) {
  auto j = nlohmann::json::parse(state_json, nullptr, false);
  if (j.is_discarded()) return;
  std::lock_guard lock(tick_mutex_);
  core_.state_document().set_plugin_state(key, j);
}

std::string BridgeServer::get_plugin_state(const std::string& key) {
  std::lock_guard lock(tick_mutex_);
  return core_.state_document().get_plugin_state(key).dump();
}

void BridgeServer::set_at(const std::string& path, const std::string& value_json) {
  auto j = nlohmann::json::parse(value_json, nullptr, false);
  if (j.is_discarded()) return;
  std::lock_guard lock(tick_mutex_);
  core_.state_document().set_at(path, j);
}

std::string BridgeServer::get_at(const std::string& path) {
  std::lock_guard lock(tick_mutex_);
  return core_.state_document().get_at(path).dump();
}

void BridgeServer::broadcast_binary(const void* data, size_t len) {
  std::lock_guard lock(tick_mutex_);
  if (ws_server_) ws_server_->broadcast_binary(data, len);
}

bool BridgeServer::has_clients() {
  std::lock_guard lock(tick_mutex_);
  return ws_server_ && ws_server_->has_open_clients();
}

bool BridgeServer::key_observed(const std::string& key) {
  std::lock_guard lock(tick_mutex_);
  return core_.observers().is_anyone_observing("/plugins/" + key + "/state");
}

void BridgeServer::process_resolume_messages() {
  if (!resolume_client_) return;

  auto messages = resolume_client_->poll();
  for (auto& msg : messages) {
    if (auto* cs = std::get_if<resolume::CompositionState>(&msg)) {
      auto comp = resolume::parse_composition(cs->data);
      core_.composition_cache().rebuild(comp);
      if (cs->data.contains("tempocontroller") &&
          cs->data["tempocontroller"].contains("tempo")) {
        auto& tempo = cs->data["tempocontroller"]["tempo"];
        if (tempo.contains("value") && tempo["value"].is_number()) {
          core_.composition_cache().set_bpm(tempo["value"].get<double>());
        }
      }
    } else if (auto* ps = std::get_if<resolume::ParameterSubscribed>(&msg)) {
      if (ps->value.is_number()) core_.param_cache().set(ps->id, ps->value.get<double>());
      core_.set_param_path(ps->id, ps->path);
    } else if (auto* pu = std::get_if<resolume::ParameterUpdate>(&msg)) {
      if (pu->value.is_number()) core_.param_cache().set(pu->id, pu->value.get<double>());
    }
  }
}

void BridgeServer::flush_outbox() {
  if (!resolume_client_) return;
  auto writes = core_.param_cache().drain_outbox();
  for (auto& [param_id, value] : writes) {
    auto path = core_.get_param_path(param_id);
    if (!path.empty()) {
      resolume_client_->set(path, param_id, value);
    }
  }
}

// --- WASM module management ---

int32_t BridgeServer::load_wasm(const uint8_t* bytecode, uint32_t len) {
  std::lock_guard lock(tick_mutex_);
  // Lazily bring up the WASM host (and its WAMR runtime) on first use — see
  // the note in init_subsystems about avoiding a second WAMR runtime in
  // barrel-hosted processes. Only the looper reaches here.
  if (!wasm_host_) {
    wasm_host_ = std::make_unique<wasm::WasmHost>(core_.param_cache());
    wasm_host_->init();
  }
  if (!wasm_host_) return -1;
  int32_t id = wasm_host_->load_module(bytecode, len);
  if (id >= 0) {
    draw_lists_[id] = {};
    frame_states_[id] = {};
    wasm_host_->set_state_doc(id, &core_.state_document());
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
