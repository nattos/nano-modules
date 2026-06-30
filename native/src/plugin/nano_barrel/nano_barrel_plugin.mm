// nano_barrel_plugin.mm — NanoBarrel FFGL plugin.
//
// Hosts one sketch + a Metal-backed effect runtime that actually executes
// the sketch each frame. The editor bridge is NOT per-instance: every
// NanoBarrel instance in the process registers itself with the shared
// in-process server (libbridge_server.dylib, located via dladdr next to the
// bundle and dlopen'd through BridgeLoader). That singleton owns the ONE
// WebSocket server (port 8081) and the ONE unified state document; each
// instance lives under `/plugins/<key>/state`, where `<key>` is this
// instance's stable persisted UUID. The frame body pulls the sketch out of
// the shared doc, walks the graph against the module registry, applies the
// instance's persisted state, and dispatches the effect's compute kernels
// through `effect_runtime`. GL↔Metal interop is the IOSurface-backed
// `InteropTexture`.
//
// Multi-instance-per-effect-type is NOT supported (effects use
// file-static state; documented hard invariant of EffectRuntime).
// Unknown module types passthrough — the executor just skips them.
//
// Identity: each instance carries a UUID generated once and persisted in
// the FILE param envelope; it registers with the shared server under that
// UUID. Duplicated clips (same persisted UUID) are reminted by the server,
// and the instance adopts + re-persists the returned key.
//
// Params (17 total, all registered at construction so Resolume sees
// them during the prototype scan):
//   0  config   FILE  — `nanobarrel://config?<base64>` of an envelope
//                        `{"uuid":<uuid>,"sketch":<sketch-json>}`.
//   1..16 macro_00..15 STANDARD — user-mappable floats.

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

#include "plugin/bridge_loader.h"
#include "bridge/bridge_api.h"

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

namespace effect_runtime {
  void setHostTime(double t);
  void setHostDeltaTime(double dt);
  void setHostViewport(int w, int h);
}

namespace {

constexpr unsigned int P_CONFIG    = 0;
constexpr unsigned int P_MACRO_00  = 1;
constexpr unsigned int N_MACROS    = 16;
constexpr unsigned int N_PARAMS    = P_MACRO_00 + N_MACROS;

constexpr double kRegenDebounceMs = 200.0;

// Process-global cache of this instance's last persisted payload (the
// `{"uuid":..,"sketch":..}` envelope JSON, NOT wrapped). Only used for the
// in-process delete+undo workflow where Resolume destroys + recreates the
// C++ instance within the same process before re-pushing the saved param;
// the recreated ctor reads this so it can repopulate before SetTextParameter
// fires. Lost on host restart (P_CONFIG is the restart-durable store).
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
    macros_.fill(0.0f);
    macros_prev_.fill(0.0f);

    {
      std::vector<std::string> exts = {"nanocfg"};
      SetFileParamInfo(P_CONFIG, "config", exts, "");
    }
    for (unsigned int i = 0; i < N_MACROS; ++i) {
      char name[16];
      snprintf(name, sizeof(name), "macro_%02u", i);
      SetParamInfo(P_MACRO_00 + i, name, FF_TYPE_STANDARD, 0.0f);
    }

    // The Metal runtime + WASM effect loading is deferred to InitGL, NOT done
    // here. Resolume constructs a throwaway PROTOTYPE of every FFGL plugin at
    // startup just to enumerate params — those prototypes never call InitGL.
    // Loading all 63 effect modules per prototype floods the process-global
    // (refcounted) WAMR heap pool, so a later real clip instance's load fails
    // and it comes up with zero effects (→ empty plugin_schemas → no editor
    // chips). Params are static (config + 16 macros), so the prototype scan
    // needs nothing more than the SetParamInfo calls above. The shared bridge
    // server is likewise acquired in InitGL, not here.

    // Stash the persisted payload (envelope JSON) for InitGL to apply once
    // the bridge is up. On a host cold start this is empty (the host will
    // restore it via SetTextParameter before InitGL); on in-process
    // delete+undo it's the live envelope from the process cache.
    {
      std::lock_guard<std::mutex> lock(g_cache_mu());
      pending_payload_ = g_cache_blob();
    }
    if (!pending_payload_.empty()) {
      config_blob_ = barrel_codec::wrap_config(pending_payload_);
    }

