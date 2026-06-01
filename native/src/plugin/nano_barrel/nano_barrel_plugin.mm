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
#include "sketch/sketch_augment.h"

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
               N_PARAMS, config_blob_.size(), module_registry_.size());
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
    for (int32_t h : intermediates_) {
      if (h > 0 && gpu_) gpu_->release(h);
    }
    intermediates_.clear();
    intermediates_w_ = intermediates_h_ = 0;
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

    // Walk the sketch.
    nlohmann::json sketch_json;
    {
      std::lock_guard<std::mutex> lock(tick_mu_);
      sketch_json = bridge_core_.state_document().get_at(
          "/plugins/" + barrel_plugin_key_ + "/state/sketch");
    }
    int32_t finalHandle = executeSketch(sketch_json,
                                        inputHandle, outputHandle,
                                        (int)W, (int)H, dt);

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

    // Register shader MSL by name. Effects call
    // `state::registerShaderSPV(name, ...)` in their init(); the runtime
    // ignores the SPV bytes and uses these pre-registered MSL strings
    // for shader-module compile.
    rt_->registerShaderMSL("compute",        BRIGHTNESS_CONTRAST_COMPUTE_MSL);
    rt_->registerShaderMSL("pixel",          BRIGHTNESS_CONTRAST_PIXEL_MSL);
    rt_->registerShaderMSL("soft_glow_color",  SOFT_GLOW_COLOR_MSL);
    rt_->registerShaderMSL("soft_glow_motion", SOFT_GLOW_MOTION_MSL);
    rt_->registerShaderMSL("reconstruct",      MOTION_BLUR_RECONSTRUCT_MSL);
    rt_->registerShaderMSL("pyramid_reduce",   MOTION_BLUR_PYRAMID_REDUCE_MSL);

    registerEffect("video.brightness_contrast", "Brightness Contrast",
                   &brightness_contrast::init, &brightness_contrast::tick,
                   &brightness_contrast::render, &brightness_contrast::on_state_patched);
    registerEffect("gen.soft_glow", "Soft Glow",
                   &soft_glow::init, &soft_glow::tick,
                   &soft_glow::render, &soft_glow::on_state_patched);
    registerEffect("video.motion_blur", "Motion Blur",
                   &motion_blur::init, &motion_blur::tick,
                   &motion_blur::render, &motion_blur::on_state_patched);

    rt_->drainConsoleLog();
  }

  void registerEffect(const std::string& moduleType,
                      const std::string& displayName,
                      void (*init)(), void (*tick)(double),
                      void (*render)(int, int),
                      void (*on_state_patched)(int, const char*, const int*,
                                                const int*, const int*)) {
    effect_runtime::EffectDesc d;
    d.id   = moduleType;
    d.name = displayName;
    d.init             = init;
    d.tick             = tick;
    d.render           = render;
    d.on_state_patched = on_state_patched;
    auto* inst = rt_->registerEffect(d);
    if (!inst) {
      BARREL_LOG("registerEffect", "registerEffect returned nullptr for %s",
                 moduleType.c_str());
      return;
    }
    inst->doInit();
    RegisteredModule reg;
    reg.inst = inst;
    auto parsed = nlohmann::json::parse(inst->schemaJson(), nullptr, false);
    if (!parsed.is_discarded() && parsed.is_object()) {
      reg.schemaFields = parsed.value("fields", nlohmann::json::object());
    } else {
      reg.schemaFields = nlohmann::json::object();
    }
    BARREL_LOG("registerEffect", "id=%s fields=%zu",
               moduleType.c_str(),
               reg.schemaFields.is_object() ? reg.schemaFields.size() : 0);
    module_registry_[moduleType] = std::move(reg);
  }

  // -- Sketch execution ----------------------------------------------
  // Returns the GPU handle of the final pixels — either `outputHandle`
  // (if any effect ran into it) or `inputHandle` (passthrough).
  //
  // Render-prep pipeline:
  //   1. Augment the raw sketch with implicit struct-rail connections
  //      via the shared `sketch_augment` library. After this step the
  //      sketch carries synthetic rails on the column and explicit
  //      read/write taps on each module — the same graph the editor's
  //      controller.ts produces today, but generated here so the
  //      barrel doesn't rely on the editor having done it.
  //   2. Walk each column following the explicit taps. Texture rails
  //      route a single texture per tap; struct rails snapshot every
  //      texture leaf in the rail's schema and re-emit it under the
  //      consumer's tap fieldPath (so producer's
  //      `render_outputs/motion` lands at consumer's
  //      `render_outputs/motion` — or `render_outputs_in/motion` if
  //      the consumer's tap names it that way).
  int32_t executeSketch(const nlohmann::json& rawSketch,
                        int32_t inputHandle, int32_t outputHandle,
                        int W, int H, double dt) {
    if (!rawSketch.is_object()) return inputHandle;

    // Build module_type → schema-fields map for the augmenter.
    std::unordered_map<std::string, nlohmann::json> schemas;
    schemas.reserve(module_registry_.size());
    for (const auto& kv : module_registry_) {
      schemas.emplace(kv.first, kv.second.schemaFields);
    }
    nlohmann::json sketch =
        sketch_augment::augmentSketchWithImplicitConnections(rawSketch, schemas);

    auto columns = sketch.value("columns", nlohmann::json::array());
    if (!columns.is_array() || columns.empty()) return inputHandle;
    auto instances = sketch.value("instances", nlohmann::json::object());
    auto sketchRails = sketch.value("rails", nlohmann::json::array());

    int32_t finalHandle = inputHandle;
    bool anyDispatched = false;

    for (size_t colIdx = 0; colIdx < columns.size(); ++colIdx) {
      const auto& col = columns[colIdx];
      auto chain = col.value("chain", nlohmann::json::array());
      if (!chain.is_array() || chain.empty()) continue;

      // Build per-column rail-by-id (column rails + sketch-wide rails).
      std::unordered_map<std::string, nlohmann::json> railsById;
      auto indexRails = [&](const nlohmann::json& rails) {
        if (!rails.is_array()) return;
        for (const auto& r : rails) {
          if (!r.is_object()) continue;
          std::string id = r.value("id", std::string());
          if (!id.empty()) railsById[id] = r;
        }
      };
      indexRails(col.value("rails", nlohmann::json::array()));
      indexRails(sketchRails);

      // railId → leafPath → texture handle. The empty-string leaf is
      // reserved for single-texture rails.
      std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>> railTextures;

      int32_t colInput = inputHandle;

      std::vector<size_t> resolvable;
      for (size_t i = 0; i < chain.size(); ++i) {
        const auto& entry = chain[i];
        std::string mt = entry.value("module_type", std::string());
        if (module_registry_.count(mt)) resolvable.push_back(i);
      }
      if (resolvable.empty()) continue;

      const bool isLastCol = (colIdx == columns.size() - 1);
      for (size_t k = 0; k < resolvable.size(); ++k) {
        size_t i = resolvable[k];
        const auto& entry = chain[i];
        const std::string mt      = entry.value("module_type", std::string());
        const std::string instKey = entry.value("instance_key", std::string());

        auto it = module_registry_.find(mt);
        if (it == module_registry_.end()) continue;
        const RegisteredModule& reg = it->second;
        auto* inst = reg.inst;

        const bool isLastInColumn = (k == resolvable.size() - 1);
        const bool isFinalStage   = isLastCol && isLastInColumn;

        int32_t outHandle;
        if (isFinalStage) outHandle = outputHandle;
        else              outHandle = nextIntermediate(W, H);

        // Persisted state.
        if (instances.is_object() && instances.contains(instKey)) {
          const auto& instJson = instances[instKey];
          const auto& state = instJson.value("state", nlohmann::json::object());
          applyState(inst, state);
        }

        // Primary channels.
        inst->setTextureField("tex_in",  colInput);
        inst->setTextureField("tex_out", outHandle);
        inst->setFieldConnected("tex_in",  true,  false);
        inst->setFieldConnected("tex_out", false, true);

        // -- Read taps before render --
        applyReadTaps(inst, entry, railsById, railTextures);
        // -- Pre-render: mark write-tap fields as output-connected
        //    (eg soft_glow's render_outputs early-exits its motion
        //    pass unless `isOutputConnected("render_outputs")`). --
        markWriteTapOutputsConnected(inst, entry);

        inst->doTick(dt);
        inst->doRender(W, H);

        // -- Write taps after render --
        captureWriteTaps(inst, entry, railsById, railTextures);

        anyDispatched = true;
        finalHandle = outHandle;
        colInput = outHandle;
      }
    }
    return anyDispatched ? finalHandle : inputHandle;
  }

  // Read taps fire before the consumer's render. For a struct rail we
  // walk the rail's schema for texture leaves and forward each from the
  // captured producer handles into the consumer's `tap.fieldPath + leaf`.
  // For a texture rail (single texture) the empty-string leaf is the
  // payload.
  void applyReadTaps(
      effect_runtime::EffectInstance* inst,
      const nlohmann::json& entry,
      const std::unordered_map<std::string, nlohmann::json>& railsById,
      const std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railTextures) {
    if (!entry.contains("taps") || !entry["taps"].is_array()) return;
    for (const auto& tap : entry["taps"]) {
      if (tap.value("direction", std::string()) != "read") continue;
      const std::string railId = tap.value("railId", std::string());
      const std::string fieldPath = tap.value("fieldPath", std::string());
      auto railIt = railsById.find(railId);
      if (railIt == railsById.end()) continue;
      auto texIt = railTextures.find(railId);
      if (texIt == railTextures.end()) continue;

      const auto& dataType = railIt->second.value("dataType", nlohmann::json());
      forEachRailLeafTexture(dataType, [&](const std::string& leaf) {
        auto lit = texIt->second.find(leaf);
        if (lit == texIt->second.end() || lit->second <= 0) return;
        const std::string target = leaf.empty() ? fieldPath
                                                : (fieldPath + "/" + leaf);
        inst->setTextureField(target, lit->second);
      });
      inst->setFieldConnected(fieldPath, true, false);
    }
  }

  // Write taps fire after the producer's render. Mirror image of read:
  // for each texture leaf in the rail's schema, capture the producer's
  // handle from `tap.fieldPath + leaf` into railTextures[railId][leaf].
  void captureWriteTaps(
      effect_runtime::EffectInstance* inst,
      const nlohmann::json& entry,
      const std::unordered_map<std::string, nlohmann::json>& railsById,
      std::unordered_map<std::string,
        std::unordered_map<std::string, int32_t>>& railTextures) {
    if (!entry.contains("taps") || !entry["taps"].is_array()) return;
    for (const auto& tap : entry["taps"]) {
      if (tap.value("direction", std::string()) != "write") continue;
      const std::string railId = tap.value("railId", std::string());
      const std::string fieldPath = tap.value("fieldPath", std::string());
      auto railIt = railsById.find(railId);
      if (railIt == railsById.end()) continue;

      const auto& dataType = railIt->second.value("dataType", nlohmann::json());
      auto& texMap = railTextures[railId];
      forEachRailLeafTexture(dataType, [&](const std::string& leaf) {
        const std::string source = leaf.empty() ? fieldPath
                                                : (fieldPath + "/" + leaf);
        int32_t h = inst->textureField(source);
        if (h > 0) texMap[leaf] = h;
      });
    }
  }

  void markWriteTapOutputsConnected(
      effect_runtime::EffectInstance* inst,
      const nlohmann::json& entry) {
    if (!entry.contains("taps") || !entry["taps"].is_array()) return;
    for (const auto& tap : entry["taps"]) {
      if (tap.value("direction", std::string()) != "write") continue;
      const std::string fieldPath = tap.value("fieldPath", std::string());
      inst->setFieldConnected(fieldPath, false, true);
    }
  }

  // Visit each texture-leaf path in a rail's dataType. Texture rails
  // emit a single empty-string leaf. Struct rails walk their schema's
  // nested texture fields. Other rail types yield nothing.
  template <class F>
  static void forEachRailLeafTexture(const nlohmann::json& dataType, F&& f) {
    if (dataType.is_string()) {
      if (dataType.get<std::string>() == "texture") f(std::string());
      return;
    }
    if (dataType.is_object() &&
        dataType.value("kind", std::string()) == "struct") {
      const auto& schema = dataType.value("schema", nlohmann::json());
      std::vector<std::string> leaves;
      sketch_augment::collectTextureLeaves(schema, "", leaves);
      for (auto& l : leaves) f(l);
    }
  }

  void applyState(effect_runtime::EffectInstance* inst,
                  const nlohmann::json& state) {
    if (!state.is_object()) return;
    for (auto it = state.begin(); it != state.end(); ++it) {
      const auto& v = it.value();
      const std::string& name = it.key();
      if (v.is_number()) {
        inst->setParamFloat(name, (float)v.get<double>());
      } else if (v.is_boolean()) {
        inst->setParamFloat(name, v.get<bool>() ? 1.0f : 0.0f);
      } else if (v.is_array()) {
        std::vector<float> comps;
        for (const auto& x : v) {
          if (x.is_number()) comps.push_back((float)x.get<double>());
        }
        if (!comps.empty()) inst->setParamArray(name, comps);
      } else if (v.is_string()) {
        // Strings round-trip as JSON-quoted text through setParamJson;
        // most effects ignore them, but keep the path open.
        inst->setParamJson(name, "\"" + v.get<std::string>() + "\"");
      }
    }
  }

  int32_t nextIntermediate(int W, int H) {
    if (W != intermediates_w_ || H != intermediates_h_) {
      for (int32_t h : intermediates_) { if (h > 0 && gpu_) gpu_->release(h); }
      intermediates_.clear();
      intermediates_w_ = W; intermediates_h_ = H;
    }
    if (intermediate_cursor_ >= (int)intermediates_.size()) {
      // Allocate RGBA8 (code 1). brightness_contrast et al. write
      // through Metal's storageTexture API; format conversion is handled
      // by the backend.
      int32_t h = gpu_->createTexture((uint32_t)W, (uint32_t)H, 1);
      intermediates_.push_back(h);
    }
    return intermediates_[intermediate_cursor_++];
  }

  // -- Interop management ---------------------------------------------
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
    // Rotating intermediates reset cursor per frame.
    intermediate_cursor_ = 0;
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

  // Effect runtime.
  id<MTLDevice>                                       device_ = nil;
  std::unique_ptr<gpu::GPUBackend>                    gpu_;
  std::unique_ptr<effect_runtime::EffectRuntime>      rt_;
  struct RegisteredModule {
    effect_runtime::EffectInstance* inst = nullptr;
    /** Parsed schema "fields" sub-object — fed to
     *  augmentSketchWithImplicitConnections() each frame so it knows
     *  every module's full schema. */
    nlohmann::json schemaFields;
  };
  std::unordered_map<std::string, RegisteredModule> module_registry_;

  // GL ↔ Metal interop + intermediate pool.
  std::unique_ptr<InteropTexture>  input_interop_;
  std::unique_ptr<InteropTexture>  output_interop_;
  std::vector<int32_t>             intermediates_;
  int                              intermediates_w_ = 0;
  int                              intermediates_h_ = 0;
  int                              intermediate_cursor_ = 0;

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
