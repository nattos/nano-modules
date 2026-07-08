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

#include <dlfcn.h>
#include <fstream>

#import "InteropTexture.h"
#include "barrel_log.h"
#include "barrel_codec.h"

// The barrel is a THIN client: it links NONE of the effect engine. The shared
// runtime (Metal backend + WAMR + effect bundles + executor) lives in
// libbridge_server.dylib as a process singleton (bridge::BarrelRuntime), reached
// purely through the C ABI in bridge_api.h. This plugin owns only its FFGL shell,
// identity/persistence, the GL↔Metal InteropTexture pair (built against the
// dylib's shared MTLDevice), and the bridge loader.

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

    // Stash the persisted payload (envelope JSON) for InitGL to apply once the
    // bridge is up. The process cache holds ONLY the most-recently-DESTROYED
    // instance's envelope (written in ~NanoBarrelPlugin, consumed once in
    // setupBridge) — the in-process delete→undo bridge, where Resolume destroys
    // + recreates the SAME C++ instance and the recreated ctor needs the state
    // before SetTextParameter fires. It is empty during normal operation, so a
    // freshly ADDED instance (while siblings are alive) starts blank instead of
    // inheriting a sibling's sketch. On a host cold start it's also empty (the
    // host restores via SetTextParameter before InitGL).
    {
      std::lock_guard<std::mutex> lock(g_cache_mu());
      pending_payload_ = g_cache_blob();
    }
    if (!pending_payload_.empty()) {
      config_blob_ = barrel_codec::wrap_config(pending_payload_);
    }

    BARREL_LOG("ctor-done",
               "params=%u config_blob_size=%zu",
               N_PARAMS, config_blob_.size());
  }

  ~NanoBarrelPlugin() override {
    BARREL_LOG("dtor", "this=%p frame=%d", (void*)this, frame_);
    // Hand THIS instance's persisted envelope to the process cache so an
    // immediate in-process recreation (delete→undo: Resolume destroys + rebuilds
    // the same C++ instance) can repopulate from it before SetTextParameter
    // fires. Only the dying instance writes the cache — a newly ADDED sibling
    // therefore never inherits a live instance's sketch. config_blob_ is the
    // wrapped form GetTextParameter returns (the host's durable store); unwrap
    // to the bare envelope the ctor/SetTextParameter expect.
    if (!config_blob_.empty()) {
      std::string payload = barrel_codec::unwrap_config(config_blob_);
      if (!payload.empty()) {
        std::lock_guard<std::mutex> lock(g_cache_mu());
        g_cache_blob() = payload;
      }
    }
    // Safety net: DeInitGL normally destroys the executor + tears the bridge
    // down, but the host may destroy us without a matching DeInitGL. The shared
    // runtime owns the preview send worker now, so there's nothing here to drain
    // — destroyExecutor (under the render lock) frees this key's effect state.
    teardownBridge();
  }

  // -- Lifecycle -------------------------------------------------------
  FFResult InitGL(const FFGLViewportStruct* vp) override {
    BARREL_LOG("InitGL", "viewport=%ux%u", vp->width, vp->height);
    CFFGLPlugin::InitGL(vp);
    glGenFramebuffers(1, &src_fbo_);
    // setupBridge acquires the shared runtime (loading effects ONCE for the whole
    // process), registers this instance, and creates its per-key executor. This
    // is a real, GL-active instance — NOT a param-scan prototype (those never
    // call InitGL, so they never touch the runtime).
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

    // WS message handling, sketch fetch, telemetry publish, and preview readback
    // all live in the shared runtime now (libbridge_server.dylib). This render
    // thread only does the FFGL ↔ Metal interop around a single ABI call.
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
    if (!rt_ready_ || !bridge_ || !shared_device_ ||
        !loader_.bridge_executor_render) {
      drawBadgeOnly(pGL);
      return FF_SUCCESS;
    }

    ensureInterop((int)pInput->Width, (int)pInput->Height, (int)W, (int)H);
    if (!input_interop_ || !output_interop_) {
      drawBadgeOnly(pGL);
      return FF_SUCCESS;
    }

    blitGlInputToInterop(pGL, pInput);

    // Frame-time bookkeeping for effects that care. FFGL hands us an explicit
    // ABSOLUTE time (SetTime), not a dt: `elapsed` follows it exactly (host
    // transport stays authoritative), while the DERIVED per-frame dt is capped
    // like every other derived-dt surface — a host stall or transport jump
    // advances accumulators/simulations by at most 0.1 s instead of exploding
    // them.
    double hostT = hostTime / 1000.0;
    if (!time_initialized_) {
      time_start_ = hostT;
      time_prev_  = hostT;
      time_initialized_ = true;
    }
    double rawDt = hostT - time_prev_;
    double dt    = std::max(0.0, std::min(rawDt, 0.1));
    time_prev_   = hostT;

    // Snapshot the macro knobs (written under tick_mu_ by SetFloatParameter)
    // for the dylib to inject into any control.barrel_macros instance.
    std::array<float, N_MACROS> macros_snapshot;
    {
      std::lock_guard<std::mutex> lock(tick_mu_);
      macros_snapshot = macros_;
    }
    // `dirty` drives the dylib's sketch + preview-request re-fetch. Set on any
    // editor patch (onPatchTrampoline) or host config apply (applyConfigJson);
    // cleared here. A false value lets the dylib reuse its cached sketch parse.
    const bool dirty =
        sketch_snapshot_dirty_.exchange(false, std::memory_order_acq_rel);

    // The shared runtime pulls this instance's sketch from the state doc, runs
    // its per-key executor (namespaced effect state), writes the output interop
    // texture, and publishes rail telemetry + preview frames over the shared WS.
    // Returns nonzero iff it wrote the output texture (else the sketch passed
    // through and we present the input).
    // barPhase/bpm come from FFGL SetBeatInfo (base CFFGLPlugin stores them);
    // Resolume drives them on the render thread, same as ProcessOpenGL. Forward
    // the host musical clock so beat-synced effects (the looper) advance. bpm 0
    // means "no transport" — normalize to a sane default.
    const double hostBpm = this->bpm > 0.0f ? (double)this->bpm : 120.0;
    int outputUsed = loader_.bridge_executor_render(
        bridge_, barrel_plugin_key_.c_str(),
        (__bridge void*)input_interop_->getMetalTexture(),
        (__bridge void*)output_interop_->getMetalTexture(),
        (int)W, (int)H, dt, hostT - time_start_, dirty ? 1 : 0,
        macros_snapshot.data(), (int)N_MACROS,
        (double)this->barPhase, hostBpm);

    blitInteropToGlOutput(pGL, outputUsed != 0);
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

  // Resolve the directory holding the effect .wasm bundles. NANO_BARREL_WASM_DIR
  // overrides (for ffgl_runner / dev pointing at build/wasm); otherwise the
  // bundled copy under Contents/Resources/wasm/. The shared runtime appends
  // "/<bundle>.wasm". Empty if the bundle can't be located.
  static std::string bundleWasmDir() {
    if (const char* dir = getenv("NANO_BARREL_WASM_DIR"); dir && *dir)
      return std::string(dir);
    Dl_info info;
    if (!dladdr(reinterpret_cast<const void*>(&bundleWasmDir), &info) ||
        !info.dli_fname)
      return "";
    std::string p = info.dli_fname;
    auto pos = p.find(".bundle/");
    if (pos == std::string::npos) return "";
    return p.substr(0, pos + 8) + "Contents/Resources/wasm";
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

  // Register `candidate_uuid` with the shared bridge server. Returns the
  // ACTUAL key the server assigned — normally `candidate_uuid` verbatim,
  // but a distinct derivative (`<uuid>-2`, ...) if another live instance
  // already holds it (a genuine clip-copy duplicate — see
  // `StateDocument::allocate_key`). `out_collided` reports which happened.
  std::string registerWithBridge(const std::string& candidate_uuid, bool& out_collided) {
    char keybuf[128] = {0};
    int n = loader_.bridge_register_plugin(
        bridge_, "com.nano.nanobarrel", 0, 1, 0,
        /*schema_json=*/"", candidate_uuid.c_str(), keybuf, sizeof(keybuf));
    std::string actual_key(keybuf, (n > 0 && n < (int)sizeof(keybuf)) ? n : (int)strlen(keybuf));
    out_collided = !actual_key.empty() && actual_key != candidate_uuid;
    return out_collided ? actual_key : candidate_uuid;
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

    // Acquire the shared effect runtime (Metal backend + WAMR + effect bundles +
    // executor pool), loading the effect set ONCE for the whole process. The
    // shared MTLDevice it returns is what our InteropTexture pair must be built
    // against (the executor renders on that device). Without these symbols the
    // dylib is too old — we stay render-only (badge).
    if (loader_.bridge_rt_acquire && loader_.bridge_executor_create &&
        loader_.bridge_executor_render && loader_.bridge_rt_metal_device) {
      std::string wasmDir  = bundleWasmDir();
      std::string fontPath = bundleFontPath("default.ttf");
      rt_ready_ = loader_.bridge_rt_acquire(bridge_, wasmDir.c_str(),
                                            fontPath.c_str()) != 0;
      if (rt_ready_) {
        shared_device_ =
            (__bridge id<MTLDevice>)loader_.bridge_rt_metal_device(bridge_);
      }
      BARREL_LOG("setupBridge", "rt_acquire=%d wasmDir=%s device=%p",
                 rt_ready_ ? 1 : 0, wasmDir.c_str(), (void*)shared_device_);
    } else {
      BARREL_LOG("setupBridge", "dylib lacks shared-runtime symbols — render-only");
    }

    // Identity: prefer the UUID from the pending payload (cold start / undo —
    // a GENUINE persisted identity, so uuid_confirmed_ goes true immediately).
    // Otherwise mint a PROVISIONAL one: registered with the bridge right away
    // (so the instance is selectable/editable in the editor without delay),
    // but NOT persisted into P_CONFIG yet — see uuid_confirmed_'s doc comment
    // for why minting unconditionally here was the actual churn bug.
    bool need_persist = false;
    if (instance_uuid_.empty()) {
      instance_uuid_ = payloadUuid(pending_payload_);
      if (instance_uuid_.empty()) {
        instance_uuid_ = generateUuid();
      } else {
        uuid_confirmed_ = true;
      }
    }

    bool collided = false;
    std::string requested_uuid = instance_uuid_;
    instance_uuid_ = registerWithBridge(instance_uuid_, collided);
    if (collided) {
      // Collision (duplicated clip, both carrying the same persisted UUID) —
      // server reminted. This IS a confirmed, real identity (resolving an
      // actual conflict), so persist it right away.
      BARREL_LOG("setupBridge", "key collision: requested=%s actual=%s",
                 requested_uuid.c_str(), instance_uuid_.c_str());
      uuid_confirmed_ = true;
      need_persist = true;
    }
    barrel_plugin_key_ = instance_uuid_;
    BARREL_LOG("setupBridge", "registered key=%s confirmed=%d",
               barrel_plugin_key_.c_str(), uuid_confirmed_ ? 1 : 0);

    // Create this instance's executor in the shared runtime, namespaced by the
    // plugin key so its effect state is isolated from every other barrel.
    if (rt_ready_ && loader_.bridge_executor_create) {
      loader_.bridge_executor_create(bridge_, barrel_plugin_key_.c_str());
    }

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
    // The undo crutch is spent: this real instance has captured its state, so
    // clear the process cache. A subsequently ADDED instance then sees an empty
    // cache and starts blank instead of inheriting this one (or a sibling's).
    {
      std::lock_guard<std::mutex> lock(g_cache_mu());
      g_cache_blob().clear();
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
    // Destroy this key's executor + its namespaced effect instances in the shared
    // runtime (GPU-idle under the render lock there), then drop our acquire ref.
    if (rt_ready_ && loader_.bridge_executor_destroy)
      loader_.bridge_executor_destroy(bridge_, barrel_plugin_key_.c_str());
    if (rt_ready_ && loader_.bridge_rt_release)
      loader_.bridge_rt_release(bridge_);
    rt_ready_ = false;
    shared_device_ = nil;
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
    // The dylib re-fetches both the sketch AND preview_requests whenever we pass
    // dirty=1 to render, so a single flag covers any editor patch to this key.
    self->sketch_snapshot_dirty_.store(true, std::memory_order_release);
  }

  // Publish the schemas + empty state skeleton for this instance.
  void publishInitialState() {
    if (!bridge_ || !loader_.bridge_set_plugin_state) return;
    nlohmann::json column_one = {
      {"name", "Column 1"},
      {"chain", nlohmann::json::array()},
    };
    // The effect schema catalog comes from the shared runtime (it owns the
    // ModuleRegistry now) as a ready-made JSON object string.
    nlohmann::json plugin_schemas = nlohmann::json::object();
    if (rt_ready_ && loader_.bridge_rt_schemas && loader_.bridge_free_string) {
      char* raw = loader_.bridge_rt_schemas(bridge_);
      if (raw) {
        auto parsed = nlohmann::json::parse(raw, nullptr, false);
        loader_.bridge_free_string(raw);
        if (parsed.is_object()) plugin_schemas = std::move(parsed);
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

  // Apply a persisted payload: extract uuid (if we don't have one yet, or if
  // one we're still holding provisionally gets superseded by a genuine
  // restore that arrives late — see uuid_confirmed_) + sketch.
  void applyPayload(const std::string& payload) {
    std::string restored_uuid = payloadUuid(payload);
    if (instance_uuid_.empty()) {
      instance_uuid_ = restored_uuid;
      uuid_confirmed_ = !restored_uuid.empty();
    } else if (!uuid_confirmed_ && !restored_uuid.empty() &&
               restored_uuid != instance_uuid_) {
      adoptRestoredUuid(restored_uuid);
    }
    std::string sketch_json = payloadSketch(payload);
    if (!sketch_json.empty()) applyConfigJson(sketch_json);
  }

  // The real persisted identity arrived via a late `SetTextParameter` — after
  // setupBridge already registered under a provisional mint (setupBridge
  // never waits for this; see uuid_confirmed_'s doc comment). Re-key this
  // instance's bridge registration + executor + patch listener to the
  // restored UUID so it becomes permanent, exactly as if we'd had it from
  // the start. Nothing rendered under the provisional key yet (rendering
  // only starts once the host Connects, which happens after this), so
  // there's no in-flight state to migrate — just tear down and re-stand-up.
  // Runs the same collision/remint protocol setupBridge does, so a genuine
  // clip-copy duplicate is still deduped normally.
  void adoptRestoredUuid(const std::string& restored_uuid) {
    const std::string old_key = barrel_plugin_key_;
    if (loader_.bridge_unregister_patch_listener)
      loader_.bridge_unregister_patch_listener(bridge_, old_key.c_str());
    if (rt_ready_ && loader_.bridge_executor_destroy)
      loader_.bridge_executor_destroy(bridge_, old_key.c_str());
    if (loader_.bridge_unregister_plugin)
      loader_.bridge_unregister_plugin(bridge_, old_key.c_str());

    bool collided = false;
    instance_uuid_ = registerWithBridge(restored_uuid, collided);
    barrel_plugin_key_ = instance_uuid_;
    uuid_confirmed_ = true;
    BARREL_LOG("adoptRestoredUuid", "old=%s restored=%s actual=%s collided=%d",
               old_key.c_str(), restored_uuid.c_str(),
               barrel_plugin_key_.c_str(), collided ? 1 : 0);

    if (rt_ready_ && loader_.bridge_executor_create)
      loader_.bridge_executor_create(bridge_, barrel_plugin_key_.c_str());
    publishInitialState();
    if (loader_.bridge_register_patch_listener) {
      loader_.bridge_register_patch_listener(
          bridge_, barrel_plugin_key_.c_str(), &NanoBarrelPlugin::onPatchTrampoline, this);
    }

    if (collided) {
      // Same as setupBridge's collision path: a confirmed, real identity
      // resolving an actual conflict, so persist it right away.
      dirty_ = true;
      dirty_since_ms_ = ::nano_barrel_log::now_ms() - kRegenDebounceMs;
    }
  }

  // -- Interop management ---------------------------------------------
  // (Re)create the input/output `InteropTexture` pair on viewport size
  // changes. Both interops are CVPixelBuffer-backed so the GL FBO side
  // and the Metal MTLTexture side share IOSurface storage — zero-copy
  // ping-pong between the host's GL pipeline and the executor's Metal
  // dispatches.
  void ensureInterop(int inW, int inH, int outW, int outH) {
    if (!shared_device_) return;
    if (!input_interop_ ||
        input_interop_->getWidth() != inW ||
        input_interop_->getHeight() != inH) {
      input_interop_ = std::make_unique<InteropTexture>(
          shared_device_, [NSOpenGLContext currentContext], true,
          MTLPixelFormatBGRA8Unorm, inW, inH);
    }
    if (!output_interop_ ||
        output_interop_->getWidth() != outW ||
        output_interop_->getHeight() != outH) {
      output_interop_ = std::make_unique<InteropTexture>(
          shared_device_, [NSOpenGLContext currentContext], true,
          MTLPixelFormatBGRA8Unorm, outW, outH);
    }
  }

  // -- GL bridge helpers ----------------------------------------------
  // Blit the host's GL input texture into the input InteropTexture's
  // GL-side FBO. Zero shader work — just glBlitFramebuffer between two
  // FBOs. Handles both GL_TEXTURE_2D and GL_TEXTURE_RECTANGLE inputs;
  // glFramebufferTexture2D's target argument is the texture target.
  //
  // The destination Y is flipped (dst goes H→0) so the input lands in the
  // interop with Metal's top-left origin — the same convention the executor's
  // effects render in, and the mirror of blitInteropToGlOutput's flip on the
  // way back. Without this the input enters Metal upside-down: a passthrough
  // (and every effect) comes out vertically flipped, since only the output blit
  // flipped. The two flips now net to zero for the displayed image while keeping
  // the executor in proper top-left space (so orientation-sensitive effects —
  // text, gradients — are upright).
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
                      0, (GLint)input_interop_->getHeight(),
                      (GLint)input_interop_->getWidth(), 0,
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
  // Writes the sketch into this instance's shared-doc state. The process cache
  // is NOT touched here — it's written only on destruction (see ~ctor), so a
  // live instance's edits never leak into a newly added sibling.
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
    BARREL_LOG("applyConfigJson",
               "applied sketch (json_size=%zu)", sketch_json.size());
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

    // A genuine editor patch (the only thing besides setupBridge's own
    // collision-remint that sets dirty_) proves this instance is actually in
    // use — worth persisting even if its UUID was only a provisional mint
    // (see uuid_confirmed_'s doc comment). Idempotent past the first time.
    uuid_confirmed_ = true;

    std::string sketch_json =
        getAtJson("/plugins/" + barrel_plugin_key_ + "/state/sketch").dump();
    // Persist the {uuid,sketch} envelope into the FILE param (config_blob_ is
    // what GetTextParameter returns) so identity + sketch survive reload/restart.
    // The process cache is NOT updated here — only on destruction (see ~ctor) —
    // so a live instance never seeds the next added sibling.
    std::string payload = buildPayload(sketch_json);
    config_blob_ = barrel_codec::wrap_config(payload);
    BARREL_LOG("regenerate",
               "json_size=%zu wrapped_size=%zu key=%s",
               sketch_json.size(), config_blob_.size(),
               barrel_plugin_key_.c_str());
    RaiseParamEvent(P_CONFIG, FF_EVENT_FLAG_VALUE);
  }

  std::mutex                       tick_mu_;
  // Shared in-process server, located + acquired in InitGL via the loader.
  plugin::BridgeLoader             loader_;
  BridgeHandle                     bridge_ = nullptr;
  std::string                      barrel_plugin_key_;   // == instance_uuid_
  std::string                      instance_uuid_;       // stable, persisted
  // False while instance_uuid_ is only a PROVISIONAL mint (setupBridge had no
  // pending_payload_ to restore from) — read/written only from the main/
  // render thread (setupBridge, applyPayload/adoptRestoredUuid,
  // maybeRegenerateConfig; onPatchTrampoline deliberately does NOT touch it).
  // While false, maybeRegenerateConfig must never persist instance_uuid_ into
  // P_CONFIG: a mint that turns out to never matter (the real persisted UUID
  // arrives moments later via a late SetTextParameter, or the instance stays
  // untouched forever) must never overwrite Resolume's saved identity. Goes
  // true the moment identity is no longer a guess — a genuine restore (cold
  // start, or a late-arriving SetTextParameter adopted in applyPayload), a
  // real dedup collision (setupBridge/adoptRestoredUuid), or the first
  // genuine editor edit (maybeRegenerateConfig) proving this really is a new
  // instance worth persisting.
  bool                             uuid_confirmed_ = false;
  std::string                      pending_payload_;     // envelope to apply in InitGL
  nlohmann::json                   host_info_;           // applied once bridge is up

  // Shared effect runtime (lives in the dylib). rt_ready_ is true once
  // bridge_rt_acquire succeeded + our per-key executor was created; shared_device_
  // is the dylib's MTLDevice that our InteropTexture pair is built against (it
  // MUST match the device the executor renders on). Both cleared in teardownBridge.
  bool                             rt_ready_ = false;
  id<MTLDevice>                    shared_device_ = nil;

  // GL ↔ Metal interop (the only Metal the barrel itself owns).
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

  // Flips the dylib's sketch + preview-request re-fetch. Set on any editor patch
  // (onPatchTrampoline) or host config apply (applyConfigJson); read+cleared each
  // frame and passed as `dirty` to bridge_executor_render. Starts true so the
  // first frame always fetches.
  std::atomic<bool> sketch_snapshot_dirty_{true};

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
