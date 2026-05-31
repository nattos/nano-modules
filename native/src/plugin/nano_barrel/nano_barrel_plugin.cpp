// nano_barrel_plugin.cpp — NanoBarrel FFGL plugin (v0).
//
// One barrel hosts one sketch. Each plugin instance owns a BridgeCore
// + a WsServer on its own auto-allocated port; the editor connects
// to that port and speaks the existing JSON-patch protocol against a
// per-instance plugin state subtree at /plugins/<key>/state.
//
// Params (18 total, all registered at construction so Resolume sees
// them during the prototype scan):
//   0  config   FILE  — `nanobarrel://config?<base64-of-sketch-json>`
//                       persisted by Resolume in the composition file.
//                       PATH-prefixed so Resolume's inspector treats it
//                       as a file path (no text-widget chug — probe 3).
//   1  port    TEXT   — the WS port the bridge bound. Read by the editor
//                       to know where to connect. Always overwritten on
//                       InitGL with whatever port we managed to grab.
//   2..17 macro_00..15 STANDARD — user-mappable floats. The editor
//                                 configures which sketch field each
//                                 macro drives. Up-edge (<0.5 → ≥0.5)
//                                 is published as a trigger event.
//
// Process-wide config cache: the latest sketch JSON observed during a
// Resolume process is cached in a static. When the user does delete+undo
// on the barrel effect, the new instance's ctor reads the cache and
// restores the sketch into the StateDocument before any patches arrive.
//
// No effect rendering yet. Passthrough + green corner badge.

#include <array>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <OpenGL/gl3.h>

#include <nlohmann/json.hpp>

#include <ffgl/FFGLPluginSDK.h>
#include <ffgl/FFGLPluginInfo.h>
#include <ffgl/FFGLLib.h>

#include "bridge/bridge_core.h"
#include "bridge/state_document.h"
#include "bridge/ws_server.h"

#include "barrel_log.h"
#include "barrel_codec.h"

namespace {

constexpr unsigned int P_CONFIG    = 0;
constexpr unsigned int P_PORT      = 1;
constexpr unsigned int P_MACRO_00  = 2;
constexpr unsigned int N_MACROS    = 16;
constexpr unsigned int N_PARAMS    = P_MACRO_00 + N_MACROS;

constexpr double kRegenDebounceMs = 200.0;
constexpr int    kPortStart       = 9090;
constexpr int    kPortRetries     = 100;

// Process-wide cache of the latest sketch JSON. Guarded by g_cache_mu.
// The cache is the bridge between an old instance (e.g., before a
// delete+undo cycle in Resolume) and its replacement.
std::mutex&  g_cache_mu()    { static std::mutex m; return m; }
std::string& g_cache_blob()  { static std::string s; return s; }

}  // namespace

