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
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
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
#include "runtime/text_host.h"
#include "sketch/module_registry.h"
#include "sketch/wasm_bundles.h"

#include <dlfcn.h>
#include <fstream>
#include "sketch/sketch_executor.h"

#import "InteropTexture.h"
#include "barrel_log.h"
#include "barrel_codec.h"

// gen.text / gen.richtext are native, TextEngine/MSDF-backed effects (no MSL
// shaders; they need a font install). For now they are still linked statically
// (from effects_native) and registered explicitly in initEffectRuntime — every
// OTHER effect loads as a WASM bundle. (Migrating the text effects to their
// text.wasm / richtext.wasm bundles is the remaining static-effect cleanup.)
#define DECLARE_EFFECT_NS(ns)                                                 \
  namespace ns {                                                              \
    extern void  module_init();                                               \
    extern void* create();                                                    \
    extern void  destroy(void* self);                                         \
    extern void  init(void* self);                                            \
    extern void  tick(void* self, double dt);                                 \
    extern void  render(void* self, int vp_w, int vp_h);                      \
    extern void  on_state_patched(void* self, int n, const char* pb,          \
                                  const int* off, const int* len,             \
                                  const int* ops);                            \
  }
DECLARE_EFFECT_NS(gen_text)
DECLARE_EFFECT_NS(gen_richtext)
#undef DECLARE_EFFECT_NS

