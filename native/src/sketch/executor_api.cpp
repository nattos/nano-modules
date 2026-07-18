// executor_api.cpp — the C ABI executor.wasm exports for its host (the native
// barrel / the web engine worker). The host instantiates one executor, pushes
// each effect's schema once, then drives a frame per tick. Sketch + schema JSON
// cross as (ptr,len) into the module's linear memory (host writes via malloc).
//
// The executor drives effects + GPU through the effrt/gpu host IMPORTS — the
// host wires those to its EffectRuntime + GPUBackend (native) or WasmHost +
// GPUHost (web). So executor_create takes no backend: the runtime lives in the
// host, reached through the imports.

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "sketch/sketch_executor.h"
#include "sketch/sidechannel_bus.h"
#include "sketch/trigger_bus.h"
#include "sketch/exec_trace.h"

#ifdef __wasm__
#define EXEC_EXPORT(nm) __attribute__((export_name(nm)))
#else
#define EXEC_EXPORT(nm)
#endif

using sketch_executor::SketchExecutor;

extern "C" {

EXEC_EXPORT("executor_create")
SketchExecutor* executor_create() {
  // No native backend pointers — the wasm executor reaches its runtime through
  // the effrt/gpu imports; the #ifndef __wasm__ runtime-bind/seed in execute()
  // is compiled out.
  SketchExecutor* ex = new SketchExecutor(nullptr, nullptr, nullptr);
#ifdef __wasm__
  // Route the editor-preview hooks to the "trace" host imports (natively the
  // barrel sets these std::functions directly on its in-process executor).
  ex->setChainEntryHook([](int colIdx, int chainIdx, int32_t in, int32_t out,
                           int w, int h) {
    trace_chain_entry(colIdx, chainIdx, in, out, w, h);
  });
  ex->setSketchOutputHook([](int32_t handle, int w, int h) {
    trace_sketch_output(handle, w, h);
  });
  ex->setBarrierPredicate([](int colIdx, int chainIdx) -> bool {
    return trace_is_barrier(colIdx, chainIdx) != 0;
  });
#endif
  return ex;
}

EXEC_EXPORT("executor_destroy")
void executor_destroy(SketchExecutor* ex) { delete ex; }

// Force-disable GPU fusion (every stage takes the standalone path). Mirrors the
// web debug "fusion mode" toggle: force-off → 0, auto/force-on → 1. The native
// barrel doesn't drive this; it exists so the web host's setFusionMode keeps
// working once executor.wasm is the sole web executor.
EXEC_EXPORT("executor_set_fusion_enabled")
void executor_set_fusion_enabled(SketchExecutor* ex, int32_t enabled) {
  if (ex) ex->setFusionEnabled(enabled != 0);
}

// Push (or replace) one module's schema. `schema` is the `fields` sub-object
// JSON. Must be called for every effect the sketch references before execute().
EXEC_EXPORT("executor_register_schema")
void executor_register_schema(SketchExecutor* ex, const char* mt, int32_t mt_len,
                              const char* schema, int32_t schema_len) {
  if (!ex) return;
  auto fields = nlohmann::json::parse(std::string(schema, schema_len), nullptr, false);
  if (fields.is_discarded()) return;
  ex->registerModuleSchema(std::string(mt, mt_len), fields);
}

// Push (or replace) one module's declarative `capabilities` tags. `caps` is the
// JSON string array from the schema's top-level `capabilities`. Call after
// executor_register_schema for the same module type; the executor gates
// modulation auto-connect on these (modulation_source / modulation_shaper).
EXEC_EXPORT("executor_register_capabilities")
void executor_register_capabilities(SketchExecutor* ex, const char* mt, int32_t mt_len,
                                    const char* caps, int32_t caps_len) {
  if (!ex) return;
  auto parsed = nlohmann::json::parse(std::string(caps, caps_len), nullptr, false);
  std::vector<std::string> tags;
  if (parsed.is_array())
    for (const auto& c : parsed)
      if (c.is_string()) tags.push_back(c.get<std::string>());
  ex->registerModuleCapabilities(std::string(mt, mt_len), std::move(tags));
}

// Push this frame's parameter AUTOMATION (the host evaluated its curves at the
// playhead). `json` is an array of {instance, field, value, combine, magnitude}.
// The executor folds each into its field via the same tap_mod range-map + combine
// the wires use, without touching the sketch JSON. Call before executor_execute;
// replaces the previous frame's set (empty array / "[]" clears).
EXEC_EXPORT("executor_set_automation")
void executor_set_automation(SketchExecutor* ex, const char* json, int32_t len) {
  if (!ex) return;
  auto j = nlohmann::json::parse(std::string(json, len), nullptr, false);
  ex->setAutomation(j.is_discarded() ? nlohmann::json::array() : j);
}

// Push external scalar sources (MIDI device controls) for the next execute():
// `{"midi:<uuid>": {"b0/e05/turn": 0.42, ...}, ...}`, values normalized 0..1.
// Wires from such out-of-chain sources fold through the normal read-tap
// pipeline (see SketchExecutor::setExternalScalars). Replaces the previous
// set; "{}" clears.
EXEC_EXPORT("executor_set_external_scalars")
void executor_set_external_scalars(SketchExecutor* ex, const char* json, int32_t len) {
  if (!ex) return;
  auto j = nlohmann::json::parse(std::string(json, len), nullptr, false);
  ex->setExternalScalars(j.is_discarded() ? nlohmann::json::object() : j);
}

// Push the absolute transport time (seconds) for the NEXT execute() — drives
// deterministic effect seeks (backward jump + clip activation). Optional: a host that
// never calls it leaves the executor at 0 (no jump seeks). See SketchExecutor::setFrameTime.
EXEC_EXPORT("executor_set_time")
void executor_set_time(SketchExecutor* ex, double sec) {
  if (ex) ex->setFrameTime(sec);
}

// Render one frame. `sketch` is the {chain|columns, instances, wires} JSON.
// Returns the output texture handle (or `inTex` for a passthrough). `dirty`
// signals the sketch changed since last frame (rebuild the plan).
// `sketch_len == 0` is the clean-frame fast path: the host already sent this
// sketch on a previous (dirty) frame, so skip the parse entirely and run from
// the executor's cached exec doc — the host must only do this after at least
// one successful non-empty call, and with dirty == 0.
EXEC_EXPORT("executor_execute")
int32_t executor_execute(SketchExecutor* ex, const char* sketch, int32_t sketch_len,
                         int32_t inTex, int32_t outTex, int32_t W, int32_t H,
                         double dt, int32_t dirty) {
  if (!ex) return inTex;
  if (sketch_len == 0) {
    return ex->executeCached(inTex, outTex, W, H, dt);
  }
  auto j = nlohmann::json::parse(std::string(sketch, sketch_len), nullptr, false);
  if (j.is_discarded()) return inTex;
  return ex->execute(j, inTex, outTex, W, H, dt, dirty != 0);
}

// Tag this executor's sidechannel-bus WRITES with an identity string (the web
// host's sketch id; the barrel sets its plugin key natively). Informational —
// see SketchExecutor::setBusTag.
EXEC_EXPORT("executor_set_bus_tag")
void executor_set_bus_tag(SketchExecutor* ex, const char* tag, int32_t len) {
  if (ex && tag) ex->setBusTag(std::string(tag, len));
}

// Sidechannel-bus METADATA version — module-level (the bus is process-global,
// shared by every executor in this module). Bumps only when channel identity
// metadata changes (new channel / writer / size), NOT per write, so a host can
// poll it per frame and fetch executor_sidechannels_json only on change.
// f64 because wasm32 JS hosts can't read i64 returns.
EXEC_EXPORT("executor_sidechannels_version")
double executor_sidechannels_version() {
  return (double)sidechannel_bus::version();
}

// Serialize the sidechannel-bus channel metadata as JSON into `out`
// (host-allocated, capacity `cap`): {"<channel>": {"writer", "w", "h"}}.
// Returns the FULL byte length; if it exceeds `cap` the host grows and retries.
EXEC_EXPORT("executor_sidechannels_json")
int32_t executor_sidechannels_json(char* out, int32_t cap) {
  return sidechannel_bus::infoJson(out, cap);
}

// Serialize the SCALAR sidechannel-bus channel metadata as JSON into `out`
// (host-allocated, capacity `cap`): {"<channel>": {"writer"}}. Scalar channels
// are their own namespace but share the version above, so a host fetches this
// alongside executor_sidechannels_json on a version change. Returns the FULL
// byte length; the host grows and retries if it exceeds `cap`.
EXEC_EXPORT("executor_scalar_sidechannels_json")
int32_t executor_scalar_sidechannels_json(char* out, int32_t cap) {
  return sidechannel_bus::scalarInfoJson(out, cap);
}

// The bus-owned texture handle currently carrying `channel` (last-written
// content, no reader/freshness semantics — see sidechannel_bus::peek), or -1.
// For the host's thumbnail trace capture; handles resolve in the same shared
// GPUHost table the worker's trace capture reads from.
EXEC_EXPORT("executor_sidechannel_texture")
int32_t executor_sidechannel_texture(const char* name, int32_t len) {
  if (!name || len <= 0) return -1;
  const std::string ch(name, (size_t)len);
  return sidechannel_bus::peek(ch.c_str()).tex;
}

// Trigger-bus METADATA version — module-level (the bus is process-global,
// shared by every executor in this module). Bumps only when a rail/channel/
// writer first appears, NOT per event, so a host can poll it per frame and
// fetch executor_triggers_json only on change. f64 for wasm32 JS hosts.
EXEC_EXPORT("executor_triggers_version")
double executor_triggers_version() {
  return (double)trigger_bus::version();
}

// Serialize the trigger-bus rail/channel activity as JSON into `out`
// (host-allocated, capacity `cap`): {"<rail>": {"<channel>": {"on","velocity",
// "writer","seq"}}}. Returns the FULL byte length; the host grows + retries if
// it exceeds `cap`. Feeds the editor's Instances-tab Trigger Rails cards.
EXEC_EXPORT("executor_triggers_json")
int32_t executor_triggers_json(char* out, int32_t cap) {
  return trigger_bus::infoJson(out, cap);
}

// Write the LAST execute()'s 7 debug counters into `out` (host-allocated, ≥7
// int32s): [effectsExecuted, standaloneDispatches, fusedRuns, fusedStages,
// dispatchesSaved, gpuDispatches, identitySkipped]. The web host reads these
// into its per-frame DebugStats accumulator for the editor's Debug Info panel.
EXEC_EXPORT("executor_debug_stats")
void executor_debug_stats(SketchExecutor* ex, int32_t* out) {
  if (!ex || !out) return;
  ex->fillDebugStats(out);
}

// Serialize the LAST execute()'s modulation telemetry (per-instance modulated
// scalar inputs → { value, min, max }; see lastModulationData()) as JSON into
// `out` (host-allocated, capacity `cap`). Returns the FULL byte length; if it
// exceeds `cap` the host grows the buffer and retries. The web engine worker
// diffs this and ships it as `modulationDataDiff` so sliders can draw the
// effective value + swing band over the user's base value. `{}` when nothing
// is modulated.
EXEC_EXPORT("executor_modulation_json")
int32_t executor_modulation_json(SketchExecutor* ex, char* out, int32_t cap) {
  if (!ex) return 0;
  static std::string buf;  // kept alive until the host copies it out (same frame)
  buf = ex->lastModulationData().dump();
  const int32_t n = (int32_t)buf.size();
  if (out && cap > 0) {
    const int32_t c = n < cap ? n : cap;
    std::memcpy(out, buf.data(), (size_t)c);
  }
  return n;
}

}  // extern "C"