// ============================================================================
class NanoBarrelPlugin : public CFFGLPlugin {
 public:
  NanoBarrelPlugin() : CFFGLPlugin() {
    BARREL_LOG("ctor", "this=%p", (void*)this);

    SetMinInputs(1);
    SetMaxInputs(1);
    SetTimeSupported(true);

    config_blob_.clear();
    port_str_.clear();
    macros_.fill(0.0f);
    macros_prev_.fill(0.0f);

    // -- Register FFGL params (fixed surface — probe 1 confirmed dynamic
    //    registration after init is silently ignored by Resolume). --
    {
      std::vector<std::string> exts = {"nanocfg"};
      SetFileParamInfo(P_CONFIG, "config", exts, "");
      BARREL_LOG("SetFileParamInfo",
                 "idx=%u name=config type=FILE default=<empty>", P_CONFIG);
    }
    SetParamInfo(P_PORT, "port", FF_TYPE_TEXT, "");
    BARREL_LOG("SetParamInfo",
               "idx=%u name=port type=TEXT default=<empty>", P_PORT);
    for (unsigned int i = 0; i < N_MACROS; ++i) {
      char name[16];
      snprintf(name, sizeof(name), "macro_%02u", i);
      SetParamInfo(P_MACRO_00 + i, name, FF_TYPE_STANDARD, 0.0f);
    }
    BARREL_LOG("SetParamInfo",
               "16 macros (macro_00..macro_15) registered STANDARD default=0");

    // -- Register the barrel as a "plugin" in the bridge's StateDocument.
    //    The key (e.g. "com.nattos.nanobarrel@0") namespaces our state
    //    subtree at /plugins/<key>/state. --
    bridge::PluginMetadata meta;
    meta.id    = "com.nattos.nanobarrel";
    meta.major = 0;
    meta.minor = 1;
    meta.patch = 0;
    barrel_plugin_key_ =
        bridge_core_.state_document().register_plugin(meta);
    BARREL_LOG("register_plugin", "key=%s", barrel_plugin_key_.c_str());

    // -- Bridge wiring: send-callback now (targets ws_server_ when it
    //    exists); client-patch callback sets dirty_ for debounced
    //    config-regen. --
    bridge_core_.set_send_callback(
        [this](int client_id, const std::string& msg) {
          if (ws_server_) ws_server_->send_to(client_id, msg);
        });
    bridge_core_.set_client_patch_callback(
        [this](const std::string& key) {
          // Called from inside handle_message which is itself inside
          // tick_mu_, so we're already holding the lock here.
          if (key == barrel_plugin_key_) {
            dirty_ = true;
            dirty_since_ms_ = ::nano_barrel_log::now_ms();
          }
        });

    // -- Seed initial state.
    //    sketch starts as the editor's empty-Sketch shape
    //    ({anchor:null, columns:[]}) so a fresh comp's first
    //    snapshot is already a valid Sketch on the wire — the
    //    editor doesn't have to coerce a bare {}. macros start
    //    zero. --
    {
      nlohmann::json initial = {
        {"sketch", {
          {"anchor", nullptr},
          {"columns", nlohmann::json::array()},
        }},
        {"macros", nlohmann::json::array()},
        {"triggers", nlohmann::json::object()},
        {"host", nlohmann::json::object()},
      };
      for (int i = 0; i < (int)N_MACROS; ++i) {
        initial["macros"].push_back(0.0);
      }
      std::lock_guard<std::mutex> lock(tick_mu_);
      bridge_core_.state_document().set_plugin_state(
          barrel_plugin_key_, initial);
    }

    // -- Bootstrap from process-wide cache (latest known sketch state
    //    from a prior instance in this Resolume process). --
    std::string cached;
    {
      std::lock_guard<std::mutex> lock(g_cache_mu());
      cached = g_cache_blob();
    }
    if (!cached.empty()) {
      BARREL_LOG("ctor",
                 "bootstrapping from process cache (json_size=%zu)",
                 cached.size());
      applyConfigJson(cached);
      config_blob_ = barrel_codec::wrap_config(cached);
    }

    BARREL_LOG("ctor-done",
               "params=%u port_pending=true config_blob_size=%zu",
               N_PARAMS, config_blob_.size());
  }

  ~NanoBarrelPlugin() override {
    BARREL_LOG("dtor", "this=%p frame=%d", (void*)this, frame_);
    stopBridge();
  }

  // -- Lifecycle -------------------------------------------------------
  FFResult InitGL(const FFGLViewportStruct* vp) override {
    BARREL_LOG("InitGL", "viewport=%ux%u", vp->width, vp->height);
    CFFGLPlugin::InitGL(vp);
    glGenFramebuffers(1, &src_fbo_);
    // Real instance — safe to spin up the WS server here. Prototype
    // instances never reach InitGL (probe 1), so we never burn ports
    // during plugin discovery.
    startBridge();
    return FF_SUCCESS;
  }

  FFResult DeInitGL() override {
    BARREL_LOG("DeInitGL", "frame=%d", frame_);
    stopBridge();
    if (src_fbo_) { glDeleteFramebuffers(1, &src_fbo_); src_fbo_ = 0; }
    return FF_SUCCESS;
  }

