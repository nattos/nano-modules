/*
 * preview_bench — simulated-editor benchmark for the barrel preview path.
 *
 * Reproduces the Resolume-side cost of "an editor is connected and looking at
 * this instance" WITHOUT Resolume or a browser: it drives the exact same
 * render entry the FFGL barrel uses (bridge_executor_render → BarrelRuntime::
 * render, including rail/macro publishing, capture hooks, fusion barriers and
 * the preview readback+broadcast machinery) while an in-process ixwebsocket
 * client plays the editor: it observes the plugin key and sets
 * preview_requests, then drains the resulting patch + NBPV traffic.
 *
 * Scenario matrix (each timed over --frames after a warmup):
 *   baseline        no WS client at all
 *   observed        client observes the key; NO preview requests
 *   edit-preview    + one sketch_output request at its displayed size
 *   monitors        + chain-entry monitors (breaks fusion at those seams)
 *   thumbs          8 small sketch_output thumbnails (Instances tab)
 *   full            edit preview + monitors + thumbs
 * Each runs with a static chain and an animated one (mod.source.lfo on top —
 * rails then change EVERY frame, exercising the per-frame sketch_state path).
 *
 * Usage:
 *   preview_bench [--frames N] [--w W] [--h H] [--port P] [--only substr]
 * Env:
 *   NANO_BARREL_WASM_DIR    effect bundle dir (default: <cwd>/build/wasm)
 *   NANO_BARREL_PREVIEW_HZ  preview cadence (default 30)
 *   NANO_WAIT_COMPLETED=1   block on GPU completion per submit (A/B pacing)
 *
 * Output: one row per scenario — avg/p50/p95/p99/max frame ms, effective FPS,
 * and what the fake editor received (text msgs, NBPV frames, NBPV bytes).
 */

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <ixwebsocket/IXWebSocket.h>
#include <nlohmann/json.hpp>

#include "bridge/bridge_api.h"

namespace {

using Clock = std::chrono::steady_clock;

double msSince(Clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

// ---------------------------------------------------------------------------
// Sketches. Chain entries need "type":"module" (sketch_augment skips entries
// without it — no struct/texture rails, effect reads nothing).
// ---------------------------------------------------------------------------

const char* kStaticSketch = R"JSON({
  "chain": [
    { "type": "module", "module_type": "source.gradient",                "instance_key": "grad@0" },
    { "type": "module", "module_type": "filter.blur.gaussian",           "instance_key": "blur@0" },
    { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "bc@0" },
    { "type": "module", "module_type": "color.invert",                   "instance_key": "inv@0" }
  ],
  "instances": {
    "grad@0": { "module_type": "source.gradient",                "state": {} },
    "blur@0": { "module_type": "filter.blur.gaussian",           "state": {} },
    "bc@0":   { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.1, "contrast": 0.1 } },
    "inv@0":  { "module_type": "color.invert",                   "state": {} }
  },
  "wires": []
})JSON";

// Same chain with an LFO on top: its float output rides the rail, so
// lastRailState() changes every frame → the watched-path sketch_state publish
// runs at render rate (the real editor-connected steady state for any sketch
// with animated modulation).
const char* kAnimatedSketch = R"JSON({
  "chain": [
    { "type": "module", "module_type": "mod.source.lfo",                 "instance_key": "lfo@0" },
    { "type": "module", "module_type": "source.gradient",                "instance_key": "grad@0" },
    { "type": "module", "module_type": "filter.blur.gaussian",           "instance_key": "blur@0" },
    { "type": "module", "module_type": "color.tone.brightness_contrast", "instance_key": "bc@0" },
    { "type": "module", "module_type": "color.invert",                   "instance_key": "inv@0" }
  ],
  "instances": {
    "lfo@0":  { "module_type": "mod.source.lfo",                 "state": {} },
    "grad@0": { "module_type": "source.gradient",                "state": {} },
    "blur@0": { "module_type": "filter.blur.gaussian",           "state": {} },
    "bc@0":   { "module_type": "color.tone.brightness_contrast", "state": { "brightness": 0.1, "contrast": 0.1 } },
    "inv@0":  { "module_type": "color.invert",                   "state": {} }
  },
  "wires": []
})JSON";

// ---------------------------------------------------------------------------
// Preview request docs (what the editor writes to .../state/preview_requests).
// Sizes mirror the real editor: the main edit preview asks for its displayed
// size in device pixels; card monitors are small; thumbnails are 128x72.
// ---------------------------------------------------------------------------

