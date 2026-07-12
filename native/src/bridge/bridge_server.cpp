#include "bridge/bridge_server.h"

#include "bridge/barrel_runtime.h"
#include "bridge/ws_server.h"
#include "bridge/composition_cache.h"
#include "bridge/trig_log.h"
#include "resolume/ws_client.h"
#include "sketch/trigger_bus.h"
#include "wasm/wasm_host.h"

#include <chrono>
#include <cstdio>
#include <utility>

#include <nlohmann/json.hpp>

namespace bridge {

namespace {
// FNV-1a over a byte string — a cheap change-detector for the published
// /global/channels doc so we skip the set_at (and its patch broadcast) when the
// channel→clips map hasn't changed.
uint64_t fnv1a64(const std::string& s) {
  uint64_t h = 1469598103934665603ull;
  for (unsigned char c : s) { h ^= c; h *= 1099511628211ull; }
  return h;
}
}  // namespace

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
  // NANO_RESOLUME_URL overrides the upstream Resolume WS endpoint (default
  // ws://127.0.0.1:8080/api/v1) — used to point the dylib at a fake Resolume
  // server for headless dev/test (see native/tools/fake_resolume.cpp).
  std::string resolume_url = "ws://127.0.0.1:8080/api/v1";
  if (const char* u = getenv("NANO_RESOLUME_URL"); u && *u) resolume_url = u;
  resolume_client_->connect(resolume_url);

  // Phase 2: when the locator detects a dormant copy-paste duplicate, fork it by
  // writing a fresh-uuid config blob to that barrel's `config` param over WS.
  // The config param carries no learned WS path (we never subscribe to it — its
  // value rides inline in the composition), so address it by id.
  instance_locator_.set_fork_writer(
      [this](int64_t config_param_id, const std::string& blob) {
        if (resolume_client_) {
          resolume_client_->set(
              "/parameter/by-id/" + std::to_string(config_param_id),
              config_param_id, blob);
        }
      });
  // NANO_FORK_DWELL_MS overrides the collision dwell (default 1500ms) — used by
  // e2e so a headless fork resolves quickly.
  if (const char* d = getenv("NANO_FORK_DWELL_MS"); d && atoi(d) > 0)
    instance_locator_.set_dwell_ms((uint64_t)atoi(d));

  // Clip launcher: trigger-rail events → Resolume clip launches, driven by a
  // per-clip re-arm state machine (see clip_launcher.h) that is robust to
  // Resolume's stuck-on / stuck-off / Normal-clip trigger latches. The writer
  // is a raw (path,value) WS trigger; the state machine composes connect /
  // disconnect / evict / re-arm sequences from it.
  clip_launcher_.set_writer(
      [this](const std::string& path, bool value) {
        if (resolume_client_ && !path.empty()) {
          trig_log("LAUNCH %s -> %s", value ? "on" : "off", path.c_str());
          resolume_client_->trigger(path, value);
        }
      });
  if (const char* d = getenv("NANO_LAUNCH_DEBOUNCE_MS"); d && atoi(d) >= 0)
    clip_launcher_.set_debounce_ms((uint64_t)atoi(d));
  if (const char* d = getenv("NANO_LAUNCH_REARM_DWELL_MS"); d && atoi(d) >= 0)
    clip_launcher_.set_rearm_dwell_ms((uint64_t)atoi(d));

  ws_server_ = std::make_shared<WsServer>();
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