  unsigned int Resize(const FFGLViewportStruct* vp) override {
    BARREL_LOG("Resize", "viewport=%ux%u", vp->width, vp->height);
    return CFFGLPlugin::Resize(vp);
  }

  unsigned int Connect() override {
    BARREL_LOG("Connect", "");
    return CFFGLPlugin::Connect();
  }

  unsigned int Disconnect() override {
    BARREL_LOG("Disconnect", "");
    return CFFGLPlugin::Disconnect();
  }

  void SetHostInfo(const char* hostname, const char* version) override {
    BARREL_LOG("SetHostInfo", "host='%s' version='%s'",
               hostname ? hostname : "", version ? version : "");
    CFFGLPlugin::SetHostInfo(hostname, version);
    // Record into the state doc so the editor can show it.
    nlohmann::json host_info = {
      {"name",    hostname ? hostname : ""},
      {"version", version  ? version  : ""},
    };
    std::lock_guard<std::mutex> lock(tick_mu_);
    bridge_core_.state_document().set_at(
        "/plugins/" + barrel_plugin_key_ + "/state/host", host_info);
  }

  FFResult SetTime(double t) override {
    return CFFGLPlugin::SetTime(t);
  }

  // -- Parameter callbacks --------------------------------------------
  FFResult SetFloatParameter(unsigned int idx, float value) override {
    if (idx >= P_MACRO_00 && idx < P_MACRO_00 + N_MACROS) {
      unsigned int m = idx - P_MACRO_00;
      bool fire_trigger = false;
      uint32_t trig_seq = 0;
      {
        std::lock_guard<std::mutex> lock(tick_mu_);
        macros_[m] = value;
        if (macros_prev_[m] < 0.5f && value >= 0.5f) {
          fire_trigger = true;
          trig_seq = ++trigger_seq_;
          std::string trig_path = "/plugins/" + barrel_plugin_key_ +
                                  "/state/triggers/macro_" + std::to_string(m);
          bridge_core_.state_document().set_at(trig_path, (int)trig_seq);
        }
        macros_prev_[m] = value;
        std::string path = "/plugins/" + barrel_plugin_key_ +
                           "/state/macros/" + std::to_string(m);
        bridge_core_.state_document().set_at(path, (double)value);
      }
      if (fire_trigger) {
        BARREL_LOG("trigger", "macro=%u value=%.3f seq=%u",
                   m, (double)value, trig_seq);
      }
      return FF_SUCCESS;
    }
    BARREL_LOG("SetFloatParameter (unhandled)",
               "idx=%u value=%.6f", idx, (double)value);
    return FF_SUCCESS;
  }

  FFResult SetTextParameter(unsigned int idx, const char* value) override {
    const char* v = value ? value : "";
    size_t len = strlen(v);

    if (idx == P_CONFIG) {
      BARREL_LOG("SetTextParameter",
                 "idx=config size=%zu head=%s",
                 len, BARREL_REDACT(v, 80).c_str());
      std::string received(v, len);
      bool cache_was_empty;
      {
        std::lock_guard<std::mutex> lock(g_cache_mu());
        cache_was_empty = g_cache_blob().empty();
      }
      if (cache_was_empty && !received.empty()) {
        std::string sketch_json = barrel_codec::unwrap_config(received);
        if (!sketch_json.empty()) {
          applyConfigJson(sketch_json);
        } else {
          BARREL_LOG("SetTextParameter",
                     "config: unrecognized payload (not nanobarrel://), keeping empty sketch");
        }
      } else if (!cache_was_empty) {
        BARREL_LOG("SetTextParameter",
                   "config: process cache already populated, ignoring persisted value");
      }
      config_blob_ = received;
      return FF_SUCCESS;
    }
    if (idx == P_PORT) {
      BARREL_LOG("SetTextParameter",
                 "idx=port value=%s our_port=%s (ignored)",
                 BARREL_REDACT(v, 40).c_str(), port_str_.c_str());
      return FF_SUCCESS;
    }
    BARREL_LOG("SetTextParameter (unhandled)",
               "idx=%u value=%s", idx, BARREL_REDACT(v, 40).c_str());
    return FF_SUCCESS;
  }