std::string editPreviewRequests(int w, int h) {
  nlohmann::json j;
  j["edit_preview"] = { {"width", w}, {"height", h},
                        {"target", { {"type", "sketch_output"} }} };
  return j.dump();
}

std::string monitorRequests(int w, int h, int nMonitors) {
  nlohmann::json j;
  j["edit_preview"] = { {"width", w}, {"height", h},
                        {"target", { {"type", "sketch_output"} }} };
  for (int i = 0; i < nMonitors; i++) {
    j["mon_" + std::to_string(i)] = {
      {"width", 256}, {"height", 144},
      {"target", { {"type", "chain_entry"}, {"colIdx", 0},
                   {"chainIdx", i}, {"side", "output"} }} };
  }
  return j.dump();
}

std::string thumbRequests(int n) {
  nlohmann::json j;
  for (int i = 0; i < n; i++) {
    j["inst_thumb:" + std::to_string(i)] = {
      {"width", 128}, {"height", 72},
      {"target", { {"type", "sketch_output"} }} };
  }
  return j.dump();
}

std::string fullRequests(int w, int h, int nMonitors, int nThumbs) {
  auto j = nlohmann::json::parse(monitorRequests(w, h, nMonitors));
  auto t = nlohmann::json::parse(thumbRequests(nThumbs));
  j.update(t);
  return j.dump();
}

// ---------------------------------------------------------------------------
// Fake editor client.
// ---------------------------------------------------------------------------

struct EditorClient {
  ix::WebSocket ws;                                    // main JSON/control socket
  std::vector<std::unique_ptr<ix::WebSocket>> lanes;   // NBPC pixel lanes
  std::atomic<bool> open{false};
  std::atomic<uint64_t> textMsgs{0};
  std::atomic<uint64_t> textBytes{0};
  std::atomic<uint64_t> nbpvFrames{0};   // reassembled whole preview frames
  std::atomic<uint64_t> nbpvBytes{0};    // raw wire bytes across all lanes

  // NBPC reassembly (mirrors resolume-mode.ts): 12-byte chunk header
  // [0..3]"NBPC" [4..7]u32 seq [8..9]u16 idx [10..11]u16 cnt, then payload.
  // The real editor stripes one frame across all lanes, so reassembly state is
  // shared, not per-lane. Guarded by lane_mu since callbacks fire on N threads.
  std::mutex lane_mu;
  struct Partial { uint16_t cnt; uint16_t got; };
  std::unordered_map<uint32_t, Partial> partials;

  void onLaneBinary(const std::string& s) {
    nbpvBytes.fetch_add(s.size(), std::memory_order_relaxed);
    if (s.size() < 12 || s[0] != 'N' || s[1] != 'B' || s[2] != 'P' || s[3] != 'C') {
      // Whole (un-chunked) NBPV frame — count it directly.
      nbpvFrames.fetch_add(1, std::memory_order_relaxed);
      return;
    }
    const uint8_t* b = reinterpret_cast<const uint8_t*>(s.data());
    uint32_t seq = (uint32_t)b[4] | ((uint32_t)b[5] << 8) |
                   ((uint32_t)b[6] << 16) | ((uint32_t)b[7] << 24);
    uint16_t cnt = (uint16_t)b[10] | ((uint16_t)b[11] << 8);
    if (cnt == 0) return;
    std::lock_guard<std::mutex> lk(lane_mu);
    auto& p = partials[seq];
    p.cnt = cnt;
    if (++p.got >= cnt) {
      nbpvFrames.fetch_add(1, std::memory_order_relaxed);
      partials.erase(seq);
    }
    if (partials.size() > 128) partials.clear();  // bound stragglers
  }

  bool connect(int port, const std::string& observePath) {
    ws.setUrl("ws://127.0.0.1:" + std::to_string(port));
    ws.disablePerMessageDeflate();
    ws.setOnMessageCallback([this](const ix::WebSocketMessagePtr& msg) {
      if (msg->type == ix::WebSocketMessageType::Open) {
        open.store(true);
      } else if (msg->type == ix::WebSocketMessageType::Message) {
        if (msg->binary) {
          // Fan-out currently sends pixels only on lanes, but count any stray
          // binary on the main socket as a whole frame for robustness.
          nbpvFrames.fetch_add(1, std::memory_order_relaxed);
          nbpvBytes.fetch_add(msg->str.size(), std::memory_order_relaxed);
        } else {
          textMsgs.fetch_add(1, std::memory_order_relaxed);
          textBytes.fetch_add(msg->str.size(), std::memory_order_relaxed);
        }
      }
    });
    ws.start();
    for (int i = 0; i < 300 && !open.load(); i++)
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    if (!open.load()) return false;
    nlohmann::json obs = { {"action", "observe"}, {"path", observePath} };
    ws.send(obs.dump());
    return true;
  }

