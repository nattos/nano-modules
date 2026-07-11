#include "bridge/barrel_runtime.h"

#import <Metal/Metal.h>

#include <algorithm>
#include <atomic>
#include <chrono>
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

#include <fstream>
#include <sys/stat.h>

#include "bridge/bridge_server.h"
#include "bridge/preview_codec.h"
#include "bridge/ws_server.h"
#include "gpu/gpu_backend.h"
#include "midi/midi_host.h"
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

// Best-effort "a barrel frame reached the display" watermark (see barrel_runtime.h).
static std::atomic<uint64_t> g_barrel_present_seq{0};
uint64_t barrelPresentSeq() { return g_barrel_present_seq.load(std::memory_order_relaxed); }

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
// Builds into a caller-provided (typically pooled) vector: fresh multi-MB
// allocations per preview frame cost more than the GPU readback itself, so
// the frame buffers are recycled through Impl::blob_pool.
double gBuildResizeMs = 0, gBuildCopyMs = 0;  // preview_ts scratch metrics
double epochMsNow();

void buildPreviewFrameBytesInto(
    std::vector<uint8_t>& out,
    const std::string& key, const std::string& traceId,
    uint16_t width, uint16_t height,
    const uint8_t* pixels, size_t pixelBytes) {
  // Canonical NBPV layout lives in preview_codec.h (shared with the NanoLooper
  // Ch marker). The resize/copy split is only a debug [preview_ts] scratch.
  const double t0 = epochMsNow();
  preview_codec::build_nbpv_frame(out, key, traceId, width, height, pixels,
                                  pixelBytes);
  gBuildResizeMs = 0;
  gBuildCopyMs = epochMsNow() - t0;
}

nlohmann::json parseOrObject(const std::string& s) {
  auto j = nlohmann::json::parse(s, nullptr, false);
  return j.is_discarded() ? nlohmann::json::object() : j;
}

// Preview cadence + size caps (read once). Decouple the preview rate from the
// render rate (default 30 Hz) and bound the readback long-edge. The main
// edit-preview requests FULL SOURCE resolution (width/height 0 → the comp
// size), so the cap's default (4096) is only a guard against absurd comp
// sizes (and the NBPV u16 dimension fields); the per-route in-flight gate is
// what keeps a slow pipeline from backing up. Drop NANO_BARREL_PREVIEW_MAXDIM
// (e.g. 512) to trade preview sharpness for pipeline bytes. Both env-tunable.
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

// Latency-diagnosis mode (NANO_PREVIEW_TS=1): stamp wall-clock times into the
// first 6 pixels of every NBPV payload so an instrumented client can break the
// end-to-end preview latency into stages. Three little-endian float64s at
// pixel offsets 0/8/16 (epoch milliseconds — comparable to JS Date.now()):
//   [0]  capture encode time (publishPreviewFrames, right after submit)
//   [8]  GPU readback completion (pixels landed on CPU)
//   [16] send-worker dequeue (just before the WS broadcast)
// Bench-only: corrupts the frame's top-left corner, so it is never on by
// default.
bool previewTsEnabled() {
  static bool v = [] {
    const char* e = getenv("NANO_PREVIEW_TS");
    return e && *e && strcmp(e, "0") != 0;
  }();
  return v;
}
double epochMsNow() {
  return std::chrono::duration<double, std::milli>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}
void stampPreviewTs(std::vector<uint8_t>& frameBytes, size_t slot, double ms) {
  const size_t keyLen = frameBytes[6] | ((size_t)frameBytes[7] << 8);
  const size_t idLen  = frameBytes[8] | ((size_t)frameBytes[9] << 8);
  const size_t off = 14 + keyLen + idLen + slot * 8;
  if (off + 8 > frameBytes.size()) return;
  memcpy(frameBytes.data() + off, &ms, 8);
}