  float GetFloatParameter(unsigned int idx) override {
    if (idx >= P_MACRO_00 && idx < P_MACRO_00 + N_MACROS) {
      return macros_[idx - P_MACRO_00];
    }
    return 0.0f;
  }

  char* GetTextParameter(unsigned int idx) override {
    if (idx == P_CONFIG) {
      if (config_return_buf_.size() <= config_blob_.size()) {
        config_return_buf_.resize(config_blob_.size() + 1);
      }
      if (!config_blob_.empty()) {
        memcpy(config_return_buf_.data(),
               config_blob_.data(), config_blob_.size());
      }
      config_return_buf_[config_blob_.size()] = '\0';
      return config_return_buf_.data();
    }
    if (idx == P_PORT) {
      snprintf(port_return_buf_, sizeof(port_return_buf_),
               "%s", port_str_.c_str());
      return port_return_buf_;
    }
    small_return_buf_[0] = '\0';
    return small_return_buf_;
  }

  // -- Render ----------------------------------------------------------
  FFResult ProcessOpenGL(ProcessOpenGLStruct* pGL) override {
    ++frame_;
    BARREL_CTX_FRAME(frame_);

    {
      std::lock_guard<std::mutex> lock(tick_mu_);
      bridge_core_.tick();   // drain + broadcast pending state patches
    }

    maybeRegenerateConfig();

    drawPassthroughAndBadge(pGL);
    return FF_SUCCESS;
  }

 private:
  // -- Bridge lifecycle ------------------------------------------------
  void startBridge() {
    if (ws_server_) return;
    static std::atomic<int> next_port{kPortStart};
    for (int tries = 0; tries < kPortRetries; ++tries) {
      int p = next_port.fetch_add(1, std::memory_order_relaxed);
      auto srv = std::make_unique<bridge::WsServer>();
      srv->set_message_callback(
          [this](int cid, const std::string& msg) {
            std::lock_guard<std::mutex> lock(tick_mu_);
            bridge_core_.handle_message(cid, msg);
          });
      srv->set_disconnect_callback(
          [this](int cid) {
            std::lock_guard<std::mutex> lock(tick_mu_);
            bridge_core_.remove_client(cid);
          });
      if (srv->start(p)) {
        ws_server_ = std::move(srv);
        char buf[16];
        snprintf(buf, sizeof(buf), "%d", p);
        port_str_ = buf;
        RaiseParamEvent(P_PORT, FF_EVENT_FLAG_VALUE);
        BARREL_LOG("startBridge",
                   "ws_server bound port=%d (after %d retries)", p, tries);
        return;
      }
    }
    BARREL_LOG("startBridge",
               "FAILED to bind a port after %d retries", kPortRetries);
  }

  void stopBridge() {
    if (!ws_server_) return;
    BARREL_LOG("stopBridge", "port=%s", port_str_.c_str());
    ws_server_->stop();
    ws_server_.reset();
  }

  // -- Config <-> state document --------------------------------------
  // Push a sketch JSON (already-decoded) into the state document.
  void applyConfigJson(const std::string& sketch_json) {
    auto sketch = nlohmann::json::parse(sketch_json, nullptr, false);
    if (sketch.is_discarded()) {
      BARREL_LOG("applyConfigJson", "JSON parse FAILED (size=%zu)",
                 sketch_json.size());
      return;
    }
    {
      std::lock_guard<std::mutex> lock(tick_mu_);
      auto state = bridge_core_.state_document().get_plugin_state(
          barrel_plugin_key_);
      state["sketch"] = sketch;
      bridge_core_.state_document().set_plugin_state(
          barrel_plugin_key_, state);
    }
    {
      std::lock_guard<std::mutex> lock(g_cache_mu());
      g_cache_blob() = sketch_json;
    }
    BARREL_LOG("applyConfigJson",
               "applied sketch (json_size=%zu)", sketch_json.size());
  }

