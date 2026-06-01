// nano_barrel_plugin.mm — NanoBarrel FFGL plugin.
//
// Hosts one sketch + a per-instance BridgeCore/WsServer for the editor
// + a Metal-backed effect runtime that actually executes the sketch
// each frame. The frame body walks the sketch graph stored in the
// bridge's state document, looks each module up in the static module
// registry (currently brightness_contrast / soft_glow / motion_blur),
// applies the instance's persisted state, and dispatches the effect's
// compute kernels through `effect_runtime`. GL↔Metal interop is the
// IOSurface-backed `InteropTexture` we share with StreakyBlobs.
//
// Multi-instance-per-effect-type is NOT supported (effects use
// file-static state; documented hard invariant of EffectRuntime).
// Unknown module types passthrough — the executor just skips them.
//
// Params (18 total, all registered at construction so Resolume sees
// them during the prototype scan):
//   0  config   FILE  — `nanobarrel://config?<base64-of-sketch-json>`.
//   1  port    TEXT   — the WS port the bridge bound.
//   2..17 macro_00..15 STANDARD — user-mappable floats.

#include <array>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include <OpenGL/gl3.h>

#import <Metal/Metal.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

#include <nlohmann/json.hpp>

#include <ffgl/FFGLPluginSDK.h>
#include <ffgl/FFGLPluginInfo.h>
#include <ffgl/FFGLLib.h>

#include "bridge/bridge_core.h"
#include "bridge/state_document.h"
#include "bridge/ws_server.h"

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"

#import "InteropTexture.h"
#include "barrel_log.h"
#include "barrel_codec.h"

// Effect entry points (native compile of wasm_modules/<effect>/main.cpp
// linked via the effects_native static library). Each namespace exposes
// the same {init, tick, render, on_state_patched} surface that
// EffectRuntime calls into via EffectDesc function pointers.
namespace brightness_contrast {
  extern void init();
  extern void tick(double dt);
  extern void render(int vp_w, int vp_h);
  extern void on_state_patched(int n, const char* pb, const int* off,
                                const int* len, const int* ops);
}
namespace soft_glow {
  extern void init();
  extern void tick(double dt);
  extern void render(int vp_w, int vp_h);
  extern void on_state_patched(int n, const char* pb, const int* off,
                                const int* len, const int* ops);
}
namespace motion_blur {
  extern void init();
  extern void tick(double dt);
  extern void render(int vp_w, int vp_h);
  extern void on_state_patched(int n, const char* pb, const int* off,
                                const int* len, const int* ops);
}

namespace effect_runtime {
  void setHostTime(double t);
  void setHostDeltaTime(double dt);
  void setHostViewport(int w, int h);
}

// MSL shader headers — bundled into effects_native at build time.
#include "brightness_contrast_msl.h"
#include "soft_glow_msl.h"
#include "motion_blur_msl.h"

namespace {

constexpr unsigned int P_CONFIG    = 0;
constexpr unsigned int P_PORT      = 1;
constexpr unsigned int P_MACRO_00  = 2;
constexpr unsigned int N_MACROS    = 16;
constexpr unsigned int N_PARAMS    = P_MACRO_00 + N_MACROS;

constexpr double kRegenDebounceMs = 200.0;
constexpr int    kPortStart       = 9090;
constexpr int    kPortRetries     = 100;

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

    {
      std::vector<std::string> exts = {"nanocfg"};
      SetFileParamInfo(P_CONFIG, "config", exts, "");
    }
    SetParamInfo(P_PORT, "port", FF_TYPE_TEXT, "");
    for (unsigned int i = 0; i < N_MACROS; ++i) {
      char name[16];
      snprintf(name, sizeof(name), "macro_%02u", i);
      SetParamInfo(P_MACRO_00 + i, name, FF_TYPE_STANDARD, 0.0f);
    }

