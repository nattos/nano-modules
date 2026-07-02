// comp_api.cpp — the comp_* C ABI the composition executor exports from
// executor.wasm (and exposes to the native barrel). Clones executor_api.cpp's
// conventions: EXEC_EXPORT export_name annotations, (ptr,len) string args into
// linear memory, grow-and-retry readbacks returning the FULL length.
//
// Host flow per frame (mirrors the async-instance seam):
//   comp_update(dt) → flags; on structureChanged: comp_required_json → ensure
//   instances host-side; then comp_render(...). See comp_executor.h.

#include <cstdint>
#include <cstring>
#include <string>

#include <nlohmann/json.hpp>

#include "comp_executor.h"
#ifdef __wasm__
#include "../exec_trace.h"
#endif

#ifdef __wasm__
#define EXEC_EXPORT(nm) __attribute__((export_name(nm)))
#else
#define EXEC_EXPORT(nm)
#endif

using comp::CompExecutor;

namespace {

nlohmann::json parseOr(const char* json, int32_t len, nlohmann::json fallback) {
  auto j = nlohmann::json::parse(std::string(json, static_cast<size_t>(len)), nullptr, false);
  return j.is_discarded() ? std::move(fallback) : j;
}

int32_t writeOut(const std::string& s, char* out, int32_t cap) {
  const int32_t len = static_cast<int32_t>(s.size());
  if (out && cap > 0 && len > 0) {
    const int32_t copy = len < cap ? len : cap;
    std::memcpy(out, s.data(), static_cast<size_t>(copy));
  }
  return len;
}

}  // namespace