namespace effect_runtime {
  void setHostTime(double t);
  void setHostDeltaTime(double dt);
  void setHostViewport(int w, int h);
}

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
          if (key != barrel_plugin_key_) return;
          // Fired from inside bridge_core_.handle_message — now drained on the
          // RENDER thread under tick_mu_ (WS messages are queued into ws_inbox_
          // and processed in ProcessOpenGL), so this is already on the render
          // thread. We still just park dirty flags rather than refresh inline:
          // dirty_ / dirty_since_ms_ feed the debounced config regen, and
          // preview_requests_ is refreshed by the existing dirty-flag path —
          // keeping this a pure flag-flip avoids reentrancy with that machinery.
          dirty_ = true;
          dirty_since_ms_ = ::nano_barrel_log::now_ms();
          preview_requests_dirty_.store(true, std::memory_order_release);
          // The sketch changed → drop the cached snapshot so the next frame
          // re-fetches it (see the sketch_snapshot_ cache in ProcessOpenGL).
          sketch_snapshot_dirty_.store(true, std::memory_order_release);
        });

    {
      nlohmann::json column_one = {
        {"name", "Column 1"},
        {"chain", nlohmann::json::array()},
      };
      // Publish the registered effects' schemas so the web client can
      // populate its inspector + augmenter without instantiating any
      // effects locally. Shape mirrors web/src/state/types.ts PluginInfo;
      // `params` and `io` are derived web-side from the schema fields,
      // so we publish only the raw schema + identity here.
      nlohmann::json plugin_schemas = nlohmann::json::object();
      if (registry_) {
        for (const auto& [module_type, schema_fields] :
             registry_->schemas()) {
          plugin_schemas[module_type] = {
            {"key",     module_type},
            {"id",      module_type},
            {"version", "0.0.0"},
            {"schema",  schema_fields},
          };
        }
      }
      nlohmann::json initial = {
        {"sketch", {
          {"anchor", nullptr},
          {"columns", nlohmann::json::array({column_one})},
        }},
        {"macros", nlohmann::json::array()},
        {"triggers", nlohmann::json::object()},
        {"host", nlohmann::json::object()},
        {"plugin_schemas", plugin_schemas},
        // Editor preview-request inbox. Pre-populating with an empty
        // object lets the editor target it with a JSON Patch `replace`
        // (it would also accept `add`, but every other path here is
        // pre-populated so this stays consistent).
        {"preview_requests", nlohmann::json::object()},
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
    // Order matters here. Resolume has already returned from any
    // ProcessOpenGL call by the time the dtor fires, so no NEW
    // readbacks will be issued. We drain in two steps:
    // (1) wait for every Metal completion handler to finish enqueuing
    //     its bytes into send_queue_ AND for the worker to ship them
    //     (in_flight_previews_ counts both, decremented post-send),
    // (2) signal the worker to stop and join. Only after both does
    //     stopBridge tear down ws_server_, which both the handlers and
    //     the worker dereference.
    int spins = 0;
    while (in_flight_previews_.load() > 0 && spins < 200) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      ++spins;
    }
    {
      std::lock_guard<std::mutex> lock(send_mu_);
      send_thread_stop_.store(true, std::memory_order_release);
    }
    send_cv_.notify_one();
    if (send_thread_.joinable()) send_thread_.join();
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

    // Drain WS events the WS thread queued lock-free, then process them on THIS
    // (render) thread under tick_mu_ — so the WS thread never takes tick_mu_
    // while ix holds the WsServer mutex (the disconnect-deadlock fix). The swap
    // is done first under the leaf inbox lock, so tick_mu_ never nests it.
    std::vector<WsInboxEvent> ws_events;
    {
      std::lock_guard<std::mutex> lk(ws_inbox_mu_);
      ws_events.swap(ws_inbox_);
    }
    {
      std::lock_guard<std::mutex> lock(tick_mu_);
      for (auto& e : ws_events) {
        if (e.is_message) bridge_core_.handle_message(e.cid, e.msg);
        else              bridge_core_.remove_client(e.cid);
      }
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
    // Compute this ONCE, OUTSIDE tick_mu_. has_open_clients() takes the WsServer
    // mutex; acquiring it while holding tick_mu_ deadlocks against a WS
    // disconnect (which holds the WsServer mutex and, in its close callback,
    // wants tick_mu_). Reused for every "publish only when watched" gate below.
    const bool hasClients = ws_server_ && ws_server_->has_open_clients();

    bool sketchRefetched = false;
    {
      std::lock_guard<std::mutex> lock(tick_mu_);
      // Re-snapshot the sketch ONLY when it actually changed — an editor patch
      // (client_patch_callback) or a Resolume config (applyConfigJson) flips
      // sketch_snapshot_dirty_. get_at deep-copies the whole sketch subtree
      // (every instance state, incl. multi-KB richtext html/css), which profiled
      // as the bulk of per-frame JSON churn once the layout was cached. Caching
      // the snapshot is the native analogue of the web's compile-once
      // GraphDefinition: re-walk a stable object each frame instead of
      // re-copying (and re-destroying) the entire sketch.
      sketchRefetched =
          sketch_snapshot_dirty_.exchange(false, std::memory_order_acq_rel);
      if (sketchRefetched) {
        sketch_snapshot_ = bridge_core_.state_document().get_at(
            "/plugins/" + barrel_plugin_key_ + "/state/sketch");
      }
      // Route the live macro knobs into any io.barrel_macros instance's state.
      // The executor's write-tap capture reads scalar outputs from the sketch
      // instance state, so this is what makes the FFGL macros usable inside a
      // sketch (write-tap a macro_N output onto a rail). Done on a local copy of
      // the JSON — the persisted sketch is untouched. macros_ is consistent
      // here (written under tick_mu_ by SetFloatParameter).
      nlohmann::json macroOut = nlohmann::json::object();
      if (sketch_snapshot_.contains("instances") &&
          sketch_snapshot_["instances"].is_object()) {
        for (auto& [key, inst] : sketch_snapshot_["instances"].items()) {
          if (!inst.is_object()) continue;
          if (inst.value("module_type", std::string()) != "io.barrel_macros") {
            continue;
          }
          auto& st = inst["state"];
          if (!st.is_object()) st = nlohmann::json::object();
          nlohmann::json fields = nlohmann::json::object();
          for (unsigned int i = 0; i < N_MACROS; ++i) {
            double v = (double)macros_[i];
            st["macro_" + std::to_string(i)] = v;
            fields["macro_" + std::to_string(i)] = v;
          }
          macroOut[key] = std::move(fields);
        }
      }
      // Publish the macros as per-instance "plugin state" so the editor's output
      // trace cards show live values. The macros are injected into a LOCAL copy
      // of the sketch (above), so without this the web — which mirrors only the
      // persisted sketch — would never see them. One JSON string → one patch op;
      // only while an editor is watching.
      if (hasClients && !macroOut.empty()) {
        bridge_core_.state_document().set_at(
            "/plugins/" + barrel_plugin_key_ + "/state/macro_outputs",
            macroOut.dump());
      }
      // Drain any preview-request changes the WS thread has signalled.
      // Doing the actual map rebuild here keeps it on the render thread
      // (single writer) so publishPreviewFrames can iterate later in
      // the frame without further locking ceremony.
      if (preview_requests_dirty_.exchange(false,
                                            std::memory_order_acq_rel)) {
        refreshPreviewRequests();
      }
    }
    // Decide once per frame whether the capture machinery should run.
    // When off, the executor hooks early-return and publishPreviewFrames
    // never gets called — the cost of having an idle editor connected
    // (or no editor at all) is just this single check.
    captures_enabled_ = hasClients && !preview_requests_.empty();
    // Snapshots for the editor's preview push are gathered during the
    // executor's render via the chain-entry / sketch-output hooks bound
    // in initEffectRuntime. Clear them each frame so a request that's
    // been removed (or whose chain entry no longer exists) doesn't
    // resurrect last frame's pixels.
    if (captures_enabled_) frame_captures_.clear();
    // The in-process native SketchExecutor — the same C++ source compiled to
    // executor.wasm for the web, but linked natively here (interp/AOT through
    // WAMR would be slower / need per-arch artifacts; see the migration notes).
    int32_t finalHandle =
        executor_ ? executor_->execute(sketch_snapshot_, inputHandle, outputHandle,
                                       (int)W, (int)H, dt, sketchRefetched)
                  : inputHandle;

    gpu_->submit();
    rt_->drainConsoleLog();

    // Publish this frame's float-rail values for the editor's spark charts —
    // the native mirror of the web executor's /sketch_state publish. Only when
    // an editor is watching; stored as one JSON string so the state-doc diff
    // emits a single patch (and nothing at all while the rails are static).
    if (executor_ && hasClients) {
      std::lock_guard<std::mutex> lock(tick_mu_);
      bridge_core_.state_document().set_at(
          "/plugins/" + barrel_plugin_key_ + "/state/sketch_state",
          executor_->lastRailState().dump());
    }

    // After submit() returns the GPU work is fully complete; intermediates
    // and the output interop carry this frame's pixels. Publish any
    // requested previews before next frame's execute() rotates the pool.
    if (captures_enabled_) publishPreviewFrames();

    gpu_->release(inputHandle);
    gpu_->release(outputHandle);

    blitInteropToGlOutput(pGL, finalHandle == outputHandle);
    return FF_SUCCESS;
  }

 private:
  // Resolve a file under this bundle's Contents/Resources/fonts/. Uses dladdr
  // on a symbol in our own image to find the bundle, mirroring the bridge-dylib
  // discovery in looper_plugin.cpp. Empty if we can't locate the bundle.
  static std::string bundleFontPath(const char* name) {
    Dl_info info;
    // Any address in our own image works; use this function itself (static
    // member → plain function pointer) so we don't depend on symbol order.
    if (!dladdr(reinterpret_cast<const void*>(&bundleFontPath), &info) || !info.dli_fname)
      return "";
    std::string p = info.dli_fname;                 // …/NanoBarrel.bundle/Contents/MacOS/NanoBarrel
    auto pos = p.find(".bundle/");
    if (pos == std::string::npos) return "";
    p = p.substr(0, pos + 8) + "Contents/Resources/fonts/" + name;
    return p;
  }

  // Resolve an effect bundle .wasm path. NANO_BARREL_WASM_DIR overrides (for
  // ffgl_runner / dev pointing at build/wasm); otherwise the bundled copy under
  // Contents/Resources/wasm/. Empty if the bundle can't be located.
  static std::string bundleWasmPath(const char* name) {
    if (const char* dir = getenv("NANO_BARREL_WASM_DIR"); dir && *dir)
      return std::string(dir) + "/" + name + ".wasm";
    Dl_info info;
    if (!dladdr(reinterpret_cast<const void*>(&bundleWasmPath), &info) ||
        !info.dli_fname)
      return "";
    std::string p = info.dli_fname;
    auto pos = p.find(".bundle/");
    if (pos == std::string::npos) return "";
    return p.substr(0, pos + 8) + "Contents/Resources/wasm/" + name + ".wasm";
  }

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
    registry_ = std::make_unique<sketch_executor::ModuleRegistry>(rt_.get());

    // Effect registration. Effects load from their WASM bundles (core/lights/
    // nano, shipped in Resources/wasm/, each preferring its per-arch .aot
    // sidecar) — the same artifacts the web loads, never linked statically. There
    // is NO static fallback: a load failure means a broken install and is logged.
    // Deliberately DO NOT give the WASM modules the bridge state doc — WASM
    // effects' state.set_val would write to it on the RENDER thread (diff under
    // the doc mutex), which deadlocks against the WS thread on a sketch change
    // (tick_mu_ → doc mutex → WsServer mutex → tick_mu_). Schemas still reach the
    // editor: the barrel publishes them from registry_->schemas() (parsed off the
    // EffectInstance via the host sink), independent of the doc.
    bundles_ = std::make_unique<sketch_executor::WasmEffectBundles>();
    int total = 0;
    if (bundles_->init()) {
      for (const char* name : {"core", "lights", "nano"}) {
        std::string path = bundleWasmPath(name);
        int n = path.empty() ? 0
            : bundles_->loadBundleFile(path, *registry_, gpu_.get(), nullptr);
        BARREL_LOG("initEffectRuntime", "wasm bundle '%s': %d effect(s) from %s",
                   name, n, path.c_str());
        total += n;
      }
    }
    if (total > 0) {
      BARREL_LOG("initEffectRuntime", "loaded %d WASM effect(s)", total);
    } else {
      BARREL_LOG("initEffectRuntime",
                 "ERROR: no WASM effects loaded (bundles missing from Resources/wasm/?)");
      bundles_.reset();
    }

    // Text effects. They need NO registerShaderMSL — the text.* host service
    // owns its MSDF compositor PSO. But the engine needs font BYTES: install the
    // bundled default.ttf as the parity-exact Latin primary (falling back to the
    // system UI font if absent), plus the OS's CJK faces as the fallback chain.
    effect_runtime::textInstallDefaultFonts(bundleFontPath("default.ttf").c_str());
    // init() sets the per-instance `initialized` flag the effects' render()
    // gates on — it MUST be wired or render() early-returns (blank output).
    registry_->registerEffect(
        "gen.text", "Text",
        &gen_text::module_init, &gen_text::create,
        &gen_text::destroy, &gen_text::init,
        &gen_text::tick, &gen_text::render,
        &gen_text::on_state_patched);
    registry_->registerEffect(
        "gen.richtext", "Rich Text",
        &gen_richtext::module_init, &gen_richtext::create,
        &gen_richtext::destroy, &gen_richtext::init,
        &gen_richtext::tick, &gen_richtext::render,
        &gen_richtext::on_state_patched);

    executor_ = std::make_unique<sketch_executor::SketchExecutor>(
        rt_.get(), registry_.get(), gpu_.get());

    // Force-disable GPU fusion when NANO_BARREL_FUSION=0. Production default is
    // on (fuse runs of per-pixel effects into one dispatch). Useful for A/B
    // diagnosis: WASM effects don't fuse yet (register_fusion is a no-op), so
    // comparing WASM vs static with fusion OFF isolates the fusion difference
    // from everything else.
    if (const char* f = getenv("NANO_BARREL_FUSION"); f && (*f == '0')) {
      executor_->setFusionEnabled(false);
      BARREL_LOG("initEffectRuntime", "GPU fusion force-disabled");
    }

    // Wire the executor's capture hooks into the per-frame snapshot map.
    // Hooks fire DURING execute() (between chain-entry encodes), so
    // we only record handles — actual readback happens later this frame,
    // after submit(), when the GPU work has completed.
    executor_->setChainEntryHook(
        [this](int colIdx, int chainIdx,
               int32_t inputHandle, int32_t outputHandle, int W, int H) {
          if (!captures_enabled_) return;
          // Single-sketch barrel → no sketchId in the key.
          char buf[64];
          snprintf(buf, sizeof(buf), "ce:%d/%d/input", colIdx, chainIdx);
          frame_captures_[buf] = {inputHandle, W, H};
          snprintf(buf, sizeof(buf), "ce:%d/%d/output", colIdx, chainIdx);
          frame_captures_[buf] = {outputHandle, W, H};
        });
    executor_->setSketchOutputHook(
        [this](int32_t handle, int W, int H) {
          if (!captures_enabled_) return;
          frame_captures_["so"] = {handle, W, H};
        });
    // Tell the executor's fusion planner which chain entries' outputs
    // need to land in real intermediate textures. A monitor on
    // `ce:<col>/<k>/output` materialises stage k; a monitor on
    // `ce:<col>/<k>/input` materialises the upstream (stage k-1's
    // output). The planner splits fused groups at these barriers so
    // the requested texture is readable post-execute.
    executor_->setBarrierPredicate(
        [this](int colIdx, int chainIdx) -> bool {
          if (!captures_enabled_) return false;
          for (const auto& [_, req] : preview_requests_) {
            const std::string& tk = req.targetKey;
            // Format: "ce:<col>/<chain>/<side>"
            if (tk.rfind("ce:", 0) != 0) continue;
            int rcol = -1, rchain = -1;
            char side[16] = {0};
            if (std::sscanf(tk.c_str(), "ce:%d/%d/%15s",
                            &rcol, &rchain, side) != 3) continue;
            if (rcol != colIdx) continue;
            if (rchain == chainIdx && std::strcmp(side, "output") == 0) {
              return true;
            }
            if (rchain == chainIdx + 1 && std::strcmp(side, "input") == 0) {
              return true;
            }
          }
          return false;
        });

    // Spin up the preview send worker. See member-var comment for why
    // this exists.
    send_thread_ = std::thread([this] { runSendWorker(); });

    rt_->drainConsoleLog();
    BARREL_LOG("initEffectRuntime", "effects=%zu", registry_->size());
  }

  void runSendWorker() {
    while (true) {
      std::vector<uint8_t> bytes;
      {
        std::unique_lock<std::mutex> lock(send_mu_);
        send_cv_.wait(lock, [this] {
          return send_thread_stop_.load(std::memory_order_acquire)
              || !send_queue_.empty();
        });
        if (send_queue_.empty()) {
          if (send_thread_stop_.load(std::memory_order_acquire)) return;
          continue;
        }
        bytes = std::move(send_queue_.front());
        send_queue_.pop_front();
      }
      // ws_server_ outlives the worker (dtor stops + joins us first).
      if (ws_server_) {
        ws_server_->broadcast_binary(bytes.data(), bytes.size());
      }
      in_flight_previews_.fetch_sub(1, std::memory_order_acq_rel);
    }
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
      // Queue WS events lock-free (NO tick_mu_ here — see ws_inbox_ comment).
      // ProcessOpenGL drains + processes them on the render thread under tick_mu_.
      srv->set_message_callback(
          [this](int cid, const std::string& msg) {
            std::lock_guard<std::mutex> lk(ws_inbox_mu_);
            ws_inbox_.push_back({cid, /*is_message=*/true, msg});
          });
      srv->set_disconnect_callback(
          [this](int cid) {
            std::lock_guard<std::mutex> lk(ws_inbox_mu_);
            ws_inbox_.push_back({cid, /*is_message=*/false, std::string()});
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
      // Invalidate the render thread's cached sketch snapshot (set under
      // tick_mu_ so ProcessOpenGL's locked fetch block sees it next frame).
      sketch_snapshot_dirty_.store(true, std::memory_order_release);
    }
    {
      std::lock_guard<std::mutex> lock(g_cache_mu());
      g_cache_blob() = sketch_json;
    }
    BARREL_LOG("applyConfigJson",
               "applied sketch (json_size=%zu)", sketch_json.size());
  }

  // -- Preview helpers ------------------------------------------------
  // Rebuild preview_requests_ from the bridge state document. Caller
  // must hold tick_mu_.
  void refreshPreviewRequests() {
    auto path = "/plugins/" + barrel_plugin_key_ + "/state/preview_requests";
    auto raw = bridge_core_.state_document().get_at(path);
    preview_requests_.clear();
    if (!raw.is_object()) return;
    for (auto it = raw.begin(); it != raw.end(); ++it) {
      const auto& entry = it.value();
      if (!entry.is_object()) continue;
      PreviewRequest req;
      req.traceId = it.key();
      req.width   = (uint32_t)entry.value("width",  128);
      req.height  = (uint32_t)entry.value("height", 72);
      const auto& target = entry.value("target", nlohmann::json::object());
      const std::string ttype = target.value("type", std::string());
      if (ttype == "sketch_output") {
        req.targetKey = "so";
      } else if (ttype == "chain_entry") {
        const int col   = target.value("colIdx",   -1);
        const int chain = target.value("chainIdx", -1);
        const std::string side = target.value("side", std::string("output"));
        if (col < 0 || chain < 0) continue;
        char buf[64];
        snprintf(buf, sizeof(buf), "ce:%d/%d/%s",
                 col, chain, side.c_str());
        req.targetKey = buf;
      } else {
        continue;
      }
      preview_requests_[req.traceId] = std::move(req);
    }
  }

  // Format described inline; the matching decoder lives in
  // web/src/widgets/texture-monitor.ts (handleBinaryFrame).
  static std::vector<uint8_t> buildPreviewFrameBytes(
      const std::string& traceId, uint16_t width, uint16_t height,
      const std::vector<uint8_t>& pixels) {
    const size_t headerSize = 12 + traceId.size();
    std::vector<uint8_t> out;
    out.reserve(headerSize + pixels.size());
    out.resize(headerSize);
    out[0] = 'N'; out[1] = 'B'; out[2] = 'P'; out[3] = 'V';
    out[4] = 1;             // version
    out[5] = 1;             // format: RGBA8
    uint16_t idLen = (uint16_t)traceId.size();
    out[6] = (uint8_t)(idLen & 0xFF);
    out[7] = (uint8_t)(idLen >> 8);
    out[8] = (uint8_t)(width  & 0xFF);
    out[9] = (uint8_t)(width  >> 8);
    out[10] = (uint8_t)(height & 0xFF);
    out[11] = (uint8_t)(height >> 8);
    memcpy(out.data() + 12, traceId.data(), idLen);
    out.insert(out.end(), pixels.begin(), pixels.end());
    return out;
  }

  void publishPreviewFrames() {
    if (!gpu_ || !ws_server_) return;
    // preview_requests_ is single-writer (render thread, inside the
    // tick_mu_ scope above where the dirty flag is drained). It's stable
    // for the rest of this frame, so iterate it directly — no lock.
    if (preview_requests_.empty()) return;
    // If no editor is connected, every readback below is wasted work —
    // the bytes would have nowhere to go. Bail before touching the GPU.
    // Note: preview_requests_ may still hold entries from an editor
    // that just disconnected (we don't actively clear them); they'll
    // be replaced wholesale next time an editor connects and patches
    // /preview_requests, so leaving them stable here is fine.
    if (!ws_server_->has_open_clients()) return;
    bridge::WsServer* ws_server_raw = ws_server_.get();
    // Batch every readback this frame into a single cmd buffer + one
    // completion handler. For a sketch with N chain entries the editor
    // typically mounts ~N+2 monitors (column input + per-effect output
    // + main preview); without batching that's N+2 commits per frame,
    // each carrying Metal driver overhead and a separate completion
    // callback. Batching collapses that to 1 + 1.
    // Chain-entry intermediate thumbnails refresh on every-other-frame
    // (so 30 fps when Resolume is at 60). Each one adds a Metal cmd
    // buffer encode + render-pass setup; on a long chain (eg 10×
    // brightness_contrast) the editor mounts ~12 of them, and the
    // FFGL host's render-thread time spent in AGX state encoding was
    // the dominant cost on the profile. The main edit preview
    // (`so`) keeps running every frame so slider feedback stays
    // smooth.
    const bool include_intermediates = (frame_ & 1) == 0;
    gpu_->beginPreviewBatch();
    for (const auto& [_, req] : preview_requests_) {
      if (!include_intermediates && req.targetKey != "so") continue;
      auto it = frame_captures_.find(req.targetKey);
      if (it == frame_captures_.end()) continue;
      const auto& slot = it->second;
      if (slot.handle <= 0 || slot.width <= 0 || slot.height <= 0) continue;
      // Editor sends 0/0 to mean "capture at the source texture's
      // native resolution" — used by high-res requests like the main
      // edit preview where we want full fidelity, not a 128×72 thumb.
      const uint32_t outW = req.width  ? req.width
                                       : (uint32_t)slot.width;
      const uint32_t outH = req.height ? req.height
                                       : (uint32_t)slot.height;
      // Async readback: the render thread encodes + commits a tiny MPS
      // cmd buffer and returns immediately. The Metal completion
      // handler fires on Metal's serial dispatch queue once the GPU
      // finishes; it does the bare minimum (getBytes + frame
      // assembly + enqueue) before yielding. The actual WS broadcast
      // runs on send_thread_ to keep Metal's completion queue moving
      // — otherwise high-entropy preview content (where
      // permessage-deflate is slow) stalls completions and
      // back-pressures the render thread's [cb commit].
      in_flight_previews_.fetch_add(1, std::memory_order_acq_rel);
      std::string traceId = req.traceId;
      (void)ws_server_raw;  // worker owns the broadcast now
      gpu_->readbackTextureScaledAsync(
          slot.handle,
          (uint32_t)slot.width, (uint32_t)slot.height,
          outW, outH,
          [this, traceId = std::move(traceId), outW, outH]
          (std::vector<uint8_t> pixels) {
            auto bytes = buildPreviewFrameBytes(
                traceId, (uint16_t)outW, (uint16_t)outH, pixels);
            {
              std::lock_guard<std::mutex> lock(send_mu_);
              // Bound the queue so we don't grow memory + latency when
              // the worker can't keep up. ~half a second of headroom
              // at 60fps × 3 monitors; we drop oldest first to prefer
              // freshness over completeness.
              constexpr size_t kMaxQueue = 32;
              while (send_queue_.size() >= kMaxQueue) {
                send_queue_.pop_front();
                in_flight_previews_.fetch_sub(1, std::memory_order_acq_rel);
              }
              send_queue_.push_back(std::move(bytes));
            }
            send_cv_.notify_one();
          });
    }
    gpu_->commitPreviewBatch();
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

  // -- Preview push (per-frame texture snapshots over WS binary) ------
  // The editor publishes a map of { traceId → { target, width, height } }
  // at /plugins/<key>/state/preview_requests. We re-read the full map
  // each time the bridge's client_patch_callback fires (cheap; the map
  // is tiny). Each frame we run the executor with hooks that record the
  // texture handles for every chain entry + the final sketch output,
  // then iterate requests and ship each one as a binary WS frame.
  struct PreviewRequest {
    // Editor-facing trace ID — the only thing routed back to the web.
    std::string traceId;
    // "so:<sketchId>" or "ce:<sketchId>/<col>/<chain>/<side>". Same shape
    // as the web's trace-controller targetKey so the executor hooks can
    // store under matching keys.
    std::string targetKey;
    uint32_t    width  = 128;
    uint32_t    height = 72;
  };
  struct CaptureSlot {
    int32_t  handle = -1;
    int      width  = 0;
    int      height = 0;
  };

  std::mutex                       tick_mu_;
  bridge::BridgeCore               bridge_core_;
  std::unique_ptr<bridge::WsServer> ws_server_;
  std::string                      barrel_plugin_key_;

  // Active preview requests (guarded by tick_mu_). Refreshed lazily on
  // the render thread when `preview_requests_dirty_` is set — the WS
  // patch callback only flips the flag, never mutates the map directly.
  std::unordered_map<std::string, PreviewRequest> preview_requests_;
  std::atomic<bool> preview_requests_dirty_{false};

  // Incoming WS messages + disconnects, queued lock-free by the WS thread and
  // drained on the RENDER thread (under tick_mu_) at the top of ProcessOpenGL.
  // The WS callbacks MUST NOT take tick_mu_ directly: ix invokes them while
  // holding the WsServer mutex, while the render thread takes
  // tick_mu_ → WsServer mutex (via bridge_core_.tick()'s send) — so a direct
  // lock there deadlocks on disconnect. Deferring removes the WsServer→tick_mu_
  // edge, breaking the cycle (same trick as the client-patch dirty flag above).
  struct WsInboxEvent { int cid; bool is_message; std::string msg; };
  std::mutex                ws_inbox_mu_;
  std::vector<WsInboxEvent> ws_inbox_;
  // Outstanding async preview readbacks. Each `readbackTextureScaledAsync`
  // call increments before issuing; the send worker decrements after
  // the broadcast completes. The dtor drains this to zero before
  // tearing the WS server down so handlers don't fire on a destroyed
  // instance.
  std::atomic<int> in_flight_previews_{0};

  // Flipped at the top of each ProcessOpenGL — true iff the WS bridge
  // has an open client AND there's at least one active preview
  // request. The capture hooks consult it before touching
  // frame_captures_ so a disconnected editor doesn't pay for
  // per-chain-entry string formatting + map inserts.
  bool captures_enabled_ = false;

  // Send worker: takes the Metal completion handler off the critical
  // path. Without this, broadcast_binary (which involves
  // ixwebsocket's send queueing + per-message deflate compression on
  // high-entropy preview pixels) runs on Metal's serial completion
  // dispatch queue. When that backs up, Metal can't free committed
  // cmd buffers fast enough and new commits from the render thread
  // start blocking — which is exactly the "content-complexity-driven
  // FPS drop" symptom that motivated this.
  std::thread          send_thread_;
  std::mutex           send_mu_;
  std::condition_variable send_cv_;
  std::deque<std::vector<uint8_t>> send_queue_;
  std::atomic<bool>    send_thread_stop_{false};
  // Per-frame texture snapshots (NOT guarded — only touched on render
  // thread between executor->execute() and the publish loop below it).
  std::unordered_map<std::string, CaptureSlot> frame_captures_;

  // Effect runtime. The plugin owns everything above the executor;
  // the executor manages its own intermediate textures + per-frame
  // tap state.
  id<MTLDevice>                                            device_ = nil;
  std::unique_ptr<gpu::GPUBackend>                         gpu_;
  // Owns the WasmHost backing WASM-loaded effects. Declared before rt_ so it is
  // destroyed AFTER it: rt_'s EffectInstance destructors call_indirect into the
  // WasmHost (and gpu_) to run each effect's destroy(). Null in static mode.
  std::unique_ptr<sketch_executor::WasmEffectBundles>      bundles_;
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

  // Render-thread cache of the sketch JSON. Re-fetched from the state document
  // only when sketch_snapshot_dirty_ is set (editor patch or Resolume config);
  // otherwise the per-frame deep copy + destruction of the whole sketch (the
  // dominant JSON cost after the richtext layout cache) is skipped entirely.
  std::atomic<bool> sketch_snapshot_dirty_{true};
  nlohmann::json    sketch_snapshot_;

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