    // Bring up the Metal runtime + register all known effects + run their
    // `init()`s up-front (must happen before the host scans params, since
    // some host-thread hooks fire during init). EffectRuntime documents
    // single-instance-per-effect-type as a hard invariant.
    initEffectRuntime();

    bridge::PluginMetadata meta;
    meta.id    = "com.nattos.nanobarrel";
    meta.major = 0;
    meta.minor = 1;
    meta.patch = 0;
    barrel_plugin_key_ =
        bridge_core_.state_document().register_plugin(meta);
    BARREL_LOG("register_plugin", "key=%s", barrel_plugin_key_.c_str());

    bridge_core_.set_send_callback(
        [this](int client_id, const std::string& msg) {
          if (ws_server_) ws_server_->send_to(client_id, msg);
        });
    bridge_core_.set_client_patch_callback(
        [this](const std::string& key) {
          if (key == barrel_plugin_key_) {
            dirty_ = true;
            dirty_since_ms_ = ::nano_barrel_log::now_ms();
          }
        });

    {
      nlohmann::json column_one = {
        {"name", "Column 1"},
        {"chain", nlohmann::json::array()},
      };
      nlohmann::json initial = {
        {"sketch", {
          {"anchor", nullptr},
          {"columns", nlohmann::json::array({column_one})},
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
               "params=%u port_pending=true config_blob_size=%zu effects=%zu",
               N_PARAMS, config_blob_.size(),
               registry_ ? registry_->size() : 0);
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
    startBridge();
    return FF_SUCCESS;
  }

  FFResult DeInitGL() override {
    BARREL_LOG("DeInitGL", "frame=%d", frame_);
    stopBridge();
    if (src_fbo_) { glDeleteFramebuffers(1, &src_fbo_); src_fbo_ = 0; }
    input_interop_.reset();
    output_interop_.reset();
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
      return FF_SUCCESS;
    }
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
      bridge_core_.tick();
    }
    maybeRegenerateConfig();

    if (pGL->numInputTextures < 1 || !pGL->inputTextures ||
        !pGL->inputTextures[0]) {
      drawBadgeOnly(pGL);
      return FF_SUCCESS;
    }
    const FFGLTextureStruct* pInput = pGL->inputTextures[0];
    const unsigned int W = currentViewport.width;
    const unsigned int H = currentViewport.height;
    if (W == 0 || H == 0) return FF_SUCCESS;
    if (!rt_ || !gpu_) {
      drawBadgeOnly(pGL);
      return FF_SUCCESS;
    }

    ensureInterop((int)pInput->Width, (int)pInput->Height, (int)W, (int)H);
    if (!input_interop_ || !output_interop_) {
      drawBadgeOnly(pGL);
      return FF_SUCCESS;
    }

    blitGlInputToInterop(pGL, pInput);

    // Adopt both interop MTLTextures as runtime-side handles for this frame.
    int32_t inputHandle = gpu_->adoptExternalTexture(
        (__bridge void*)input_interop_->getMetalTexture());
    int32_t outputHandle = gpu_->adoptExternalTexture(
        (__bridge void*)output_interop_->getMetalTexture());

    // Frame-time bookkeeping for effects that care.
    double hostT = hostTime / 1000.0;
    if (!time_initialized_) {
      time_start_ = hostT;
      time_prev_  = hostT;
      time_initialized_ = true;
    }
    double rawDt = hostT - time_prev_;
    double dt    = std::max(0.0, std::min(rawDt, 0.1));
    time_prev_   = hostT;
    effect_runtime::setHostTime(hostT - time_start_);
    effect_runtime::setHostDeltaTime(dt);
    effect_runtime::setHostViewport((int)W, (int)H);

    // Pull the current sketch out of the bridge's state document and
    // hand it to the shared executor. The executor owns the augmenter,
    // intermediate pool, and tap routing; the plugin's only job here
    // is the FFGL ↔ Metal interop around it.
    nlohmann::json sketch_json;
    {
      std::lock_guard<std::mutex> lock(tick_mu_);
      sketch_json = bridge_core_.state_document().get_at(
          "/plugins/" + barrel_plugin_key_ + "/state/sketch");
    }
    int32_t finalHandle = executor_
        ? executor_->execute(sketch_json,
                              inputHandle, outputHandle,
                              (int)W, (int)H, dt)
        : inputHandle;

    gpu_->submit();
    rt_->drainConsoleLog();
    gpu_->release(inputHandle);
    gpu_->release(outputHandle);

    blitInteropToGlOutput(pGL, finalHandle == outputHandle);
    drawBadgeOnly(pGL);
    return FF_SUCCESS;
  }

