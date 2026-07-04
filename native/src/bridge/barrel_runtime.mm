#include "bridge/barrel_runtime.h"

#import <Metal/Metal.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

#include "bridge/bridge_server.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sidechannel_bus.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

// Host frame-state setters live in effect_runtime (host_impls.cpp); forward
// declare to avoid pulling a heavier header (mirrors nano_barrel_plugin.mm).
namespace effect_runtime {
void setHostTime(double t);
void setHostDeltaTime(double dt);
void setHostViewport(int w, int h);
void textInstallDefaultFonts(const char* primaryTtfPath);
}  // namespace effect_runtime

namespace bridge {

namespace {
constexpr const char* kBundleNames[] = {"core", "lights", "nano", "text", "richtext", "legacy"};
constexpr unsigned kNumMacros = 16;

#define BRT_LOG(fmt, ...) \
  std::fprintf(stderr, "[barrel_runtime] " fmt "\n", ##__VA_ARGS__)

// One active preview subscription (an editor monitor). Mirrors the web's
// trace-controller request shape; targetKey is resolved to the executor hook's
// capture-map key ("so" or "ce:<col>/<chain>/<side>").
struct PreviewRequest {
  std::string traceId;
  std::string targetKey;
  uint32_t    width  = 128;
  uint32_t    height = 72;
};
struct CaptureSlot {
  int32_t handle = -1;
  int     width  = 0;
  int     height = 0;
};

// NBPV v2 binary preview frame. One shared WS server multiplexes many
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
std::vector<uint8_t> buildPreviewFrameBytes(
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

nlohmann::json parseOrObject(const std::string& s) {
  auto j = nlohmann::json::parse(s, nullptr, false);
  return j.is_discarded() ? nlohmann::json::object() : j;
}

// Preview cadence + size caps (read once). The editor's preview readbacks
// dominate the watched-frame cost — each one's GPU scale/copy serializes on the
// render queue ahead of the next frame's blocking submit, so cost scales with
// readback pixels × rate. Decouple the preview rate from the render rate
// (default 30 Hz) and bound the readback long-edge. The main edit-preview
// requests its DISPLAYED size (device pixels, clamped to source), so the cap's
// default (4096) is only a guard against absurd requests/comp sizes (and the
// NBPV u16 dimension fields); the per-monitor latest-wins send queue is what
// keeps a slow channel from backing up. Drop NANO_BARREL_PREVIEW_MAXDIM
// (e.g. 512) to trade monitor sharpness for readback time. Both env-tunable.
double previewIntervalSec() {
  static double v = [] {
    const char* e = getenv("NANO_BARREL_PREVIEW_HZ");
    double hz = e ? atof(e) : 30.0;
    return hz > 0.0 ? 1.0 / hz : 0.0;
  }();
  return v;
}
uint32_t previewMaxDim() {
  static uint32_t v = [] {
    const char* e = getenv("NANO_BARREL_PREVIEW_MAXDIM");
    int d = e ? atoi(e) : 4096;
    return d > 0 ? (uint32_t)d : 4096u;
  }();
  return v;
}
}  // namespace

struct BarrelRuntime::Impl {
  std::mutex lifecycle_mu;          // guards build/teardown + refcount + table
  std::mutex render_mu;             // global render serializer
  int refcount = 0;
  bool built = false;
  bool usable = false;

  id<MTLDevice> device = nil;
  std::unique_ptr<gpu::GPUBackend> gpu;
  // bundles owns the WasmHost; declared before rt so it is destroyed AFTER rt
  // (EffectInstance dtors call_indirect into the WasmHost).
  std::unique_ptr<sketch_executor::WasmEffectBundles> bundles;
  std::unique_ptr<effect_runtime::EffectRuntime> rt;
  std::unique_ptr<sketch_executor::ModuleRegistry> registry;

  struct PerExecutor {
    std::unique_ptr<sketch_executor::SketchExecutor> executor;
    nlohmann::json sketch;          // cached parse, updated on dirty frames
    bool haveSketch = false;
    // Preview machinery (single-writer: only touched on the render thread,
    // under render_mu). Hooks capture a stable pointer to this PerExecutor
    // (unordered_map nodes are pointer-stable across rehash).
    std::unordered_map<std::string, PreviewRequest> preview_requests;
    std::unordered_map<std::string, CaptureSlot>    frame_captures;
    bool captures_enabled = false;
    int  frame = 0;
    // Last-published telemetry, so a static sketch publishes NOTHING per frame.
    // Without this every frame ran a full JSON dump→parse→RFC-6902 diff (on the
    // render thread, under tick_mutex_) even when the rails never changed.
    nlohmann::json lastRail;
    nlohmann::json lastMacroOut;
    nlohmann::json lastPluginStates;
    bool haveLastRail = false;
    bool haveLastMacroOut = false;
    bool haveLastPluginStates = false;
    // Host-elapsed time of the last preview-capture frame, for rate limiting.
    double lastPreviewElapsed = -1e9;
  };
  std::unordered_map<std::string, PerExecutor> executors;

  // Last-published sidechannel-bus metadata version. The bus bumps it only on
  // channel-identity changes (new channel / writer / size), so the version
  // compare below is a cheap per-render gate on the /global/sidechannels
  // publish. -1 forces one publish once a client is connected.
  int64_t lastBusVersion = -1;

  // Shared preview-broadcast worker. Takes the Metal completion handler off the
  // critical path: broadcast_binary (ixwebsocket queueing) would otherwise run
  // on Metal's serial completion queue and back-pressure the render thread's
  // commits. Each frame blob already carries its key in the NBPV header, so one
  // worker serves all instances.
  //
  // The queue is LATEST-WINS per monitor (route = instance key + trace id):
  // a monitor never holds more than ONE queued frame — a newer frame replaces
  // the queued one, and publishPreviewFrames skips capturing for a route whose
  // previous frame is still waiting to send. Previews are disposable state, not
  // a stream: when the channel (or the GPU readback) can't keep up, the preview
  // RATE degrades gracefully while the WS channel stays shallow — interactive
  // state patches must never sit behind a backlog of pixel frames.
  struct PreviewBlob {
    std::string route;
    std::vector<uint8_t> bytes;
  };
  std::thread             send_thread;
  std::mutex              send_mu;
  std::condition_variable send_cv;
  std::deque<PreviewBlob> send_queue;
  std::atomic<bool>       send_stop{false};
  bool                    send_started = false;

  ~Impl() {
    // Preview readback callbacks (hopped off Metal's completion queue onto
    // the backend's serial readback queue) capture `this` and touch
    // send_mu/send_queue — drain them BEFORE any member is destroyed, or a
    // late callback locks a destroyed mutex at process exit.
    if (gpu) gpu->drainPreviewReadbacks();
    {
      std::lock_guard<std::mutex> lk(send_mu);
      send_stop.store(true, std::memory_order_release);
    }
    send_cv.notify_one();
    if (send_thread.joinable()) send_thread.join();
  }

  void startSendWorker() {
    if (send_started) return;
    send_started = true;
    send_thread = std::thread([this] { runSendWorker(); });
  }

  void runSendWorker() {
    while (true) {
      PreviewBlob blob;
      {
        std::unique_lock<std::mutex> lock(send_mu);
        send_cv.wait(lock, [this] {
          return send_stop.load(std::memory_order_acquire) || !send_queue.empty();
        });
        if (send_queue.empty()) {
          if (send_stop.load(std::memory_order_acquire)) return;
          continue;
        }
        blob = std::move(send_queue.front());
        send_queue.pop_front();
      }
      BridgeServer::instance().broadcast_binary(blob.bytes.data(), blob.bytes.size());
    }
  }

  // Rebuild a PerExecutor's preview_requests from the doc JSON string.
  void refreshPreviewRequests(PerExecutor& pe, const std::string& raw_json) {
    auto raw = parseOrObject(raw_json);
    pe.preview_requests.clear();
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
      } else if (ttype == "sidechannel") {
        // Bus channel thumbnail — serviced at publish time straight from the
        // process-global sidechannel bus (no frame_captures hook involved);
        // the web routes these requests at the channel's WRITER instance so
        // the readback lands right after the frame that refreshed the bus.
        const std::string ch = target.value("channel", std::string());
        if (ch.empty()) continue;
        req.targetKey = "sc:" + ch;
      } else if (ttype == "chain_entry") {
        const int col   = target.value("colIdx",   -1);
        const int chain = target.value("chainIdx", -1);
        const std::string side = target.value("side", std::string("output"));
        if (col < 0 || chain < 0) continue;
        char buf[64];
        snprintf(buf, sizeof(buf), "ce:%d/%d/%s", col, chain, side.c_str());
        req.targetKey = buf;
      } else {
        continue;
      }
      pe.preview_requests[req.traceId] = std::move(req);
    }
  }