  // Connect to every advertised preview-fan-out lane. lanesHaveClients() gates
  // ALL readback, so without this the barrel produces zero preview frames and
  // the preview path is never exercised (nbpv stays 0, CPU flat vs preview size).
  bool connectLanes(const std::vector<int>& ports) {
    for (int p : ports) {
      auto lane = std::make_unique<ix::WebSocket>();
      lane->setUrl("ws://127.0.0.1:" + std::to_string(p));
      lane->disablePerMessageDeflate();
      ix::WebSocket* lp = lane.get();
      std::atomic<bool>* openedFlag = new std::atomic<bool>(false);
      lane->setOnMessageCallback([this, openedFlag](const ix::WebSocketMessagePtr& msg) {
        if (msg->type == ix::WebSocketMessageType::Open) openedFlag->store(true);
        else if (msg->type == ix::WebSocketMessageType::Message && msg->binary)
          onLaneBinary(msg->str);
      });
      lane->start();
      for (int i = 0; i < 300 && !openedFlag->load(); i++)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      bool ok = openedFlag->load();
      delete openedFlag;
      if (!ok) { fprintf(stderr, "lane %d failed to open\n", p); return false; }
      lanes.push_back(std::move(lane));
      (void)lp;
    }
    return !lanes.empty();
  }

  void resetCounters() {
    textMsgs = 0; textBytes = 0; nbpvFrames = 0; nbpvBytes = 0;
    std::lock_guard<std::mutex> lk(lane_mu);
    partials.clear();
  }

  void disconnect() {
    for (auto& lane : lanes) lane->stop();
    lanes.clear();
    ws.stop();
    open.store(false);
    // Give the server's pump a moment to process the disconnect so
    // key_observed / lanesHaveClients flips false before the next baseline.
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
};

// ---------------------------------------------------------------------------

struct Stats {
  double avgMs = 0, p50 = 0, p95 = 0, p99 = 0, maxMs = 0, fps = 0;
};

Stats computeStats(std::vector<double>& ms) {
  Stats s;
  if (ms.empty()) return s;
  double sum = 0;
  for (double v : ms) sum += v;
  s.avgMs = sum / ms.size();
  s.fps = s.avgMs > 0 ? 1000.0 / s.avgMs : 0;
  std::sort(ms.begin(), ms.end());
  auto at = [&](double q) { return ms[std::min(ms.size() - 1, (size_t)(q * ms.size()))]; };
  s.p50 = at(0.50); s.p95 = at(0.95); s.p99 = at(0.99);
  s.maxMs = ms.back();
  return s;
}

}  // namespace