 private:
  // -- Effect runtime setup -------------------------------------------
  // Builds the Metal-backed EffectRuntime, registers every shader MSL
  // string from the effects_native bundle by the name each effect
  // expects to find at `state::registerShaderSPV`, populates the
  // ModuleRegistry with the editor module_types we statically link,
  // and creates the SketchExecutor that walks them per frame.
  void initEffectRuntime() {
    device_ = MTLCreateSystemDefaultDevice();
    if (!device_) {
      BARREL_LOG("initEffectRuntime", "MTLCreateSystemDefaultDevice failed");
      return;
    }
    gpu_ = gpu::createMetalBackend();
    if (!gpu_) {
      BARREL_LOG("initEffectRuntime", "createMetalBackend failed");
      return;
    }
    rt_ = std::make_unique<effect_runtime::EffectRuntime>(gpu_.get());

    rt_->registerShaderMSL("compute",          BRIGHTNESS_CONTRAST_COMPUTE_MSL);
    rt_->registerShaderMSL("pixel",            BRIGHTNESS_CONTRAST_PIXEL_MSL);
    rt_->registerShaderMSL("soft_glow_color",  SOFT_GLOW_COLOR_MSL);
    rt_->registerShaderMSL("soft_glow_motion", SOFT_GLOW_MOTION_MSL);
    rt_->registerShaderMSL("reconstruct",      MOTION_BLUR_RECONSTRUCT_MSL);
    rt_->registerShaderMSL("pyramid_reduce",   MOTION_BLUR_PYRAMID_REDUCE_MSL);

    registry_ = std::make_unique<sketch_executor::ModuleRegistry>(rt_.get());
    registry_->registerEffect(
        "video.brightness_contrast", "Brightness Contrast",
        &brightness_contrast::init, &brightness_contrast::tick,
        &brightness_contrast::render, &brightness_contrast::on_state_patched);
    registry_->registerEffect(
        "gen.soft_glow", "Soft Glow",
        &soft_glow::init, &soft_glow::tick,
        &soft_glow::render, &soft_glow::on_state_patched);
    registry_->registerEffect(
        "video.motion_blur", "Motion Blur",
        &motion_blur::init, &motion_blur::tick,
        &motion_blur::render, &motion_blur::on_state_patched);

    executor_ = std::make_unique<sketch_executor::SketchExecutor>(
        rt_.get(), registry_.get(), gpu_.get());

    rt_->drainConsoleLog();
    BARREL_LOG("initEffectRuntime",
               "effects=%zu", registry_->size());
  }


  // -- Interop management ---------------------------------------------
  // (Re)create the input/output `InteropTexture` pair on viewport size
  // changes. Both interops are CVPixelBuffer-backed so the GL FBO side
  // and the Metal MTLTexture side share IOSurface storage — zero-copy
  // ping-pong between the host's GL pipeline and the executor's Metal
  // dispatches.
  void ensureInterop(int inW, int inH, int outW, int outH) {
    if (!device_) return;
    if (!input_interop_ ||
        input_interop_->getWidth() != inW ||
        input_interop_->getHeight() != inH) {
      input_interop_ = std::make_unique<InteropTexture>(
          device_, [NSOpenGLContext currentContext], true,
          MTLPixelFormatBGRA8Unorm, inW, inH);
    }
    if (!output_interop_ ||
        output_interop_->getWidth() != outW ||
        output_interop_->getHeight() != outH) {
      output_interop_ = std::make_unique<InteropTexture>(
          device_, [NSOpenGLContext currentContext], true,
          MTLPixelFormatBGRA8Unorm, outW, outH);
    }
  }

