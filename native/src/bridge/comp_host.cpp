// comp_host.cpp — see comp_host.h.

#include "bridge/comp_host.h"

#include <cmath>
#include <set>

#include "bridge/comp_media_resolver.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

namespace effect_runtime {
// Setters defined in host_impls.cpp.
void setHostTime(double t);
void setHostDeltaTime(double dt);
void setHostBarPhase(double p);
void setHostBpm(double bpm);
void setHostViewport(int w, int h);
void setHostReferenceHeight(int h);
}  // namespace effect_runtime

namespace bridge {

using json = nlohmann::json;

CompHost::CompHost(gpu::GPUBackend* gpu, effect_runtime::EffectRuntime* rt,
                   sketch_executor::ModuleRegistry* registry,
                   sketch_executor::WasmEffectBundles* bundles, const Config& cfg)
    : gpu_(gpu), rt_(rt), registry_(registry), bundles_(bundles), cfg_(cfg) {
  cx_ = std::make_unique<comp::CompExecutor>(rt_, registry_, gpu_);
  cx_->setKeyNamespace(cfg_.keyNamespace);
  lights_ = std::make_unique<LightRunner>(gpu_);
  displays_ = std::make_unique<DisplayRunner>(gpu_);
  seedSchemas();

  // Bind the seekable-streams registry into every loaded bundle (and every one
  // loaded later). Without this the effect-facing `streams` module reads an
  // absent table, which is SILENT: a transport controller sees parent position
  // 0 forever and publishes a frozen `transport_time_sec` while its
  // analytically-differenced `rate` still looks perfectly correct.
  if (bundles_) bundles_->setStreamsTable(&cx_->streamsTableMutable(), &cx_->warpClock());

  // Media resolution. A document authored the way a SAVED one looks carries
  // `clip.source.ref` and no runtime `url`, so without the resolver every video
  // clip parses as effect-only. Must precede loadDocument: the flag is decided
  // at parse time. (The roots themselves are the caller's: LibraryPaths.)
  nano_assets::installLibraryMediaResolver();

  // Fluid by default: a held transport with nothing feeding the gate would
  // freeze the beat. The pump below IS a feed, but a host opts into Precise.
  cx_->setTransportMode(false);

  ensureTextures();
}

CompHost::~CompHost() {
  // Light readbacks in flight sample textures this host owns: let them land.
  if (gpu_) gpu_->drainPreviewReadbacks();
  lights_.reset();
  displays_.reset();
  // The pump's clips hold textures and inject into the executor: it goes first.
  pump_.reset();
  if (bundles_) bundles_->setStreamsTable(nullptr, nullptr);
  cx_.reset();
  if (gpu_) {
    if (inTex_ > 0) gpu_->release(inTex_);
    if (outTex_ > 0) gpu_->release(outTex_);
  }
}

void CompHost::seedSchemas() {
  // Every referenced module type must be known before the first update() or it
  // degrades to a stand-in — the native analogue of the web worker's
  // comp_register_schema per discovered plugin.
  if (!registry_) return;
  for (const auto& [moduleType, fields] : registry_->schemas()) {
    cx_->registerSchema(moduleType, fields);
    const auto* reg = registry_->find(moduleType);
    json caps = json::array();
    if (reg) {
      for (const auto& t : reg->capabilities) caps.push_back(t);
    }
    cx_->registerCapabilities(moduleType, caps);
  }
}

void CompHost::loadDocument(const json& doc) {
  cx_->loadDocument(doc);
  referenceH_ = 0;
  if (doc.contains("meta") && doc["meta"].is_object()) {
    const auto& meta = doc["meta"];
    if (meta.contains("resolution") && meta["resolution"].is_object()) {
      const double h = meta["resolution"].value("height", 0.0);
      if (h > 0) referenceH_ = (int)std::lround(h);
    }
  }
}

void CompHost::resize(int width, int height) {
  if (width <= 0 || height <= 0) return;
  if (width == cfg_.width && height == cfg_.height) return;
  cfg_.width = width;
  cfg_.height = height;
  ensureTextures();
}

void CompHost::ensureTextures() {
  if (!gpu_) return;
  if (texW_ == cfg_.width && texH_ == cfg_.height && outTex_ > 0) return;
  if (inTex_ > 0) gpu_->release(inTex_);
  if (outTex_ > 0) gpu_->release(outTex_);
  inTex_ = gpu_->createTexture((uint32_t)cfg_.width, (uint32_t)cfg_.height, /*RGBA8*/ 1);
  outTex_ = gpu_->createTexture((uint32_t)cfg_.width, (uint32_t)cfg_.height, /*RGBA8*/ 1);
  texW_ = cfg_.width;
  texH_ = cfg_.height;
  gpu_->setSurface(outTex_, (uint32_t)cfg_.width, (uint32_t)cfg_.height);

  // The pump presents at the render size, so a new size is a new pump. It
  // re-learns the active set immediately rather than waiting for the next
  // set-change flag, which may never come.
  const bool hadPump = pump_ != nullptr;
  nano_media::VideoPump::Config pc;
  pc.renderW = cfg_.width;
  pc.renderH = cfg_.height;
  pc.readAheadDepth = cfg_.readAheadDepth;
  pc.async = cfg_.asyncDecode;
  pump_ = std::make_unique<nano_media::VideoPump>(gpu_, pc);
  pump_->setMediaBase(mediaBase_);
  comp::CompExecutor* cx = cx_.get();
  pump_->setInjectSink([cx](const std::string& instanceKey, int32_t tex) {
    if (auto* ex = cx->sketchExecutor()) ex->setInjectedTexture(instanceKey, tex);
  });
  pump_->setReadySink([cx](const std::string& clipId, bool ready) {
    cx->setVideoReady(clipId, ready);
  });
  // The rows of the LAST transportResolve: the pump runs first each frame, so
  // it reads the previous frame's times — the same one-frame lag as web, whose
  // pump reads the last report's transportTimes.
  pump_->setTransportResolver([cx](const std::string& clipId) {
    nano_media::VideoPump::TransportTime t;
    const auto order = cx->transportOrder();
    const auto& rows = cx->transportResolved();
    for (size_t i = 0; i < order.size() && i < rows.size(); ++i) {
      if (order[i] != clipId) continue;
      const auto& r = rows[i];
      t.valid = r.valid && std::isfinite(r.timeSec);
      t.active = r.active >= 0.5;
      t.timeSec = r.timeSec;
      break;
    }
    return t;
  });
  // The Precise gate assumes nobody is waiting on decodes unless told a pump
  // exists — without this it never holds.
  cx_->setVideoReadyFeed();
  if (hadPump) pump_->setActiveClips(json::parse(cx_->videoDescsJson(), nullptr, false));
}

size_t CompHost::pruneInstances(
    const std::vector<std::pair<std::string, std::string>>& required) {
  if (!rt_) return 0;
  std::set<std::string> keep;
  for (const auto& [type, key] : required) keep.insert(type + "|" + key);
  const std::string& ns = cfg_.keyNamespace;
  const size_t n = rt_->destroyInstancesIf([&](const std::string& type, const std::string& key) {
    if (key.compare(0, ns.size(), ns) != 0) return false;   // not this comp's
    std::string bare = key.substr(ns.size());
    // A 16-bit working format mints its own instances ("f16!" + key); they're
    // the same chain entry as far as the required set goes.
    if (bare.compare(0, 4, "f16!") == 0) bare = bare.substr(4);
    return keep.count(type + "|" + bare) == 0;
  });
  if (n > 0) cx_->forceStateReassert();
  return n;
}

void CompHost::publishClock(double dt) {
  effect_runtime::setHostTime(hostTime_);
  effect_runtime::setHostDeltaTime(dt);
  effect_runtime::setHostViewport(cfg_.width, cfg_.height);
  effect_runtime::setHostBpm(cx_->bpm());
  // Comp mode owns the musical clock: the bar phase comes from the REAL
  // transport beat (4 beats/bar; exact even under warp) — the web host does the
  // same per instance frame state.
  const double beat = cx_->positionBeat();
  const double barPhase = std::fmod(std::fmod(beat / 4.0, 1.0) + 1.0, 1.0);
  effect_runtime::setHostBarPhase(barPhase);
  effect_runtime::setHostReferenceHeight(referenceH_);
  if (bundles_) {
    bundles_->setHostClock(hostTime_, dt, barPhase, cx_->bpm(), cfg_.width, cfg_.height,
                           referenceH_);
    // The bundles are shared, so is their streams binding: a second host (an
    // export beside the live comp) renders in the same process. Whoever renders
    // this frame binds its own table.
    bundles_->setStreamsTable(&cx_->streamsTableMutable(), &cx_->warpClock());
  }
  // Likewise the backend's surface (what effects read as the viewport target).
  if (gpu_) gpu_->setSurface(outTex_, (uint32_t)cfg_.width, (uint32_t)cfg_.height);
}

int32_t CompHost::renderFrame(double execDt) {
  cx_->transportResolve(execDt);
  const int32_t handle = cx_->render(inTex_, outTex_, cfg_.width, cfg_.height, execDt);
  lastOut_ = handle;
  if (lastFlags_ & comp::kCompStructureChanged) chainKeys_ = cx_->chainKeysJson();
  frames_++;
  // A Precise hold is the transport refusing to advance because a clip's media
  // isn't decoded yet — the stall metric the perf suite gates on.
  if (lastFlags_ & comp::kCompHoldingPrecise) stalledFrames_++;
  return handle;
}

int32_t CompHost::step(double dt) {
  if (lastFlags_ & comp::kCompVideoSetChanged) {
    pump_->setActiveClips(json::parse(cx_->videoDescsJson(), nullptr, false));
  }
  pump_->pump(cx_->positionBeat(), cx_->bpm());
  // The effect clock follows the TRANSPORT, not the wall clock — the web
  // host's contract (executor-host.ts compFrame): effects step by how far the
  // playhead moved since the last frame (paused → 0, a static frame; a scrub →
  // a signed jump, so effects seek), and the host time is where the playhead
  // was plus this frame's dt. `prevSec_` persists across frames on purpose: a
  // seek lands BETWEEN frames, and reading it fresh would absorb the jump.
  const double prevSec = havePrevSec_ ? prevSec_ : cx_->positionSec();
  hostTime_ = prevSec + dt;
  lastFlags_ = cx_->update(dt);
  const double nowSec = cx_->positionSec();
  prevSec_ = nowSec;
  havePrevSec_ = true;
  publishClock(dt);
  return renderFrame(nowSec - prevSec);
}

void CompHost::primeExport(double beat) {
  cx_->seekBeat(beat);
  lastFlags_ = cx_->update(0.0);
}

int32_t CompHost::stepExport(double beat, double tSec, double fps, bool warm) {
  if (lastFlags_ & comp::kCompVideoSetChanged) {
    pump_->setActiveClips(json::parse(cx_->videoDescsJson(), nullptr, false));
  }
  pump_->pump(beat, cx_->bpm());
  cx_->seekBeat(beat);
  hostTime_ = tSec;
  const double dt = warm ? 0.0 : 1.0 / fps;
  lastFlags_ = cx_->update(0.0);
  publishClock(dt);
  cx_->transportResolve(0.0);
  const int32_t handle = cx_->render(inTex_, outTex_, cfg_.width, cfg_.height, dt);
  if (lastFlags_ & comp::kCompStructureChanged) chainKeys_ = cx_->chainKeysJson();
  frames_++;
  prevSec_ = cx_->positionSec();
  havePrevSec_ = true;
  return handle;
}

}  // namespace bridge