// Preview frames leave the process as "NBPC" chunks striped across the
// fan-out lanes (see below): [0..3]"NBPC" [4..7]u32 seq [8..9]u16 idx
// [10..11]u16 count, then the byte slice. The receiver collects a seq's
// chunks (they arrive across different sockets, unordered) and feeds the
// reassembled NBPV frame to the normal decoder. NANO_PREVIEW_CHUNK_KB
// overrides the slice size (default 256KB).
size_t previewChunkBytes() {
  static size_t v = [] {
    const char* e = getenv("NANO_PREVIEW_CHUNK_KB");
    long kb = e ? atol(e) : 256;
    return kb > 0 ? (size_t)kb * 1024 : (size_t)(256 * 1024);
  }();
  return v;
}

// Preview fan-out lanes: N extra WS servers (ports scanned upward from
// NANO_BRIDGE_PORT+1 and advertised in /global/preview_transport), each with
// its own send thread. One WS connection's blocking flush loop tops out
// around ~109MB/s — far below what a full-res RGBA stream needs — so frames
// are sliced into NBPC chunks striped round-robin and the lanes' flush loops
// run in parallel. The main bridge socket NEVER carries binary frames; the
// editor connects to every advertised lane and reassembles.
// NANO_PREVIEW_FANOUT overrides the lane count (default 8, clamp 1..16).
int previewFanoutLanes() {
  static int v = [] {
    const char* e = getenv("NANO_PREVIEW_FANOUT");
    int n = e ? atoi(e) : 8;
    if (n < 1) n = 1;
    return n > 16 ? 16 : n;
  }();
  return v;
}
int bridgePortFromEnv() {
  const char* p = getenv("NANO_BRIDGE_PORT");
  const int port = p ? atoi(p) : 0;
  return port > 0 ? port : 8081;
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
    nlohmann::json lastModulation;
    bool haveLastRail = false;
    bool haveLastMacroOut = false;
    bool haveLastPluginStates = false;
    bool haveLastModulation = false;
    // Host-elapsed time of the last preview-capture frame, for rate limiting.
    double lastPreviewElapsed = -1e9;
    // Last-applied MidiHost table version — setExternalScalars only re-runs
    // when a device value / sim override / library rematch actually changed.
    uint64_t lastMidiVersion = 0;
  };
  std::unordered_map<std::string, PerExecutor> executors;

  // --- MIDI library/sim sync (render thread, under render_mu) ---
  std::string lastMidiDevicesJson;
  std::string lastMidiSimJson;
  std::chrono::steady_clock::time_point lastMidiLibPoll{};
  std::chrono::steady_clock::time_point lastMidiSimPoll{};

  static std::string midiSidecarPath() {
    const char* home = getenv("HOME");
    if (!home) return {};
    const std::string dir = std::string(home) + "/Library/Application Support/NanoBarrel";
    mkdir(dir.c_str(), 0755);
    return dir + "/midi_devices.json";
  }

  /// Keep the native MIDI host fed: the device library rides
  /// /global/midi_devices (web-mirrored; 1 Hz poll — a few KB, don't dump it
  /// per frame; persisted to a sidecar for headless restarts) and the web's
  /// simulation overrides ride /global/midi_sim (small + latency-sensitive —
  /// polled at up to ~120 Hz, dropped when no client is connected so a
  /// vanished editor can't pin stale overrides).
  void pollMidi(BridgeServer& server) {
    const auto now = std::chrono::steady_clock::now();
    if (now - lastMidiLibPoll > std::chrono::seconds(1)) {
      lastMidiLibPoll = now;
      std::string devices = server.get_at("/global/midi_devices");
      if (devices != lastMidiDevicesJson) {
        lastMidiDevicesJson = devices;
        auto parsed = nlohmann::json::parse(devices, nullptr, false);
        if (parsed.is_array()) {
          nano_midi::MidiHost::instance().setLibrary(parsed);
          const std::string path = midiSidecarPath();
          if (!path.empty()) {
            std::ofstream f(path, std::ios::trunc);
            if (f.good()) f << devices;
          }
        }
      }
    }
    if (now - lastMidiSimPoll > std::chrono::milliseconds(8)) {
      lastMidiSimPoll = now;
      std::string sim = server.has_clients() ? server.get_at("/global/midi_sim")
                                             : std::string("{}");
      if (sim != lastMidiSimJson) {
        lastMidiSimJson = sim;
        auto parsed = nlohmann::json::parse(sim, nullptr, false);
        nano_midi::MidiHost::instance().setSimOverrides(
            parsed.is_object() ? parsed : nlohmann::json::object());
      }
    }
  }

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

  // Per-route pipeline-depth gate (guarded by send_mu). The old back-pressure
  // check only looked at send_queue — frames still in the READBACK stage
  // (batch committed, getBytes pending on the serial readback queue) were
  // invisible, so whenever the WS channel was faster than the readback stage,
  // captures over-fired and the readback queue built a standing backlog
  // (~1s at 30Hz with a 7MB edit preview). Track a route from capture-encode
  // until its bytes leave the send worker; at most ONE frame per route may be
  // in flight. The timestamp self-heals a leaked entry (a readback whose
  // command buffer errored never calls back) after 1s.
  std::unordered_map<std::string, double> inflight_routes;

  // Recycled frame buffers (guarded by send_mu). resize() within retained
  // capacity is a cheap memset instead of a fresh mmap + page-fault storm —
  // allocating 7MB per preview frame measured ~14ms, dwarfing the actual
  // pixel copy (~0.1ms). Bounded by BYTES, not entry count: a count cap let
  // the per-tick churn of tiny monitor buffers evict the multi-MB frames the
  // pool exists for (every other full-res frame paid the alloc again).
  static constexpr size_t kMaxBlobPoolBytes = 128 * 1024 * 1024;
  std::vector<std::vector<uint8_t>> blob_pool;
  size_t blob_pool_bytes = 0;

  std::vector<uint8_t> acquireBlobBuf(size_t sizeHint) {
    std::lock_guard<std::mutex> lk(send_mu);
    // BEST fit, not first fit: a tiny monitor frame must not walk off with a
    // multi-MB buffer (any capacity satisfies it) — that strands the big
    // route on a fresh allocation (page-fault storm) every frame while its
    // buffer circulates through a 9KB thumbnail's pipeline.
    auto best = blob_pool.end();
    for (auto it = blob_pool.begin(); it != blob_pool.end(); ++it) {
      if (it->capacity() < sizeHint) continue;
      if (best == blob_pool.end() || it->capacity() < best->capacity()) best = it;
    }
    if (best == blob_pool.end()) return {};
    auto b = std::move(*best);
    blob_pool.erase(best);
    blob_pool_bytes -= b.capacity();
    return b;
  }
  void releaseBlobBuf(std::vector<uint8_t>&& b) {
    std::lock_guard<std::mutex> lk(send_mu);
    if (blob_pool_bytes + b.capacity() > kMaxBlobPoolBytes) return;  // drop
    blob_pool_bytes += b.capacity();
    blob_pool.push_back(std::move(b));
  }

  bool routeInFlight(const std::string& route) {
    std::lock_guard<std::mutex> lk(send_mu);
    auto it = inflight_routes.find(route);
    if (it == inflight_routes.end()) return false;
    if (epochMsNow() - it->second > 1000.0) {  // self-heal leaked entries
      inflight_routes.erase(it);
      return false;
    }
    return true;
  }
  void markRouteInFlight(const std::string& route) {
    std::lock_guard<std::mutex> lk(send_mu);
    inflight_routes[route] = epochMsNow();
  }
  void clearRouteInFlight(const std::string& route) {
    std::lock_guard<std::mutex> lk(send_mu);
    inflight_routes.erase(route);
  }

  // Fan-out lanes (see previewFanoutLanes). Each lane owns a WsServer on its
  // own port and a worker thread draining its own chunk queue, so N blocking
  // flushes proceed in parallel.
  // Chunk descriptor: lanes slice the shared frame buffer themselves, so the
  // dispatch loop does no per-chunk memcpy (that 14-15ms serial copy was the
  // scaling floor at 8 lanes).
  struct FanoutChunk {
    std::shared_ptr<std::vector<uint8_t>> frame;
    size_t off = 0, len = 0;
    uint32_t seq = 0;
    uint16_t idx = 0, cnt = 0;
  };
  struct FanoutLane {
    std::unique_ptr<WsServer> server;
    std::thread worker;
    std::mutex mu;
    std::condition_variable cv;
    std::deque<FanoutChunk> queue;
    bool stop = false;
  };
  std::vector<std::unique_ptr<FanoutLane>> fanout_lanes;
  std::vector<int> fanout_ports;  // actual bound ports, advertisement order

  void startFanoutLanes() {
    const int n = previewFanoutLanes();
    if (n <= 0 || !fanout_lanes.empty()) return;
    const int base = bridgePortFromEnv();
    // Scan upward from base+1, skipping ports something else holds
    // (ixwebsocket can't report an OS-assigned port for a port-0 bind, so
    // scan-and-advertise is the mechanism). The ACTUAL bound ports go into
    // /global/preview_transport for the client to discover.
    int nextPort = base + 1;
    const int lastPort = base + 32;
    for (int i = 0; i < n && nextPort <= lastPort; ++i) {
      auto lane = std::make_unique<FanoutLane>();
      lane->server = std::make_unique<WsServer>();
      int port = 0;
      while (nextPort <= lastPort) {
        const int tryPort = nextPort++;
        if (lane->server->start(tryPort)) { port = tryPort; break; }
        BRT_LOG("fanout lane %d: port %d unavailable, trying next", i, tryPort);
        lane->server = std::make_unique<WsServer>();  // fresh after failed start
      }
      if (port == 0) {
        BRT_LOG("fanout lane %d: no free port in %d..%d", i, base + 1, lastPort);
        break;
      }
      FanoutLane* lp = lane.get();
      lane->worker = std::thread([lp] {
        std::vector<uint8_t> bytes;
        while (true) {
          FanoutChunk c;
          {
            std::unique_lock<std::mutex> lock(lp->mu);
            lp->cv.wait(lock, [lp] { return lp->stop || !lp->queue.empty(); });
            if (lp->queue.empty()) {
              if (lp->stop) return;
              continue;
            }
            c = std::move(lp->queue.front());
            lp->queue.pop_front();
          }
          bytes.resize(12 + c.len);
          bytes[0] = 'N'; bytes[1] = 'B'; bytes[2] = 'P'; bytes[3] = 'C';
          memcpy(bytes.data() + 4, &c.seq, 4);
          memcpy(bytes.data() + 8, &c.idx, 2);
          memcpy(bytes.data() + 10, &c.cnt, 2);
          memcpy(bytes.data() + 12, c.frame->data() + c.off, c.len);
          lp->server->broadcast_binary(bytes.data(), bytes.size());
        }
      });
      BRT_LOG("fanout lane %d on port %d", i, port);
      fanout_lanes.push_back(std::move(lane));
      fanout_ports.push_back(port);
    }
    if (fanout_lanes.empty()) {
      BRT_LOG("ERROR: no preview fanout lanes bound (ports %d..%d) — previews "
              "will NOT flow (binary frames never ride the main bridge socket)",
              base + 1, lastPort);
    }
  }

  // Advertise the lane ports so the editor can connect to them. Runs with no
  // Impl locks held; set_at takes the bridge tick_mutex_ internally.
  void publishPreviewTransport() {
    nlohmann::json doc = {
      {"version", 1},
      {"ports", fanout_ports},
      {"chunk_bytes", previewChunkBytes()},
    };
    BridgeServer::instance().set_at("/global/preview_transport", doc.dump());
  }

  // True while any lane has an open client — the capture gate: producing
  // readbacks is pointless when nobody is connected to the pixel plane, even
  // if a JSON client is on the main socket.
  bool lanesHaveClients() {
    for (auto& lane : fanout_lanes) {
      if (lane->server->has_open_clients()) return true;
    }
    return false;
  }

  void stopFanoutLanes() {
    for (auto& lane : fanout_lanes) {
      {
        std::lock_guard<std::mutex> lk(lane->mu);
        lane->stop = true;
      }
      lane->cv.notify_one();
      if (lane->worker.joinable()) lane->worker.join();
      lane->server->stop();
    }
    fanout_lanes.clear();
    fanout_ports.clear();
  }

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
    stopFanoutLanes();
  }

  void startSendWorker() {
    if (send_started) return;
    send_started = true;
    startFanoutLanes();
    publishPreviewTransport();
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
      if (previewTsEnabled()) stampPreviewTs(blob.bytes, 2, epochMsNow());
      const size_t chunkBytes = previewChunkBytes();
      const double bcastT0 = previewTsEnabled() ? epochMsNow() : 0.0;
      // Binary frames leave ONLY via the fan-out lanes — the main bridge
      // socket is the JSON control plane and never carries pixels. With no
      // lanes bound (startup port exhaustion), frames are dropped.
      if (fanout_lanes.empty()) {
        releaseBlobBuf(std::move(blob.bytes));
        clearRouteInFlight(blob.route);
        continue;
      }
      {
        // Memory safety net only: the per-route in-flight gate already bounds
        // steady-state lane depth to ~one frame per live monitor, and two big
        // frames dispatching back-to-back legitimately overlap (the second
        // rides ~a frame's worth of chunks behind the first). Only drop when
        // the lanes hold several frames' worth — a dead-slow client.
        size_t backlog = 0;
        for (auto& lane : fanout_lanes) {
          std::lock_guard<std::mutex> lk(lane->mu);
          backlog += lane->queue.size();
        }
        if (backlog > fanout_lanes.size() * 16) {
          if (previewTsEnabled())
            std::fprintf(stderr, "[preview_ts] fanout DROP frame (%zu bytes, backlog %zu chunks)\n",
                         blob.bytes.size(), backlog);
          releaseBlobBuf(std::move(blob.bytes));
          clearRouteInFlight(blob.route);
          continue;
        }
        static uint32_t fanSeq = 0;
        const uint32_t seq = ++fanSeq;
        const size_t n = (blob.bytes.size() + chunkBytes - 1) / chunkBytes;
        // Custom deleter runs when the LAST lane chunk has been sent: recycle
        // the frame's allocation AND only then clear the route's in-flight
        // mark — clearing at dispatch time let captures re-fire while the
        // lanes were still draining, and the lane queues built a standing
        // multi-frame backlog (~500ms) with two big monitors. Lanes are
        // joined before Impl members die (stopFanoutLanes in ~Impl), so
        // `this` outlives every deleter run.
        auto frame = std::shared_ptr<std::vector<uint8_t>>(
            new std::vector<uint8_t>(std::move(blob.bytes)),
            [this, route = blob.route](std::vector<uint8_t>* v) {
              releaseBlobBuf(std::move(*v));
              clearRouteInFlight(route);
              delete v;
            });
        for (size_t i = 0; i < n; ++i) {
          FanoutChunk c;
          c.frame = frame;
          c.off = i * chunkBytes;
          c.len = std::min(chunkBytes, frame->size() - c.off);
          c.seq = seq;
          c.idx = (uint16_t)i;
          c.cnt = (uint16_t)n;
          auto& lane = fanout_lanes[i % fanout_lanes.size()];
          {
            std::lock_guard<std::mutex> lk(lane->mu);
            lane->queue.push_back(std::move(c));
          }
          lane->cv.notify_one();
        }
        if (previewTsEnabled()) {
          std::fprintf(stderr,
              "[preview_ts] fanout dispatched %zu bytes x%zu(%zuKB) across %zu lanes in %.2f ms\n",
              frame->size(), n, chunkBytes / 1024, fanout_lanes.size(),
              epochMsNow() - bcastT0);
        }
        // Route clears in the frame deleter (last chunk sent), not here.
      }
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
    // Pixels flow only over the lanes; capturing is pointless unless a JSON
    // client is on the main socket AND someone is connected to the lanes.
    if (!BridgeServer::instance().has_clients()) return;
    if (!lanesHaveClients()) return;
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
      // Back-pressure gate: if this monitor's previous frame is anywhere in
      // the pipeline — readback stage OR send queue — skip the capture
      // entirely. No GPU scale/readback for pixels that would only pile up
      // behind an unfinished frame (see inflight_routes).
      std::string route = key;
      route += '\n';
      route += req.traceId;
      if (routeInFlight(route)) continue;
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
      markRouteInFlight(route);
      const double tEncode = previewTsEnabled() ? epochMsNow() : 0.0;
      gpu->readbackTextureScaledAsync(
          slot.handle, (uint32_t)slot.width, (uint32_t)slot.height, outW, outH,
          [this, keyCopy = std::move(keyCopy), traceId = std::move(traceId),
           route = std::move(route), outW, outH, tEncode](
              const uint8_t* pixels, size_t pixelBytes) {
            const bool big = previewTsEnabled() && pixelBytes > 1000000;
            const double ta = big ? epochMsNow() : 0.0;
            auto bytes = acquireBlobBuf(14 + keyCopy.size() + traceId.size() + pixelBytes);
            const double tb = big ? epochMsNow() : 0.0;
            buildPreviewFrameBytesInto(bytes, keyCopy, traceId,
                                       (uint16_t)outW, (uint16_t)outH,
                                       pixels, pixelBytes);
            if (big) {
              std::fprintf(stderr,
                  "[preview_ts] blob acquire %.2f build %.2f ms "
                  "(resize %.2f copy %.2f cap-hit %d)\n",
                  tb - ta, epochMsNow() - tb, gBuildResizeMs, gBuildCopyMs,
                  bytes.capacity() >= pixelBytes ? 1 : 0);
            }
            if (previewTsEnabled()) {
              stampPreviewTs(bytes, 0, tEncode);
              stampPreviewTs(bytes, 1, epochMsNow());
            }
            {
              std::lock_guard<std::mutex> lock(send_mu);
              // Latest-wins: a frame for a route that (re-)queued while ours
              // was on the GPU is stale now — take its slot instead of
              // deepening the queue. (With the inflight_routes gate this path
              // is normally unreachable; kept as a safety net.)
              bool replaced = false;
              for (auto& blob : send_queue) {
                if (blob.route == route) {
                  std::swap(blob.bytes, bytes);
                  if (blob_pool_bytes + bytes.capacity() <= kMaxBlobPoolBytes) {
                    blob_pool_bytes += bytes.capacity();
                    blob_pool.push_back(std::move(bytes));
                  }
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

  // Native MIDI host: start CoreMIDI and seed the device library from the
  // persisted sidecar so headless sessions (no web editor connected) still
  // map hardware to instances. The web's live mirror (/global/midi_devices,
  // via pollMidi) overwrites this as soon as an editor pushes.
  if (impl_->usable) {
    auto& server = BridgeServer::instance();
    const std::string existing = server.get_at("/global/midi_devices");
    auto existingParsed = nlohmann::json::parse(existing, nullptr, false);
    if (!existingParsed.is_array()) {
      const std::string path = Impl::midiSidecarPath();
      std::ifstream f(path);
      if (f.good()) {
        std::string blob((std::istreambuf_iterator<char>(f)),
                         std::istreambuf_iterator<char>());
        auto parsed = nlohmann::json::parse(blob, nullptr, false);
        if (parsed.is_array()) {
          server.set_at("/global/midi_devices", blob);
          nano_midi::MidiHost::instance().setLibrary(parsed);
          impl_->lastMidiDevicesJson = server.get_at("/global/midi_devices");
          BRT_LOG("midi: seeded %d device(s) from sidecar", (int)parsed.size());
        }
      }
    }
    nano_midi::MidiHost::instance().start();
  }

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
                           const float* macros, int n_macros,
                           double bar_phase, double bpm) {
  std::lock_guard<std::mutex> lk(impl_->render_mu);
  if (!impl_->usable) return false;
  auto it = impl_->executors.find(key);
  if (it == impl_->executors.end()) return false;
  Impl::PerExecutor& pe = it->second;
  // Per-frame autorelease pool. The Metal render path creates autoreleased
  // objects every frame (MTLRenderPassDescriptor + command encoders and their
  // AGX backing contexts). A plugin must NOT rely on the host draining a pool
  // around each render: Resolume's render thread isn't guaranteed to, and
  // ffgl_runner's serve loop runs thousands of frames inside one outer pool — so
  // without this those objects pile up unbounded (~5/frame → a steady multi-
  // MB/min heap climb, caught by the soak test). Draining here keeps every
  // frame's Metal temporaries self-contained. (All exits below are `return`s, so
  // the pool drains on each.)
  @autoreleasepool {
  ++pe.frame;
  // Best-effort present proxy: a new frame is being produced, so the previous
  // one was consumed by Resolume (it asked for the next). Bump the process-global
  // watermark the pump reads to release strict triggers (~1 frame after emit).
  g_barrel_present_seq.fetch_add(1, std::memory_order_relaxed);

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

  // MIDI device values → the executor's external-scalar table. The host's
  // version bumps on hardware/sim/library change; a static table costs one
  // integer compare per frame.
  impl_->pollMidi(server);
  {
    auto& mh = nano_midi::MidiHost::instance();
    const uint64_t mv = mh.version();
    if (mv != pe.lastMidiVersion) {
      pe.lastMidiVersion = mv;
      pe.executor->setExternalScalars(mh.externalScalars());
    }
  }

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
  //
  // Accept a capture up to half a render tick EARLY: elapsed advances on the
  // host's tick grid, so a strict >= interval test rejects the tick that
  // lands exactly at the interval and waits a whole extra tick (a 30Hz cap
  // on a 60Hz host effectively ran ~20Hz).
  const double pvInterval = previewIntervalSec();
  pe.captures_enabled = watched && !pe.preview_requests.empty() &&
      (pvInterval <= 0.0 ||
       (elapsed - pe.lastPreviewElapsed) >= pvInterval - dt * 0.5);
  if (pe.captures_enabled) {
    pe.frame_captures.clear();
    pe.lastPreviewElapsed = elapsed;
  }

  effect_runtime::setHostTime(elapsed);
  effect_runtime::setHostDeltaTime(dt);
  effect_runtime::setHostViewport(w, h);
  // Host musical clock (FFGL SetBeatInfo, threaded through from the plugin) → the
  // wasm effects' host.* imports (FrameState), which is what the beat-synced
  // looper actually reads via host::barPhase(). The effect_runtime globals above
  // feed the separate statically-linked host path; the wasm executor path reads
  // the bundle FrameState set here. Without this the looper's phase stayed 0
  // (it "stopped looping").
  if (impl_->bundles)
    impl_->bundles->setHostClock(elapsed, dt, bar_phase, bpm, w, h);

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

  // Per-modulated-input effective value + swing band (executor-computed) —
  // the native mirror of the worker's modulationDataDiff channel; without it
  // no wire in live mode ever shows its modulation band on the dest slider.
  // Deduped like the channels above: static modulation costs one compare.
  if (watched) {
    const nlohmann::json& md = pe.executor->lastModulationData();
    if (!pe.haveLastModulation || md != pe.lastModulation) {
      const bool firstAndEmpty = !pe.haveLastModulation && md.empty();
      pe.lastModulation = md;
      pe.haveLastModulation = true;
      if (!firstAndEmpty)
        server.set_at(base + "/modulation_data", md.dump());
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
  }  // @autoreleasepool
}

}  // namespace bridge