  // If the editor's patched state and the debounce has elapsed,
  // re-serialise the sketch into the FILE param and tell Resolume.
  void maybeRegenerateConfig() {
    bool should_regen = false;
    std::string sketch_json;
    {
      std::lock_guard<std::mutex> lock(tick_mu_);
      if (dirty_ && (::nano_barrel_log::now_ms() - dirty_since_ms_)
                       >= kRegenDebounceMs) {
        auto state = bridge_core_.state_document().get_plugin_state(
            barrel_plugin_key_);
        auto sketch = state.value("sketch", nlohmann::json::object());
        sketch_json = sketch.dump();
        dirty_ = false;
        should_regen = true;
      }
    }
    if (!should_regen) return;

    config_blob_ = barrel_codec::wrap_config(sketch_json);
    {
      std::lock_guard<std::mutex> lock(g_cache_mu());
      g_cache_blob() = sketch_json;
    }
    BARREL_LOG("regenerate",
               "json_size=%zu wrapped_size=%zu",
               sketch_json.size(), config_blob_.size());
    RaiseParamEvent(P_CONFIG, FF_EVENT_FLAG_VALUE);
  }

  // -- Render helper ---------------------------------------------------
  void drawPassthroughAndBadge(ProcessOpenGLStruct* pGL) {
    const unsigned int W = currentViewport.width;
    const unsigned int H = currentViewport.height;
    if (W == 0 || H == 0) return;

    GLint dst_fbo = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &dst_fbo);

    if (pGL->numInputTextures > 0 && pGL->inputTextures &&
        pGL->inputTextures[0] && src_fbo_) {
      const FFGLTextureStruct* in = pGL->inputTextures[0];
      glBindFramebuffer(GL_READ_FRAMEBUFFER, src_fbo_);
      glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                             GL_TEXTURE_2D, in->Handle, 0);
      glBindFramebuffer(GL_DRAW_FRAMEBUFFER, dst_fbo);
      glBlitFramebuffer(0, 0, (GLint)in->Width, (GLint)in->Height,
                        0, 0, (GLint)W, (GLint)H,
                        GL_COLOR_BUFFER_BIT, GL_LINEAR);
      glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, dst_fbo);

    // Green corner badge — distinct from probes (magenta / cyan / orange).
    const int bx = (int)(W * 0.85f);
    const int by = (int)(H * 0.85f);
    const int bw = (int)(W * 0.12f);
    const int bh = (int)(H * 0.12f);
    glEnable(GL_SCISSOR_TEST);
    glScissor(bx, by, bw, bh);
    glClearColor(0.1f, 1.0f, 0.3f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
  }

  // -- State -----------------------------------------------------------
  std::mutex                       tick_mu_;
  bridge::BridgeCore               bridge_core_;
  std::unique_ptr<bridge::WsServer> ws_server_;
  std::string                      barrel_plugin_key_;

  std::string  config_blob_;
  std::string  port_str_;
  std::array<float, N_MACROS> macros_{};
  std::array<float, N_MACROS> macros_prev_{};

  bool    dirty_           = false;
  double  dirty_since_ms_  = 0.0;
  uint32_t trigger_seq_    = 0;

  std::vector<char> config_return_buf_;
  char              port_return_buf_[16]{};
  char              small_return_buf_[64]{};

  int    frame_   = 0;
  GLuint src_fbo_ = 0;
};

// ============================================================================
static CFFGLPluginInfo PluginInfo(
    PluginFactory<NanoBarrelPlugin>,
    "NBRL",
    "NanoBarrel",
    2, 1,
    0, 1,
    FF_EFFECT,
    "Nano sketch barrel — config persisted as a FILE param, "
    "editor connects via the local websocket bridge",
    "nattos");