  // NANO_BRIDGE_PORT overrides the editor WS port (default 8081) — used by
  // benchmarks/tests so they never collide with a live Arena/Resolume barrel.
  int port = 8081;
  if (const char* p = getenv("NANO_BRIDGE_PORT"); p && atoi(p) > 0) port = atoi(p);
  if (!ws_server_->start(port)) {
    std::fprintf(stderr,
        "[bridge] WsServer failed to bind port %d (already in use?)\n", port);
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
  clip_launcher_.reset();
  trigger_channels_hash_ = 0;
  clip_states_hash_ = 0;
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
        if (e.is_message) {
          // Peek clip-control actions (which need resolume_client_) before the
          // generic observe/get/patch dispatch in BridgeCore.
          if (!handle_client_command(e.cid, e.msg))
            core_.handle_message(e.cid, e.msg);
        } else {
          core_.remove_client(e.cid);
        }
      }
      process_resolume_messages();
      flush_outbox();
      // Drain the process-global trigger rail and launch matching Resolume
      // clips (reconcile loop; see clip_launcher.h). Runs AFTER
      // process_resolume_messages so observed connected states are fresh.
      drive_clip_launches();
      // Surface channel → marker-clip assignments to the web (change-gated).
      publish_trigger_channels();
      // Surface per-clip connected state to the web (change-gated).
      publish_clip_states();
      // Re-run Phase 2 fork detection every tick (not just on composition
      // messages) so the collision dwell fires even when Resolume's composition
      // is static — it only rebroadcasts on change.
      instance_locator_.tick((uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count());
      // Same reason, for placement: a barrel registers on its first RENDER, which
      // for a LAYER-mounted effect lands after the composition broadcast that
      // discovered it and triggers no new one. Publishing only from update()
      // left those instances placement-less (the web's "Other" row) until the
      // composition next changed. Self-deduping, so re-running it is free.
      instance_locator_.publish_placements(core_.state_document());
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
  // Grab a ref under the lock, but run the deflate + send WITHOUT it: preview
  // frames are high-entropy and slow to compress, and the render thread takes
  // tick_mutex_ every frame (key_observed / sketch_state). Holding it across the
  // send serialized render behind preview compression (120→45 FPS). The local
  // shared_ptr keeps the server alive if shutdown resets the member meanwhile.
  std::shared_ptr<WsServer> ws;
  {
    std::lock_guard lock(tick_mutex_);
    ws = ws_server_;
  }
  if (ws) ws->broadcast_binary(data, len);
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
      // Correlate NanoBarrel instances with their composition location and
      // publish default display names. Walks the raw composition JSON (the
      // config UUID rides inline in each barrel's `config` FILE param). The
      // monotonic timestamp drives Phase 2 dwell-based fork detection.
      uint64_t now_ms = (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count();
      instance_locator_.update(cs->data, core_.state_document(), now_ms);
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

void BridgeServer::drive_clip_launches() {
  if (!resolume_client_) return;
  // Snapshot new trigger-rail events (own leaf mutex — safe under tick_mutex_).
  auto events = trigger_bus::drain("bridge_server");

  // Build channel → launchable clips from the current composition cache. Keyed
  // by 1-based trigger channel (CompositionCache.channel is 0-based; the
  // NanoLooper Ch marker's "Channel 1..4" → cache 0..3 → event channel 1..4).
  //
  // Observed connected state comes from the composition CACHE, i.e. Resolume's
  // full-composition rebroadcast (measured ~60ms after a connect/disconnect on
  // a live Arena). We do NOT subscribe to the connected ParamState by id:
  // Resolume does not reliably push parameter_update for it (0 frames observed
  // live) — a per-param subscription would freeze at its initial value and make
  // the reconciler oscillate (it would never see convergence).
  std::map<int, std::vector<LaunchTarget>> channel_clips;
  CompositionCache& cache = core_.composition_cache();
  const int n = cache.clip_count();
  for (int i = 0; i < n; ++i) {
    CachedClip cc = cache.get_clip(i);
    if (cc.channel < 0 || cc.connect_path.empty()) continue;
    LaunchTarget t;
    t.clip_id = cc.clip_id;
    t.connect_path = cc.connect_path;
    t.connected_param_id = cc.connected_param_id;
    t.observed_connected = cc.connected;
    t.is_piano = (cc.trigger_style == "Piano");
    t.evict_path = cc.evict_path;
    channel_clips[cc.channel + 1].push_back(std::move(t));
  }
  if (events.empty() && channel_clips.empty() && pending_strict_.empty()) return;

  // Diagnostics: log drained events + the current channel→clips map when
  // anything fires, so a live repro shows exactly where the pipeline breaks
  // (no events = looper not emitting; events but empty/mismatched map = marker
  // channel unresolved; launch issued but clip doesn't move = WS launch).
  if (!events.empty()) {
    for (const auto& e : events)
      trig_log("event ch=%d on=%d vel=%.2f writer=%s", e.channel, (int)e.on,
               e.velocity, e.writerTag.c_str());
    std::string map = "channel_clips {";
    for (const auto& [ch, targets] : channel_clips) {
      map += " " + std::to_string(ch) + ":[";
      for (const auto& t : targets)
        map += t.connect_path + "(conn=" + (t.observed_connected ? "1" : "0") + ") ";
      map += "]";
    }
    map += " }";
    trig_log("%s", map.c_str());
  }

  const uint64_t now_ms = (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();

  // Partition by precision + evaluate the strict queue (pure fold — see
  // planStrict). "any" events reconcile immediately; strict events wait for a
  // presented frame (barrelPresentSeq) or their deadline flush.
  StrictPlan plan =
      planStrict(events, pending_strict_, now_ms, barrelPresentSeq());
  if (!plan.best_effort.empty())
    trig_log("strict deadline: flushed %zu best-effort trigger(s)",
             plan.best_effort.size());

  // Stale flushes first, so the fully-reconciled newest issues last and wins.
  if (!plan.best_effort.empty())
    clip_launcher_.fireOnce(plan.best_effort, channel_clips);
  clip_launcher_.tick(plan.reconcile, channel_clips, now_ms);
}

void BridgeServer::publish_trigger_channels() {
  // Group every marker-tagged clip by its 1-based trigger channel (matching the
  // event/rail vocabulary) into a compact doc the web Instances tab renders as
  // channel columns. Only markers with a resolved uuid are launchable/previewable.
  CompositionCache& cache = core_.composition_cache();
  const int n = cache.clip_count();
  nlohmann::json channels = nlohmann::json::object();
  for (int i = 0; i < n; ++i) {
    CachedClip cc = cache.get_clip(i);
    if (cc.channel < 0) continue;
    const std::string ch = std::to_string(cc.channel + 1);
    if (!channels.contains(ch))
      channels[ch] = {{"name", ""}, {"clips", nlohmann::json::array()}};
    // First non-empty marker name on the channel labels the whole column.
    if (channels[ch]["name"].get<std::string>().empty() && !cc.channel_name.empty())
      channels[ch]["name"] = cc.channel_name;
    channels[ch]["clips"].push_back({
        {"key", cc.marker_uuid},
        {"clip", cc.name},
        {"connected", cc.connected},
    });
  }

  const std::string dump = channels.dump();
  const uint64_t h = fnv1a64(dump);
  if (h == trigger_channels_hash_) return;  // unchanged — skip the patch
  trigger_channels_hash_ = h;
  core_.state_document().set_at("/global/channels", channels);
}

void BridgeServer::publish_clip_states() {
  // Per-clip connected state, keyed "<layer>:<clip>" (0-based), so the web
  // Instances tab can show a clip-scope instance's play/stop state (it knows its
  // own layer/clip from resolume.placement). Covers ALL clips, not just markered
  // ones — a plain barrel clip has no /global/channels entry but still needs the
  // button. Change-gated by the same FNV hash pattern as the channels doc.
  CompositionCache& cache = core_.composition_cache();
  const int n = cache.clip_count();
  nlohmann::json states = nlohmann::json::object();
  for (int i = 0; i < n; ++i) {
    CachedClip cc = cache.get_clip(i);
    if (cc.layer_index < 0 || cc.clip_index < 0) continue;
    states[std::to_string(cc.layer_index) + ":" + std::to_string(cc.clip_index)] =
        cc.connected;
  }

  const std::string dump = states.dump();
  const uint64_t h = fnv1a64(dump);
  if (h == clip_states_hash_) return;  // unchanged — skip the patch
  clip_states_hash_ = h;
  core_.state_document().set_at("/global/clip_states", states);
}

bool BridgeServer::handle_client_command(int /*client_id*/, const std::string& msg) {
  auto j = nlohmann::json::parse(msg, nullptr, /*allow_exceptions=*/false);
  if (j.is_discarded() || !j.contains("action") || !j["action"].is_string())
    return false;
  const std::string action = j["action"].get<std::string>();

  // Connect (`on`) / disconnect a clip. Addressed by marker uuid (`key`) OR by
  // 0-based composition layer/clip indices.
  if (action == "trigger_clip") {
    // Type-guarded extraction — this runs on the pump thread, so a malformed
    // field must never throw (an uncaught json type_error would kill the pump).
    const bool on = j["on"].is_boolean() ? j["on"].get<bool>() : true;
    CachedClip cc;
    bool found = false;
    if (j["key"].is_string()) {
      found = core_.composition_cache().find_by_marker(j["key"].get<std::string>(), cc);
    } else if (j["layer"].is_number_integer() && j["clip"].is_number_integer()) {
      found = core_.composition_cache().find_by_placement(
          j["layer"].get<int>(), j["clip"].get<int>(), cc);
    }
    if (!found) { trig_log("trigger_clip: no clip matched"); return true; }

    if (cc.channel >= 0) {
      // Route through the shared trigger rail as a momentary edge, exactly like a
      // NanoLooper Ch trigger — drive_clip_launches() drains it THIS tick and the
      // ClipLauncher reconciles the connect/evict/re-arm against observed state
      // (a bare direct connect/evict latches Resolume and gets stuck; the
      // launcher is what un-sticks it). Web is just another rail emitter.
      trigger_bus::emit(trigger_bus::kGlobalRail, cc.channel + 1, on, 1.0f, "web");
      trig_log("trigger_clip ch=%d %s (via rail)", cc.channel + 1, on ? "on" : "off");
    } else if (resolume_client_) {
      // Unchanneled clip (a barrel with no Ch marker) has no rail to reconcile
      // on: connect / release directly. No eviction — that's the latch that
      // sticks; the rail path owns the robust off for channeled clips.
      if (!cc.connect_path.empty()) resolume_client_->trigger(cc.connect_path, on);
      trig_log("trigger_clip %s -> %s (direct)", on ? "on" : "off", cc.connect_path.c_str());
    }
    return true;
  }

  // Reassign a markered clip to a new 1-based trigger channel by writing its
  // NanoLooper Ch marker's "Channel" text param over the Resolume WS.
  if (action == "reassign_channel") {
    if (!resolume_client_) return true;
    if (!j["key"].is_string()) return true;
    int channel = j["channel"].is_number_integer() ? j["channel"].get<int>() : 0;
    if (channel < 1) channel = 1;
    CachedClip cc;
    if (!core_.composition_cache().find_by_marker(j["key"].get<std::string>(), cc)) {
      trig_log("reassign_channel: no clip matched"); return true;
    }
    if (cc.channel_param_id == 0) {
      trig_log("reassign_channel: clip has no Channel param id"); return true;
    }
    // Channel is now an FF_TYPE_TEXT param — write the integer as a string.
    resolume_client_->set("/parameter/by-id/" + std::to_string(cc.channel_param_id),
                          cc.channel_param_id, std::to_string(channel));
    trig_log("reassign_channel key=%s -> ch=%d (param %lld)",
             j["key"].get<std::string>().c_str(), channel,
             (long long)cc.channel_param_id);
    return true;
  }

  return false;
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