  // Encode + commit this frame's preview readbacks for `key`. Runs under
  // render_mu, immediately after submit() (GPU work complete). The async
  // completion handlers ship bytes via the send worker. Frequency is bounded by
  // the render()-side rate limiter (previewIntervalSec); size by previewMaxDim.
  void publishPreviewFrames(const std::string& key, PerExecutor& pe) {
    if (!gpu) return;
    if (pe.preview_requests.empty()) return;
    if (!BridgeServer::instance().has_clients()) return;
    const uint32_t maxDim = previewMaxDim();
    gpu->beginPreviewBatch();
    for (const auto& [_, req] : pe.preview_requests) {
      CaptureSlot slot;
      if (req.targetKey.rfind("sc:", 0) == 0) {
        // Sidechannel thumbnail: resolve the bus-owned channel texture at
        // publish time (we run right after submit() under render_mu, so the
        // handle is stable and this frame's bus copy has been encoded).
        const auto r = sidechannel_bus::peek(req.targetKey.c_str() + 3);
        slot = {r.tex, r.w, r.h};
      } else {
        auto it = pe.frame_captures.find(req.targetKey);
        if (it == pe.frame_captures.end()) continue;
        slot = it->second;
      }
      if (slot.handle <= 0 || slot.width <= 0 || slot.height <= 0) continue;
      // Back-pressure gate: if this monitor's previous frame is still queued
      // (WS slower than the preview rate), skip the capture entirely — no GPU
      // scale/readback for pixels that would only replace an unsent frame.
      std::string route = key;
      route += '\n';
      route += req.traceId;
      {
        std::lock_guard<std::mutex> lock(send_mu);
        bool queued = false;
        for (const auto& blob : send_queue) {
          if (blob.route == route) { queued = true; break; }
        }
        if (queued) continue;
      }
      uint32_t outW = req.width  ? req.width  : (uint32_t)slot.width;
      uint32_t outH = req.height ? req.height : (uint32_t)slot.height;
      // Never read back more pixels than the source has — a request larger
      // than the comp (retina display box, zoom) would upscale on the GPU and
      // ship invented pixels.
      if (outW > (uint32_t)slot.width || outH > (uint32_t)slot.height) {
        double s = std::min((double)slot.width / (double)outW,
                            (double)slot.height / (double)outH);
        outW = std::max(1u, (uint32_t)(outW * s));
        outH = std::max(1u, (uint32_t)(outH * s));
      }
      // Cap the long edge — bounds absurd requests/comp sizes (and the NBPV
      // u16 dimension fields). See previewMaxDim.
      if (outW > maxDim || outH > maxDim) {
        double s = (double)maxDim / (double)std::max(outW, outH);
        outW = std::max(1u, (uint32_t)(outW * s));
        outH = std::max(1u, (uint32_t)(outH * s));
      }
      std::string traceId = req.traceId;
      std::string keyCopy = key;
      gpu->readbackTextureScaledAsync(
          slot.handle, (uint32_t)slot.width, (uint32_t)slot.height, outW, outH,
          [this, keyCopy = std::move(keyCopy), traceId = std::move(traceId),
           route = std::move(route), outW, outH](std::vector<uint8_t> pixels) {
            auto bytes = buildPreviewFrameBytes(
                keyCopy, traceId, (uint16_t)outW, (uint16_t)outH, pixels);
            {
              std::lock_guard<std::mutex> lock(send_mu);
              // Latest-wins: a frame for a route that (re-)queued while ours
              // was on the GPU is stale now — take its slot instead of
              // deepening the queue.
              bool replaced = false;
              for (auto& blob : send_queue) {
                if (blob.route == route) {
                  blob.bytes = std::move(bytes);
                  replaced = true;
                  break;
                }
              }
              if (!replaced) {
                constexpr size_t kMaxQueue = 64;  // safety net; normally ≤ one
                                                  // entry per live monitor
                while (send_queue.size() >= kMaxQueue) send_queue.pop_front();
                send_queue.push_back({route, std::move(bytes)});
              }
            }
            send_cv.notify_one();
          });
    }
    gpu->commitPreviewBatch();
  }
};

BarrelRuntime& BarrelRuntime::instance() {
  static BarrelRuntime inst;
  return inst;
}

BarrelRuntime::BarrelRuntime() : impl_(std::make_unique<Impl>()) {}
BarrelRuntime::~BarrelRuntime() = default;

bool BarrelRuntime::acquire(const std::string& wasm_dir, const std::string& font_path) {
  std::lock_guard<std::mutex> lk(impl_->lifecycle_mu);
  ++impl_->refcount;
  if (impl_->built) return impl_->usable;
  impl_->built = true;

  @autoreleasepool {
    impl_->device = MTLCreateSystemDefaultDevice();
  }
  if (!impl_->device) { BRT_LOG("MTLCreateSystemDefaultDevice failed"); return false; }

  impl_->gpu = gpu::createMetalBackend();
  if (!impl_->gpu) { BRT_LOG("createMetalBackend failed"); return false; }

  impl_->rt = std::make_unique<effect_runtime::EffectRuntime>(impl_->gpu.get());
  impl_->registry = std::make_unique<sketch_executor::ModuleRegistry>(impl_->rt.get());

  impl_->bundles = std::make_unique<sketch_executor::WasmEffectBundles>();
  int total = 0;
  if (impl_->bundles->init()) {
    for (const char* name : kBundleNames) {
      std::string path = wasm_dir + "/" + name + ".wasm";
      int n = impl_->bundles->loadBundleFile(path, *impl_->registry, impl_->gpu.get(), nullptr);
      BRT_LOG("wasm bundle '%s': %d effect(s) from %s", name, n, path.c_str());
      total += n;
    }
  }
  if (total == 0) {
    BRT_LOG("ERROR: no WASM effects loaded (wasm_dir=%s)", wasm_dir.c_str());
    impl_->bundles.reset();
  }

  if (!font_path.empty()) effect_runtime::textInstallDefaultFonts(font_path.c_str());

  impl_->startSendWorker();
  impl_->rt->drainConsoleLog();
  impl_->usable = (total > 0);
  BRT_LOG("acquired: %d effect(s) loaded", total);
  return impl_->usable;
}

void BarrelRuntime::release() {
  std::lock_guard<std::mutex> lk(impl_->lifecycle_mu);
  if (impl_->refcount > 0) --impl_->refcount;
  // Note: we intentionally do NOT tear down the runtime at refcount 0 for now —
  // Resolume rebuilds instances frequently, and rebuilding the whole effect set
  // is expensive. The singleton lives for the process. (Per-key executors ARE
  // destroyed in destroyExecutor.)
}

void* BarrelRuntime::metalDevice() {
  return (__bridge void*)impl_->device;
}

std::string BarrelRuntime::schemasJson() {
  std::lock_guard<std::mutex> lk(impl_->render_mu);
  nlohmann::json out = nlohmann::json::object();
  if (!impl_->registry) return out.dump();
  for (const auto& [module_type, schema_fields] : impl_->registry->schemas()) {
    out[module_type] = {
      {"key", module_type},
      {"id", module_type},
      {"version", "0.0.0"},
      {"schema", schema_fields},
    };
  }
  return out.dump();
}

void BarrelRuntime::createExecutor(const std::string& key) {
  std::lock_guard<std::mutex> lk(impl_->render_mu);
  if (!impl_->usable) return;
  if (impl_->executors.count(key)) return;
  auto [it, inserted] = impl_->executors.try_emplace(key);
  Impl::PerExecutor& pe = it->second;
  pe.executor = std::make_unique<sketch_executor::SketchExecutor>(
      impl_->rt.get(), impl_->registry.get(), impl_->gpu.get());
  // Namespace this instance's effect-state keys by its plugin key so two
  // barrels with colliding bare keys (e.g. "inv@0") stay isolated in the
  // shared instance pool.
  pe.executor->setKeyNamespace(key + "/");
  // Sidechannel-bus writes carry the plugin key as their writer tag — the
  // editor maps it to the instance label for channel names.
  pe.executor->setBusTag(key);
  if (const char* f = getenv("NANO_BARREL_FUSION"); f && (*f == '0')) {
    pe.executor->setFusionEnabled(false);
  }

  // Capture hooks. They fire DURING execute() (between chain-entry encodes),
  // so we only record handles here; readback happens after submit(). They
  // capture a stable pointer to this PerExecutor — unordered_map elements are
  // pointer-stable across rehash, and the executor (owner of the lambdas) is
  // destroyed before the node is erased.
  Impl::PerExecutor* pep = &pe;
  pep->executor->setChainEntryHook(
      [pep](int colIdx, int chainIdx, int32_t inputHandle, int32_t outputHandle,
            int W, int H) {
        if (!pep->captures_enabled) return;
        char buf[64];
        snprintf(buf, sizeof(buf), "ce:%d/%d/input", colIdx, chainIdx);
        pep->frame_captures[buf] = {inputHandle, W, H};
        snprintf(buf, sizeof(buf), "ce:%d/%d/output", colIdx, chainIdx);
        pep->frame_captures[buf] = {outputHandle, W, H};
      });
  pep->executor->setSketchOutputHook(
      [pep](int32_t handle, int W, int H) {
        if (!pep->captures_enabled) return;
        pep->frame_captures["so"] = {handle, W, H};
      });
  pep->executor->setBarrierPredicate(
      [pep](int colIdx, int chainIdx) -> bool {
        if (!pep->captures_enabled) return false;
        for (const auto& [_, req] : pep->preview_requests) {
          const std::string& tk = req.targetKey;
          if (tk.rfind("ce:", 0) != 0) continue;
          int rcol = -1, rchain = -1;
          char side[16] = {0};
          if (std::sscanf(tk.c_str(), "ce:%d/%d/%15s", &rcol, &rchain, side) != 3)
            continue;
          if (rcol != colIdx) continue;
          if (rchain == chainIdx && std::strcmp(side, "output") == 0) return true;
          if (rchain == chainIdx + 1 && std::strcmp(side, "input") == 0) return true;
        }
        return false;
      });

  BRT_LOG("executor created key=%s (now %zu)", key.c_str(), impl_->executors.size());
}

void BarrelRuntime::destroyExecutor(const std::string& key) {
  std::lock_guard<std::mutex> lk(impl_->render_mu);
  auto it = impl_->executors.find(key);
  if (it == impl_->executors.end()) return;
  // Free this barrel's namespaced effect instances from the shared pool while
  // GPU-idle under the render lock (EffectInstance dtors call_indirect into the
  // shared WasmHost + GPU). Any in-flight preview readback for this key only
  // captures value types + the shared backend's scratch pool, so it stays valid.
  if (impl_->rt) impl_->rt->destroyInstancesWithKeyPrefix(key + "/");
  impl_->executors.erase(it);
  BRT_LOG("executor destroyed key=%s (now %zu)", key.c_str(), impl_->executors.size());
}

bool BarrelRuntime::render(const std::string& key, void* in_tex, void* out_tex,
                           int w, int h, double dt, double elapsed, bool dirty,
                           const float* macros, int n_macros) {
  std::lock_guard<std::mutex> lk(impl_->render_mu);
  if (!impl_->usable) return false;
  auto it = impl_->executors.find(key);
  if (it == impl_->executors.end()) return false;
  Impl::PerExecutor& pe = it->second;
  ++pe.frame;

  auto& server = BridgeServer::instance();
  const std::string base = "/plugins/" + key + "/state";

  // Re-fetch the sketch + preview requests only on a real change (editor patch
  // or host config restore). The deep copy of the whole sketch subtree is the
  // bulk of per-frame JSON churn, so caching it is the native analogue of the
  // web's compile-once GraphDefinition.
  if (dirty || !pe.haveSketch) {
    auto parsed = nlohmann::json::parse(server.get_at(base + "/sketch"), nullptr, false);
    if (!parsed.is_discarded()) { pe.sketch = std::move(parsed); pe.haveSketch = true; }
    impl_->refreshPreviewRequests(pe, server.get_at(base + "/preview_requests"));
  }
  if (!pe.haveSketch || !in_tex || !out_tex) return false;

  // Only do telemetry/preview work when an editor actually observes THIS key.
  const bool watched = server.key_observed(key);

  // Route the live macro knobs into any control.barrel_macros instance's state
  // (on the cached sketch copy — the persisted sketch is untouched) and, when
  // watched, publish them so the editor's output-trace cards show live values.
  if (macros && n_macros > 0 && pe.sketch.contains("instances") &&
      pe.sketch["instances"].is_object()) {
    nlohmann::json macroOut = nlohmann::json::object();
    const int nm = n_macros < (int)kNumMacros ? n_macros : (int)kNumMacros;
    for (auto& [ikey, inst] : pe.sketch["instances"].items()) {
      if (!inst.is_object()) continue;
      if (inst.value("module_type", std::string()) != "control.barrel_macros") continue;
      auto& st = inst["state"];
      if (!st.is_object()) st = nlohmann::json::object();
      nlohmann::json fields = nlohmann::json::object();
      for (int i = 0; i < nm; ++i) {
        double v = (double)macros[i];
        st["macro_" + std::to_string(i)] = v;
        fields["macro_" + std::to_string(i)] = v;
      }
      macroOut[ikey] = std::move(fields);
    }
    // Publish only when watched AND the values actually changed — knobs are
    // static most frames, so this is normally a no-op (no doc diff, no patch).
    if (watched && !macroOut.empty() &&
        (!pe.haveLastMacroOut || macroOut != pe.lastMacroOut)) {
      pe.lastMacroOut = macroOut;
      pe.haveLastMacroOut = true;
      server.set_at(base + "/macro_outputs", macroOut.dump());
    }
  }

  // Rate-limit previews independently of the render rate. On non-capture frames
  // captures_enabled is false, so the executor's capture hooks + fusion-barrier
  // predicate are inert — GPU fusion stays on and no readback is encoded, so
  // those frames run at full render speed.
  const double pvInterval = previewIntervalSec();
  pe.captures_enabled = watched && !pe.preview_requests.empty() &&
      (pvInterval <= 0.0 || (elapsed - pe.lastPreviewElapsed) >= pvInterval);
  if (pe.captures_enabled) {
    pe.frame_captures.clear();
    pe.lastPreviewElapsed = elapsed;
  }

  effect_runtime::setHostTime(elapsed);
  effect_runtime::setHostDeltaTime(dt);
  effect_runtime::setHostViewport(w, h);

  int32_t inputHandle = impl_->gpu->adoptExternalTexture(in_tex);
  int32_t outputHandle = impl_->gpu->adoptExternalTexture(out_tex);

  int32_t finalHandle =
      pe.executor->execute(pe.sketch, inputHandle, outputHandle, w, h, dt, dirty);

  impl_->gpu->submit();
  impl_->rt->drainConsoleLog();

  // Publish this frame's float-rail values for the editor's spark charts (the
  // native mirror of the web executor's /sketch_state publish). Dedup against
  // the last publish: a static sketch's rails don't change, so this skips the
  // dump + parse + RFC-6902 diff entirely (the per-frame cost that, under
  // tick_mutex_, throttled the render thread when a client was connected).
  if (watched) {
    const nlohmann::json& rail = pe.executor->lastRailState();
    if (!pe.haveLastRail || rail != pe.lastRail) {
      pe.lastRail = rail;
      pe.haveLastRail = true;
      server.set_at(base + "/sketch_state", rail.dump());
    }
  }

  // Publish each instance's LIVE set_val outputs (state::setValPath broadcasts
  // — e.g. shape_fold's autopilot_x/_y) keyed by BARE instance_key. The web
  // merges this into pluginStates, which output-reading widgets (the shape_fold
  // XY-pad handle, output trace cards) poll — without it those broadcasts never
  // leave the process and the pad snaps back to the schema default. Deduped
  // like sketch_state: static outputs cost one JSON compare per frame.
  if (watched && pe.sketch.contains("chain") && pe.sketch["chain"].is_array()) {
    nlohmann::json ps = nlohmann::json::object();
    for (const auto& e : pe.sketch["chain"]) {
      if (!e.is_object() || e.value("type", std::string()) != "module") continue;
      const std::string mt = e.value("module_type", std::string());
      const std::string ik = e.value("instance_key", std::string());
      if (mt.empty() || ik.empty()) continue;
      // findInstance: never instantiate from the telemetry path — the
      // executor owns instance creation as it renders.
      auto* einst = impl_->rt->findInstance(mt, key + "/" + ik);
      if (!einst) continue;
      const std::string pj = einst->publishedStateJson();
      if (pj.empty()) continue;
      auto parsed = nlohmann::json::parse(pj, nullptr, false);
      if (!parsed.is_discarded() && parsed.is_object() && !parsed.empty())
        ps[ik] = std::move(parsed);
    }
    if (!pe.haveLastPluginStates || ps != pe.lastPluginStates) {
      // Skip the very first publish when there is nothing to say (a sketch
      // with no broadcasting effects never touches the doc).
      const bool firstAndEmpty = !pe.haveLastPluginStates && ps.empty();
      pe.lastPluginStates = std::move(ps);
      pe.haveLastPluginStates = true;
      if (!firstAndEmpty)
        server.set_at(base + "/plugin_states", pe.lastPluginStates.dump());
    }
  }

  // Publish sidechannel-bus channel metadata (channel → writer/size) when it
  // changes. The version bumps only on identity changes — never per write —
  // so this is one integer compare per render. Same lock order as the
  // macro_outputs publish above: render_mu held, set_at takes tick_mutex_
  // internally; the WsServer is never touched directly from here.
  if (server.has_clients()) {
    const int64_t busVersion = (int64_t)sidechannel_bus::version();
    if (busVersion != impl_->lastBusVersion) {
      impl_->lastBusVersion = busVersion;
      std::string info(1024, '\0');
      int32_t n = sidechannel_bus::infoJson(info.data(), (int32_t)info.size());
      if (n > (int32_t)info.size()) {
        info.resize((size_t)n);
        n = sidechannel_bus::infoJson(info.data(), (int32_t)info.size());
      }
      info.resize((size_t)(n < 0 ? 0 : n));
      server.set_at("/global/sidechannels", info);
    }
  }

  // After submit() the GPU work is complete; publish any requested previews
  // before next frame's execute() rotates the intermediate pool.
  if (pe.captures_enabled) impl_->publishPreviewFrames(key, pe);

  impl_->gpu->release(inputHandle);
  impl_->gpu->release(outputHandle);

  return finalHandle == outputHandle;
}

}  // namespace bridge