  // -- GL bridge helpers ----------------------------------------------
  // Blit the host's GL input texture into the input InteropTexture's
  // GL-side FBO. Zero shader work — just glBlitFramebuffer between two
  // FBOs. Handles both GL_TEXTURE_2D and GL_TEXTURE_RECTANGLE inputs;
  // glFramebufferTexture2D's target argument is the texture target.
  void blitGlInputToInterop(ProcessOpenGLStruct* pGL,
                            const FFGLTextureStruct* pInput) {
    GLenum target = GL_TEXTURE_RECTANGLE;
    if (pInput->HardwareWidth > pInput->Width ||
        pInput->HardwareHeight > pInput->Height) {
      target = GL_TEXTURE_2D;
    }

    GLint prevRead = 0, prevDraw = 0;
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, src_fbo_);
    glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                           target, pInput->Handle, 0);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, input_interop_->getOpenGLFBO());
    glBlitFramebuffer(0, 0, (GLint)pInput->Width, (GLint)pInput->Height,
                      0, 0, input_interop_->getWidth(),
                            input_interop_->getHeight(),
                      GL_COLOR_BUFFER_BIT, GL_LINEAR);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
    glFlush();
  }

  // Blit the output InteropTexture back to the host FBO (Y-flipped so
  // GL bottom-left and Metal top-left line up).
  void blitInteropToGlOutput(ProcessOpenGLStruct* pGL, bool outputUsed) {
    if (!output_interop_) return;
    const unsigned int W = currentViewport.width;
    const unsigned int H = currentViewport.height;

    GLint prevRead = 0, prevDraw = 0;
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
    glBindFramebuffer(GL_READ_FRAMEBUFFER,
                      outputUsed ? output_interop_->getOpenGLFBO()
                                 : input_interop_->getOpenGLFBO());
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, pGL->HostFBO);
    glBlitFramebuffer(0, (GLint)H, (GLint)W, 0,
                      0, 0, (GLint)W, (GLint)H,
                      GL_COLOR_BUFFER_BIT, GL_NEAREST);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
  }

  void drawBadgeOnly(ProcessOpenGLStruct* pGL) {
    const unsigned int W = currentViewport.width;
    const unsigned int H = currentViewport.height;
    if (W == 0 || H == 0) return;
    GLint dst_fbo = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &dst_fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, dst_fbo);
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

  // -- State -----------------------------------------------------------
  std::mutex                       tick_mu_;
  bridge::BridgeCore               bridge_core_;
  std::unique_ptr<bridge::WsServer> ws_server_;
  std::string                      barrel_plugin_key_;

  // Effect runtime. The plugin owns everything above the executor;
  // the executor manages its own intermediate textures + per-frame
  // tap state.
  id<MTLDevice>                                            device_ = nil;
  std::unique_ptr<gpu::GPUBackend>                         gpu_;
  std::unique_ptr<effect_runtime::EffectRuntime>           rt_;
  std::unique_ptr<sketch_executor::ModuleRegistry>         registry_;
  std::unique_ptr<sketch_executor::SketchExecutor>         executor_;

  // GL ↔ Metal interop.
  std::unique_ptr<InteropTexture>  input_interop_;
  std::unique_ptr<InteropTexture>  output_interop_;

  // Time.
  double                           time_start_ = 0.0;
  double                           time_prev_  = 0.0;
  bool                             time_initialized_ = false;

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
    "Nano sketch barrel — runs the sketch's effects on Resolume's input "
    "and exposes its state over a local WebSocket",
    "nattos");