int main(int argc, char** argv) {
  int frames = 600, warmup = 90;
  int W = 1920, H = 1080;
  int port = 19091;
  int previewW = 1280, previewH = 720;
  double paceHz = 0;  // 0 = uncapped; e.g. --pace 120 emulates Resolume's cap
  std::string only;
  for (int i = 1; i < argc; i++) {
    auto next = [&]() -> const char* { return (i + 1 < argc) ? argv[++i] : ""; };
    if (!strcmp(argv[i], "--frames")) frames = atoi(next());
    else if (!strcmp(argv[i], "--w")) W = atoi(next());
    else if (!strcmp(argv[i], "--h")) H = atoi(next());
    else if (!strcmp(argv[i], "--port")) port = atoi(next());
    else if (!strcmp(argv[i], "--preview-w")) previewW = atoi(next());
    else if (!strcmp(argv[i], "--preview-h")) previewH = atoi(next());
    else if (!strcmp(argv[i], "--only")) only = next();
    else if (!strcmp(argv[i], "--pace")) paceHz = atof(next());
    else { fprintf(stderr, "unknown arg: %s\n", argv[i]); return 2; }
  }

  setenv("NANO_BRIDGE_PORT", std::to_string(port).c_str(), 1);

  std::string wasmDir;
  if (const char* d = getenv("NANO_BARREL_WASM_DIR"); d && *d) wasmDir = d;
  else wasmDir = "build/wasm";

  BridgeHandle h = bridge_init();
  if (!h) { fprintf(stderr, "bridge_init failed\n"); return 1; }
  if (!bridge_rt_acquire(h, wasmDir.c_str(), "")) {
    fprintf(stderr, "bridge_rt_acquire failed (wasm dir: %s)\n", wasmDir.c_str());
    return 1;
  }

  id<MTLDevice> device = (__bridge id<MTLDevice>)bridge_rt_metal_device(h);
  if (!device) { fprintf(stderr, "no metal device\n"); return 1; }

  auto makeTex = [&](int w, int hgt) -> id<MTLTexture> {
    MTLTextureDescriptor* d =
        [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                                           width:w height:hgt mipmapped:NO];
    d.usage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite |
              MTLTextureUsageRenderTarget;
    d.storageMode = MTLStorageModeShared;
    return [device newTextureWithDescriptor:d];
  };
  id<MTLTexture> inTex = makeTex(W, H);
  id<MTLTexture> outTex = makeTex(W, H);
  {
    // Gradient input (R=x, G=y) so pass-through chains still move real pixels.
    std::vector<uint8_t> px((size_t)W * H * 4);
    for (int y = 0; y < H; y++)
      for (int x = 0; x < W; x++) {
        size_t i = ((size_t)y * W + x) * 4;
        px[i + 0] = (uint8_t)(x * 255 / (W - 1));
        px[i + 1] = (uint8_t)(y * 255 / (H - 1));
        px[i + 2] = 64; px[i + 3] = 255;
      }
    [inTex replaceRegion:MTLRegionMake2D(0, 0, W, H)
             mipmapLevel:0 withBytes:px.data() bytesPerRow:(NSUInteger)W * 4];
  }

  // Register like the real barrel does — this creates /plugins/<key> in the
  // state doc (set_at alone won't deep-create it) and mints the actual key.
  char keyBuf[128] = {0};
  bridge_register_plugin(h, "nano_barrel", 1, 0, 0, "{}", "bench",
                         keyBuf, (int32_t)sizeof(keyBuf));
  const std::string key = keyBuf[0] ? keyBuf : "bench";
  const std::string base = "/plugins/" + key + "/state";

  // Mirror the plugin: editor patches mark the sketch snapshot dirty.
  std::atomic<bool> dirty{true};
  bridge_register_patch_listener(
      h, key.c_str(),
      [](const char*, void* ud) {
        static_cast<std::atomic<bool>*>(ud)->store(true, std::memory_order_release);
      },
      &dirty);
  bridge_executor_create(h, key.c_str());

  struct Scenario {
    const char* name;
    const char* sketch;      // kStaticSketch / kAnimatedSketch
    bool client;             // editor connected + observing
    std::string previews;    // preview_requests doc ("" → "{}")
  };
  std::vector<Scenario> scenarios = {
    { "baseline/static",      kStaticSketch,   false, "" },
    { "baseline/anim",        kAnimatedSketch, false, "" },
    { "observed/static",      kStaticSketch,   true,  "" },
    { "observed/anim",        kAnimatedSketch, true,  "" },
    { "edit-preview/static",  kStaticSketch,   true,  editPreviewRequests(previewW, previewH) },
    { "edit-preview/anim",    kAnimatedSketch, true,  editPreviewRequests(previewW, previewH) },
    { "monitors3/anim",       kAnimatedSketch, true,  monitorRequests(previewW, previewH, 3) },
    { "thumbs8/anim",         kAnimatedSketch, true,  thumbRequests(8) },
    { "full/anim",            kAnimatedSketch, true,  fullRequests(previewW, previewH, 3, 8) },
  };

  printf("preview_bench: %dx%d, %d frames (+%d warmup), port %d, wasm %s\n",
         W, H, frames, warmup, port, wasmDir.c_str());
  printf("preview: edit %dx%d, NANO_BARREL_PREVIEW_HZ=%s, NANO_WAIT_COMPLETED=%s\n\n",
         previewW, previewH,
         getenv("NANO_BARREL_PREVIEW_HZ") ? getenv("NANO_BARREL_PREVIEW_HZ") : "(30)",
         getenv("NANO_WAIT_COMPLETED") ? getenv("NANO_WAIT_COMPLETED") : "(off)");
  printf("%-22s %8s %8s %8s %8s %8s %8s | %8s %8s %10s\n",
         "scenario", "avg ms", "p50", "p95", "p99", "max", "fps",
         "txtMsg", "nbpvFrm", "nbpvBytes");

  EditorClient client;
  bool clientConnected = false;
  // `elapsed` must advance in REAL time: the preview cadence
  // (previewIntervalSec) rate-limits against it, so simulated time at an
  // uncapped render rate would over-fire the 30 Hz limiter ~10x and melt the
  // readback path in a way production never does.
  const auto wallStart = Clock::now();
  auto wallElapsed = [&]() {
    return std::chrono::duration<double>(Clock::now() - wallStart).count();
  };
  double elapsed = 0.0;
  const double dt = 1.0 / 120.0;

  for (const auto& sc : scenarios) {
    if (!only.empty() && std::string(sc.name).find(only) == std::string::npos)
      continue;

    if (sc.client && !clientConnected) {
      if (!client.connect(port, base)) {
        fprintf(stderr, "editor client failed to connect\n");
        return 1;
      }
      // Connect the preview fan-out lanes too — lanesHaveClients() gates all
      // readback, so without a lane client the barrel produces zero preview
      // frames and the whole readback/pack/send path is never measured.
      std::vector<int> lanePorts;
      if (char* tp = bridge_get_at(h, "/global/preview_transport")) {
        try {
          auto doc = nlohmann::json::parse(tp);
          if (doc.contains("ports"))
            for (const auto& p : doc["ports"]) lanePorts.push_back(p.get<int>());
        } catch (...) {}
        bridge_free_string(tp);
      }
      if (!client.connectLanes(lanePorts)) {
        fprintf(stderr, "editor failed to connect preview lanes (%zu advertised)\n",
                lanePorts.size());
        return 1;
      }
      clientConnected = true;
      // Let the pump register the observation + lane opens before we render.
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
    } else if (!sc.client && clientConnected) {
      client.disconnect();
      clientConnected = false;
    }

    bridge_set_at(h, (base + "/sketch").c_str(), sc.sketch);
    bridge_set_at(h, (base + "/preview_requests").c_str(),
                  sc.previews.empty() ? "{}" : sc.previews.c_str());
    dirty.store(true);

    auto renderOne = [&]() -> int {
      bool d = dirty.exchange(false, std::memory_order_acq_rel);
      elapsed = wallElapsed();
      return bridge_executor_render(h, key.c_str(),
                                    (__bridge void*)inTex, (__bridge void*)outTex,
                                    W, H, dt, elapsed, d ? 1 : 0, nullptr, 0,
                                    /*bar_phase=*/0.0, /*bpm=*/120.0);
    };
    if (getenv("PREVIEW_BENCH_DEBUG")) {
      char* s = bridge_get_at(h, (base + "/sketch").c_str());
      fprintf(stderr, "[debug] sketch doc: %.80s\n", s ? s : "(null)");
      bridge_free_string(s);
      fprintf(stderr, "[debug] first render returned %d (dirty was pending)\n",
              renderOne());
    }

    for (int i = 0; i < warmup; i++) renderOne();
    client.resetCounters();

    std::vector<double> ms;
    ms.reserve(frames);
    auto nextSlot = Clock::now();
    const auto paceStep = paceHz > 0
        ? std::chrono::duration_cast<Clock::duration>(
              std::chrono::duration<double>(1.0 / paceHz))
        : Clock::duration::zero();
    for (int i = 0; i < frames; i++) {
      if (paceHz > 0) {
        nextSlot += paceStep;
        std::this_thread::sleep_until(nextSlot);
      }
      auto t0 = Clock::now();
      renderOne();
      ms.push_back(msSince(t0));
    }
    // Let in-flight readbacks/sends drain so counters reflect the run.
    std::this_thread::sleep_for(std::chrono::milliseconds(300));

    Stats s = computeStats(ms);
    printf("%-22s %8.3f %8.3f %8.3f %8.3f %8.3f %8.1f | %8llu %8llu %10llu\n",
           sc.name, s.avgMs, s.p50, s.p95, s.p99, s.maxMs, s.fps,
           (unsigned long long)client.textMsgs.load(),
           (unsigned long long)client.nbpvFrames.load(),
           (unsigned long long)client.nbpvBytes.load());
    fflush(stdout);
  }

  if (clientConnected) client.disconnect();
  bridge_executor_destroy(h, key.c_str());
  bridge_unregister_patch_listener(h, key.c_str());
  bridge_unregister_plugin(h, key.c_str());
  bridge_rt_release(h);
  bridge_release(h);
  return 0;
}