    BARREL_LOG("ctor-done",
               "params=%u config_blob_size=%zu effects=%zu",
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
    //     teardownBridge release the shared server handle the worker's
    //     broadcast dereferences.
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
    // Safety net: DeInitGL normally tears the bridge down, but the host may
    // destroy us without a matching DeInitGL. The send worker is already
    // joined above, so no broadcast can fire after release.
    teardownBridge();
  }

  // -- Lifecycle -------------------------------------------------------
  FFResult InitGL(const FFGLViewportStruct* vp) override {
    BARREL_LOG("InitGL", "viewport=%ux%u", vp->width, vp->height);
    CFFGLPlugin::InitGL(vp);
    glGenFramebuffers(1, &src_fbo_);
    // Load effects now (this is a real, GL-active instance — not a param-scan
    // prototype). Guarded so a repeated InitGL doesn't reload. publishInitialState
    // (in setupBridge) reads registry_->schemas(), so this must run first.
    if (!rt_) initEffectRuntime();
    setupBridge();
    return FF_SUCCESS;
  }

  FFResult DeInitGL() override {
    BARREL_LOG("DeInitGL", "frame=%d", frame_);
    teardownBridge();
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
    host_info_ = host_info;               // applied in setupBridge if early
    if (bridge_ && loader_.bridge_set_at) {
      loader_.bridge_set_at(bridge_,
          ("/plugins/" + barrel_plugin_key_ + "/state/host").c_str(),
          host_info.dump().c_str());
    }
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
          if (bridge_ && loader_.bridge_set_at) {
            std::string trig_path = "/plugins/" + barrel_plugin_key_ +
                                    "/state/triggers/macro_" + std::to_string(m);
            loader_.bridge_set_at(bridge_, trig_path.c_str(),
                                  std::to_string((int)trig_seq).c_str());
          }
        }
        macros_prev_[m] = value;
        if (bridge_ && loader_.bridge_set_at) {
          std::string path = "/plugins/" + barrel_plugin_key_ +
                             "/state/macros/" + std::to_string(m);
          loader_.bridge_set_at(bridge_, path.c_str(),
                                nlohmann::json((double)value).dump().c_str());
        }
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
      config_blob_ = received;
      std::string payload = received.empty()
          ? std::string()
          : barrel_codec::unwrap_config(received);
      if (payload.empty()) {
        BARREL_LOG("SetTextParameter",
                   "config: empty/unrecognized payload, keeping current state");
        return FF_SUCCESS;
      }
      if (bridge_) {
        // Post-init reload (uncommon) — apply directly.
        applyPayload(payload);
      } else if (pending_payload_.empty()) {
        // Cold start: the host is restoring the saved value before InitGL.
        // (On in-process delete+undo pending_payload_ was already seeded
        // from the live process cache, so we keep that and ignore this.)
        pending_payload_ = payload;
      } else {
        BARREL_LOG("SetTextParameter",
                   "config: live payload already pending, ignoring persisted value");
      }
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
    small_return_buf_[0] = '\0';
    return small_return_buf_;
  }

  // -- Render ----------------------------------------------------------
  FFResult ProcessOpenGL(ProcessOpenGLStruct* pGL) override {
    ++frame_;
    BARREL_CTX_FRAME(frame_);

    // WS message handling + state broadcast now live entirely in the shared
    // server's pump thread; this render thread only reads/writes the shared
    // state doc via the BridgeLoader ABI (each call is internally locked).
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

    // Pull the current sketch out of the shared state document and hand it
    // to the executor. The executor owns the augmenter, intermediate pool,
    // and tap routing; the plugin's only job here is the FFGL ↔ Metal interop
    // around it. `watched` gates "publish only when an editor observes THIS
    // instance" — with many instances multiplexed onto one server we don't
    // want one connected editor to make every instance do telemetry/preview
    // work. (If the editor observes the doc root, key_observed is true for
    // all — conservative but correct.)
    const bool watched = bridge_ && loader_.bridge_key_observed &&
                         loader_.bridge_key_observed(bridge_,
                             barrel_plugin_key_.c_str());

    bool sketchRefetched = false;
    {
      std::lock_guard<std::mutex> lock(tick_mu_);
      // Re-snapshot the sketch ONLY when it actually changed — an editor patch
      // (onPatchTrampoline) or a Resolume config (applyConfigJson) flips
      // sketch_snapshot_dirty_. The fetch deep-copies the whole sketch subtree
      // (every instance state, incl. multi-KB richtext html/css), which profiled
      // as the bulk of per-frame JSON churn once the layout was cached. Caching
      // the snapshot is the native analogue of the web's compile-once
      // GraphDefinition: re-walk a stable object each frame instead of
      // re-copying (and re-destroying) the entire sketch.
      sketchRefetched =
          sketch_snapshot_dirty_.exchange(false, std::memory_order_acq_rel);
      if (sketchRefetched) {
        sketch_snapshot_ = getAtJson(
            "/plugins/" + barrel_plugin_key_ + "/state/sketch");
      }
      // Route the live macro knobs into any control.barrel_macros instance's state.
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
          if (inst.value("module_type", std::string()) != "control.barrel_macros") {
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
      if (watched && bridge_ && loader_.bridge_set_at && !macroOut.empty()) {
        loader_.bridge_set_at(bridge_,
            ("/plugins/" + barrel_plugin_key_ + "/state/macro_outputs").c_str(),
            macroOut.dump().c_str());
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
    captures_enabled_ = watched && !preview_requests_.empty();
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
    if (executor_ && watched && bridge_ && loader_.bridge_set_at) {
      loader_.bridge_set_at(bridge_,
          ("/plugins/" + barrel_plugin_key_ + "/state/sketch_state").c_str(),
          executor_->lastRailState().dump().c_str());
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

  // Resolve libbridge_server.dylib, shipped as a SIBLING of the bundle (so a
  // single shared singleton is dlopen'd across barrel + looper bundles — same
  // path → same image). Mirrors looper_plugin.cpp's discovery.
  static std::string bundleDylibPath() {
    Dl_info info;
    if (!dladdr(reinterpret_cast<const void*>(&bundleDylibPath), &info) ||
        !info.dli_fname)
      return "";
    std::string p = info.dli_fname;
    auto pos = p.rfind(".bundle");
    if (pos == std::string::npos) return "";
    p = p.substr(0, pos);
    auto slash = p.rfind('/');
    if (slash != std::string::npos) p = p.substr(0, slash + 1);
    return p + "libbridge_server.dylib";
  }

  static std::string generateUuid() {
    @autoreleasepool {
      NSString* u = [[NSUUID UUID] UUIDString];
      return u ? std::string(u.UTF8String) : std::string();
    }
  }

  // Read a JSON pointer out of the shared doc via the loader ABI, returning a
  // parsed json (object() on any failure). Frees the dylib-allocated string.
  nlohmann::json getAtJson(const std::string& path) {
    if (!bridge_ || !loader_.bridge_get_at || !loader_.bridge_free_string)
      return nlohmann::json::object();
    char* raw = loader_.bridge_get_at(bridge_, path.c_str());
    if (!raw) return nlohmann::json::object();
    auto j = nlohmann::json::parse(raw, nullptr, false);
    loader_.bridge_free_string(raw);
    return j.is_discarded() ? nlohmann::json::object() : j;
  }

  // -- Shared-bridge lifecycle ----------------------------------------
  // Located + acquired in InitGL (NOT the ctor — see ctor note). Registers
  // this instance under its persisted UUID, seeds initial state, applies any
  // pending sketch, and subscribes for editor patches targeting this key.
  void setupBridge() {
    if (bridge_) return;  // already up (InitGL re-entry without DeInitGL)

    std::string dylib = bundleDylibPath();
    if (dylib.empty() || !loader_.load(dylib.c_str())) {
      BARREL_LOG("setupBridge", "FAILED to load %s — running render-only",
                 dylib.c_str());
      return;
    }
    if (!loader_.bridge_init || !loader_.bridge_register_plugin) {
      BARREL_LOG("setupBridge", "dylib missing required symbols");
      return;
    }
    bridge_ = loader_.bridge_init();
    if (!bridge_) { BARREL_LOG("setupBridge", "bridge_init returned null"); return; }

    // Identity: prefer the UUID from the pending payload (cold start / undo),
    // else mint a fresh one + persist it after registration.
    bool need_persist = false;
    if (instance_uuid_.empty()) {
      instance_uuid_ = payloadUuid(pending_payload_);
      if (instance_uuid_.empty()) {
        instance_uuid_ = generateUuid();
        need_persist = true;
      }
    }

    char keybuf[128] = {0};
    int n = loader_.bridge_register_plugin(
        bridge_, "com.nano.nanobarrel", 0, 1, 0,
        /*schema_json=*/"", instance_uuid_.c_str(), keybuf, sizeof(keybuf));
    std::string actual_key(keybuf, (n > 0 && n < (int)sizeof(keybuf)) ? n : (int)strlen(keybuf));
    if (!actual_key.empty() && actual_key != instance_uuid_) {
      // Collision (duplicated clip) — server reminted. Adopt + persist.
      BARREL_LOG("setupBridge", "key collision: requested=%s actual=%s",
                 instance_uuid_.c_str(), actual_key.c_str());
      instance_uuid_ = actual_key;
      need_persist = true;
    }
    barrel_plugin_key_ = actual_key.empty() ? instance_uuid_ : actual_key;
    BARREL_LOG("setupBridge", "registered key=%s", barrel_plugin_key_.c_str());

    publishInitialState();

    if (loader_.bridge_register_patch_listener) {
      loader_.bridge_register_patch_listener(
          bridge_, barrel_plugin_key_.c_str(), &NanoBarrelPlugin::onPatchTrampoline, this);
    }

    // Apply the persisted sketch (if any), then push host info.
    if (!pending_payload_.empty()) {
      applyPayload(pending_payload_);
      pending_payload_.clear();
    }
    if (!host_info_.is_null() && loader_.bridge_set_at) {
      loader_.bridge_set_at(bridge_,
          ("/plugins/" + barrel_plugin_key_ + "/state/host").c_str(),
          host_info_.dump().c_str());
    }

    if (need_persist) {
      // Schedule a config regen so the (new/reminted) UUID lands in P_CONFIG.
      dirty_ = true;
      dirty_since_ms_ = ::nano_barrel_log::now_ms() - kRegenDebounceMs;
    }
    sketch_snapshot_dirty_.store(true, std::memory_order_release);
  }

  void teardownBridge() {
    if (!bridge_) return;
    if (loader_.bridge_unregister_patch_listener)
      loader_.bridge_unregister_patch_listener(bridge_, barrel_plugin_key_.c_str());
    if (loader_.bridge_unregister_plugin)
      loader_.bridge_unregister_plugin(bridge_, barrel_plugin_key_.c_str());
    if (loader_.bridge_release)
      loader_.bridge_release(bridge_);
    bridge_ = nullptr;
  }

  // Fired from the shared server's pump thread when an editor patches this
  // instance's state. MUST touch only atomics / debounce flags — never take
  // tick_mu_ or call back into the bridge (the pump holds the server lock).
  static void onPatchTrampoline(const char* /*key*/, void* userdata) {
    auto* self = static_cast<NanoBarrelPlugin*>(userdata);
    if (!self) return;
    self->dirty_ = true;
    self->dirty_since_ms_ = ::nano_barrel_log::now_ms();
    self->preview_requests_dirty_.store(true, std::memory_order_release);
    self->sketch_snapshot_dirty_.store(true, std::memory_order_release);
  }

  // Publish the schemas + empty state skeleton for this instance.
  void publishInitialState() {
    if (!bridge_ || !loader_.bridge_set_plugin_state) return;
    nlohmann::json column_one = {
      {"name", "Column 1"},
      {"chain", nlohmann::json::array()},
    };
    nlohmann::json plugin_schemas = nlohmann::json::object();
    if (registry_) {
      for (const auto& [module_type, schema_fields] : registry_->schemas()) {
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
      {"preview_requests", nlohmann::json::object()},
    };
    for (int i = 0; i < (int)N_MACROS; ++i) initial["macros"].push_back(0.0);
    loader_.bridge_set_plugin_state(
        bridge_, barrel_plugin_key_.c_str(), initial.dump().c_str());
  }

  // -- Persistence envelope: {"uuid":..,"sketch":..} ------------------
  static std::string payloadUuid(const std::string& payload) {
    if (payload.empty()) return "";
    auto j = nlohmann::json::parse(payload, nullptr, false);
    if (j.is_object()) return j.value("uuid", std::string());
    return "";
  }
  static std::string payloadSketch(const std::string& payload) {
    auto j = nlohmann::json::parse(payload, nullptr, false);
    if (j.is_object() && j.contains("sketch")) return j["sketch"].dump();
    return payload;  // tolerate a bare sketch payload
  }
  std::string buildPayload(const std::string& sketch_json) const {
    auto sketch = nlohmann::json::parse(sketch_json, nullptr, false);
    if (sketch.is_discarded()) sketch = nlohmann::json::object();
    nlohmann::json env = {{"uuid", instance_uuid_}, {"sketch", sketch}};
    return env.dump();
  }

  // Apply a persisted payload: extract uuid (if we don't have one) + sketch.
  void applyPayload(const std::string& payload) {
    if (instance_uuid_.empty()) instance_uuid_ = payloadUuid(payload);
    std::string sketch_json = payloadSketch(payload);
    if (!sketch_json.empty()) applyConfigJson(sketch_json);
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
      for (const char* name : {"core", "lights", "nano", "text", "richtext"}) {
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

    // Text effects (source.text.plain / source.text.rich) load from text.wasm / richtext.wasm
    // in the bundle loop above — same as every other effect. They need NO
    // registerShaderMSL (the text.* host service owns its MSDF compositor PSO),
    // but the engine needs font BYTES: install the bundled default.ttf as the
    // parity-exact Latin primary (falling back to the system UI font if absent),
    // plus the OS's CJK faces as the fallback chain. This is host-side — the
    // text.wasm bridge (WasmEffectBundles::init → registerTextHostFunctions)
    // routes the effects' text.* imports to this same TextEngine.
    effect_runtime::textInstallDefaultFonts(bundleFontPath("default.ttf").c_str());

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
      // bridge_ may be null between DeInitGL/InitGL; the ABI no-ops on a null
      // handle (and on a shut-down server), so a stray late frame is harmless.
      if (bridge_ && loader_.bridge_broadcast_binary) {
        loader_.bridge_broadcast_binary(bridge_, bytes.data(),
                                        (uint32_t)bytes.size());
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

  // -- Config <-> state document --------------------------------------
  // Writes the sketch into this instance's shared-doc state and refreshes the
  // process cache (as the {uuid,sketch} envelope) for in-process delete+undo.
  void applyConfigJson(const std::string& sketch_json) {
    auto sketch = nlohmann::json::parse(sketch_json, nullptr, false);
    if (sketch.is_discarded()) {
      BARREL_LOG("applyConfigJson", "JSON parse FAILED (size=%zu)",
                 sketch_json.size());
      return;
    }
    if (bridge_ && loader_.bridge_set_at) {
      loader_.bridge_set_at(bridge_,
          ("/plugins/" + barrel_plugin_key_ + "/state/sketch").c_str(),
          sketch.dump().c_str());
      sketch_snapshot_dirty_.store(true, std::memory_order_release);
    }
    {
      std::lock_guard<std::mutex> lock(g_cache_mu());
      g_cache_blob() = buildPayload(sketch_json);
    }
    BARREL_LOG("applyConfigJson",
               "applied sketch (json_size=%zu)", sketch_json.size());
  }

  // -- Preview helpers ------------------------------------------------
  // Rebuild preview_requests_ from the shared state document. Caller
  // must hold tick_mu_.
  void refreshPreviewRequests() {
    auto raw = getAtJson(
        "/plugins/" + barrel_plugin_key_ + "/state/preview_requests");
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

  // NBPV v2 binary preview frame. One shared WS server now multiplexes many
  // instances, so the plugin key is embedded in the header and the web routes
  // each frame to the right instance. Matching decoder: web/src/widgets/
  // texture-monitor.ts (handleBinaryFrame).
  //   [0..3]  "NBPV"
  //   [4]     version = 2
  //   [5]     format  = 1 (RGBA8)
  //   [6..7]  u16 keyLen   (little-endian)
  //   [8..9]  u16 idLen    (traceId length)
  //   [10..11] u16 width
  //   [12..13] u16 height
  //   [14 ..] key bytes, then traceId bytes, then RGBA8 pixels
  static std::vector<uint8_t> buildPreviewFrameBytes(
      const std::string& key, const std::string& traceId,
      uint16_t width, uint16_t height,
      const std::vector<uint8_t>& pixels) {
    const uint16_t keyLen = (uint16_t)key.size();
    const uint16_t idLen  = (uint16_t)traceId.size();
    const size_t headerSize = 14 + keyLen + idLen;
    std::vector<uint8_t> out;
    out.reserve(headerSize + pixels.size());
    out.resize(headerSize);
    out[0] = 'N'; out[1] = 'B'; out[2] = 'P'; out[3] = 'V';
    out[4] = 2;             // version
    out[5] = 1;             // format: RGBA8
    out[6] = (uint8_t)(keyLen & 0xFF);
    out[7] = (uint8_t)(keyLen >> 8);
    out[8] = (uint8_t)(idLen  & 0xFF);
    out[9] = (uint8_t)(idLen  >> 8);
    out[10] = (uint8_t)(width  & 0xFF);
    out[11] = (uint8_t)(width  >> 8);
    out[12] = (uint8_t)(height & 0xFF);
    out[13] = (uint8_t)(height >> 8);
    memcpy(out.data() + 14, key.data(), keyLen);
    memcpy(out.data() + 14 + keyLen, traceId.data(), idLen);
    out.insert(out.end(), pixels.begin(), pixels.end());
    return out;
  }

  void publishPreviewFrames() {
    if (!gpu_ || !bridge_) return;
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
    if (loader_.bridge_has_clients && !loader_.bridge_has_clients(bridge_)) return;
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
      std::string key = barrel_plugin_key_;
      gpu_->readbackTextureScaledAsync(
          slot.handle,
          (uint32_t)slot.width, (uint32_t)slot.height,
          outW, outH,
          [this, key = std::move(key), traceId = std::move(traceId), outW, outH]
          (std::vector<uint8_t> pixels) {
            auto bytes = buildPreviewFrameBytes(
                key, traceId, (uint16_t)outW, (uint16_t)outH, pixels);
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
    {
      std::lock_guard<std::mutex> lock(tick_mu_);
      if (dirty_ && (::nano_barrel_log::now_ms() - dirty_since_ms_)
                       >= kRegenDebounceMs) {
        dirty_ = false;
        should_regen = true;
      }
    }
    if (!should_regen || !bridge_) return;

    std::string sketch_json =
        getAtJson("/plugins/" + barrel_plugin_key_ + "/state/sketch").dump();
    // Persist the {uuid,sketch} envelope so identity survives reload/restart.
    std::string payload = buildPayload(sketch_json);
    config_blob_ = barrel_codec::wrap_config(payload);
    {
      std::lock_guard<std::mutex> lock(g_cache_mu());
      g_cache_blob() = payload;
    }
    BARREL_LOG("regenerate",
               "json_size=%zu wrapped_size=%zu key=%s",
               sketch_json.size(), config_blob_.size(),
               barrel_plugin_key_.c_str());
    RaiseParamEvent(P_CONFIG, FF_EVENT_FLAG_VALUE);
  }

  // -- Preview push (per-frame texture snapshots over WS binary) ------
  // The editor publishes a map of { traceId → { target, width, height } }
  // at /plugins/<key>/state/preview_requests. We re-read the full map
  // each time the per-key patch listener fires (cheap; the map
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
  // Shared in-process server, located + acquired in InitGL via the loader.
  plugin::BridgeLoader             loader_;
  BridgeHandle                     bridge_ = nullptr;
  std::string                      barrel_plugin_key_;   // == instance_uuid_
  std::string                      instance_uuid_;       // stable, persisted
  std::string                      pending_payload_;     // envelope to apply in InitGL
  nlohmann::json                   host_info_;           // applied once bridge is up

  // Active preview requests (guarded by tick_mu_). Refreshed lazily on
  // the render thread when `preview_requests_dirty_` is set — the patch
  // listener only flips the flag, never mutates the map directly.
  std::unordered_map<std::string, PreviewRequest> preview_requests_;
  std::atomic<bool> preview_requests_dirty_{false};

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
    "nano");