extern "C" {

EXEC_EXPORT("comp_create")
CompExecutor* comp_create() {
  // Like executor_create: no backend pointers in the wasm build — the internal
  // SketchExecutor reaches its runtime through the effrt/gpu imports.
  CompExecutor* c = new CompExecutor(nullptr, nullptr, nullptr);
#ifdef __wasm__
  // Route the preview hooks to the "trace" host imports so the composite +
  // per-device trace capture works exactly like a plain executor slot.
  c->sketchExecutor()->setChainEntryHook(
      [](int colIdx, int chainIdx, int32_t in, int32_t out, int w, int h) {
        trace_chain_entry(colIdx, chainIdx, in, out, w, h);
      });
  c->sketchExecutor()->setSketchOutputHook(
      [](int32_t handle, int w, int h) { trace_sketch_output(handle, w, h); });
  c->sketchExecutor()->setBarrierPredicate(
      [](int colIdx, int chainIdx) -> bool { return trace_is_barrier(colIdx, chainIdx) != 0; });
#endif
  return c;
}

EXEC_EXPORT("comp_destroy")
void comp_destroy(CompExecutor* c) { delete c; }

// The internal SketchExecutor — the host reuses executor_debug_stats /
// executor_modulation_json / executor_set_fusion_enabled against it.
EXEC_EXPORT("comp_sketch_executor")
sketch_executor::SketchExecutor* comp_sketch_executor(CompExecutor* c) {
  return c ? c->sketchExecutor() : nullptr;
}

// ── Schemas (forwarded to the internal executor + the role/defaults catalog) ──

EXEC_EXPORT("comp_register_schema")
void comp_register_schema(CompExecutor* c, const char* mt, int32_t mt_len,
                          const char* fields, int32_t fields_len) {
  if (!c) return;
  auto j = nlohmann::json::parse(std::string(fields, static_cast<size_t>(fields_len)),
                                 nullptr, false);
  if (j.is_discarded()) return;
  c->registerSchema(std::string(mt, static_cast<size_t>(mt_len)), j);
}

EXEC_EXPORT("comp_register_capabilities")
void comp_register_capabilities(CompExecutor* c, const char* mt, int32_t mt_len,
                                const char* caps, int32_t caps_len) {
  if (!c) return;
  c->registerCapabilities(std::string(mt, static_cast<size_t>(mt_len)),
                          parseOr(caps, caps_len, nlohmann::json::array()));
}

// ── Document ──

// Full document replace: open/new/undo/redo/any structural edit (edit-rate).
EXEC_EXPORT("comp_load_document")
void comp_load_document(CompExecutor* c, const char* json, int32_t len) {
  if (!c) return;
  auto j = nlohmann::json::parse(std::string(json, static_cast<size_t>(len)), nullptr, false);
  if (j.is_discarded()) return;
  c->loadDocument(j);
}

EXEC_EXPORT("comp_doc_epoch")
int32_t comp_doc_epoch(CompExecutor* c) { return c ? c->docEpoch() : 0; }

// Cheap op (param-drag fast path): merge ONE field's value (JSON-encoded — a
// bare number for floats) into a device's state. Owner = clip or track id.
EXEC_EXPORT("comp_set_device_param")
void comp_set_device_param(CompExecutor* c, const char* ownerId, int32_t owner_len,
                           const char* deviceId, int32_t dev_len, const char* field,
                           int32_t field_len, const char* valueJson, int32_t value_len) {
  if (!c) return;
  auto v = nlohmann::json::parse(std::string(valueJson, static_cast<size_t>(value_len)),
                                 nullptr, false);
  if (v.is_discarded()) return;
  c->setDeviceParam(std::string(ownerId, static_cast<size_t>(owner_len)),
                    std::string(deviceId, static_cast<size_t>(dev_len)),
                    std::string(field, static_cast<size_t>(field_len)), v);
}

EXEC_EXPORT("comp_set_track_level")
void comp_set_track_level(CompExecutor* c, const char* trackId, int32_t len, float level) {
  if (c) c->setTrackLevel(std::string(trackId, static_cast<size_t>(len)), level);
}

// Replace a lane's points ((x,y,bend) f64 triples). Owner = clip or track id.
EXEC_EXPORT("comp_set_lane_points")
void comp_set_lane_points(CompExecutor* c, const char* ownerId, int32_t owner_len,
                          const char* laneId, int32_t lane_len, const double* xyBend,
                          int32_t nPoints) {
  if (!c) return;
  c->setLanePoints(std::string(ownerId, static_cast<size_t>(owner_len)),
                   std::string(laneId, static_cast<size_t>(lane_len)), xyBend, nPoints);
}

EXEC_EXPORT("comp_set_rail_base")
void comp_set_rail_base(CompExecutor* c, const char* railTrackId, int32_t len,
                        const double* xyBend, int32_t nPoints) {
  if (c) c->setRailBase(std::string(railTrackId, static_cast<size_t>(len)), xyBend, nPoints);
}

// ── Transport ──

EXEC_EXPORT("comp_play") void comp_play(CompExecutor* c) { if (c) c->play(); }
EXEC_EXPORT("comp_pause") void comp_pause(CompExecutor* c) { if (c) c->pause(); }

EXEC_EXPORT("comp_seek_beat")
void comp_seek_beat(CompExecutor* c, double beat) { if (c) c->seekBeat(beat); }

EXEC_EXPORT("comp_set_loop")
void comp_set_loop(CompExecutor* c, int32_t enabled, double startBeat, double endBeat) {
  if (c) c->setLoop(enabled != 0, startBeat, endBeat);
}

EXEC_EXPORT("comp_set_transport_mode")
void comp_set_transport_mode(CompExecutor* c, int32_t precise) {
  if (c) c->setTransportMode(precise != 0);
}

EXEC_EXPORT("comp_set_clip_auto_timing")
void comp_set_clip_auto_timing(CompExecutor* c, int32_t loopMode) {
  if (c) c->setClipAutoTiming(loopMode != 0);
}

EXEC_EXPORT("comp_set_ignore_solo")
void comp_set_ignore_solo(CompExecutor* c, int32_t on) { if (c) c->setIgnoreSolo(on != 0); }

EXEC_EXPORT("comp_position_beat")
double comp_position_beat(CompExecutor* c) { return c ? c->positionBeat() : 0; }

EXEC_EXPORT("comp_position_sec")
double comp_position_sec(CompExecutor* c) { return c ? c->positionSec() : 0; }

// Edge-triggered per-clip frame readiness from the host's decode pump.
EXEC_EXPORT("comp_set_video_ready")
void comp_set_video_ready(CompExecutor* c, const char* clipId, int32_t len, int32_t ready) {
  if (c) c->setVideoReady(std::string(clipId, static_cast<size_t>(len)), ready != 0);
}

// ── Per frame (two-phase; see comp_executor.h) ──

EXEC_EXPORT("comp_update")
int32_t comp_update(CompExecutor* c, double dtSec) {
  return c ? static_cast<int32_t>(c->update(dtSec)) : 0;
}

EXEC_EXPORT("comp_render")
int32_t comp_render(CompExecutor* c, int32_t inTex, int32_t outTex, int32_t W, int32_t H,
                    double dt) {
  return c ? c->render(inTex, outTex, W, H, dt) : inTex;
}

// ── Readbacks (grow-and-retry: returns the FULL length) ──

EXEC_EXPORT("comp_required_json")
int32_t comp_required_json(CompExecutor* c, char* out, int32_t cap) {
  return c ? writeOut(c->requiredJson(), out, cap) : 0;
}

EXEC_EXPORT("comp_chain_keys_json")
int32_t comp_chain_keys_json(CompExecutor* c, char* out, int32_t cap) {
  return c ? writeOut(c->chainKeysJson(), out, cap) : 0;
}

EXEC_EXPORT("comp_video_descs_json")
int32_t comp_video_descs_json(CompExecutor* c, char* out, int32_t cap) {
  return c ? writeOut(c->videoDescsJson(), out, cap) : 0;
}

}  // extern "C"
