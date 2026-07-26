#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

#include "wasm/effect_host_sink.h"

namespace canvas {
struct DrawList;
}

namespace comp {
struct StreamsTable;
class WarpClock;
}

namespace bridge {
class StateDocument;
}

namespace gpu {
class GPUBackend;
}

namespace wasm {

class WasmHost;

struct FrameState {
  double elapsed_time = 0;
  double delta_time = 0;
  double bar_phase = 0;
  double bpm = 120;
  int viewport_w = 0;
  int viewport_h = 0;
  /**
   * Output height (px) this frame's viewport REPRESENTS — the composition
   * resolution, when the engine is rendering a scaled-down proxy of it (the
   * arrangement preview caps its edge; an export runs at full size). 0 = "the
   * viewport IS the output", which is the plain case (barrel, tests, an
   * uncapped engine) and yields a unit scale.
   *
   * Effects with PIXEL-denominated params divide by this (host::pxScale) so an
   * authored value is a fixed fraction of the frame at any render size, i.e. the
   * preview and the export agree. See host.h.
   */
  int reference_h = 0;

  static constexpr int MAX_PARAMS = 16;
  double ffgl_params[MAX_PARAMS] = {};
};

using AudioTriggerCallback = void (*)(int channel, void* userdata);

// An effect captured from a bundle's nano_module_main via the name-keyed
// `module.register_effect_*` builder imports. `fns` maps each provided
// lifecycle callback's NAME (e.g. "module_init","create","tick","render",
// "on_state_patched","is_identity","on_active","seek") to its WASM indirect-
// function-table index (invoke via WasmHost::call_indirect). A name absent
// from the map means the effect doesn't provide that hook. Adding a new hook
// needs no change here — it's just another name in the map.
struct WasmEffectDesc {
  std::string id;
  std::string name;
  std::string description;
  std::string category;
  std::string keywords;
  std::unordered_map<std::string, uint32_t> fns;
  // Host<->effect ABI version of the bundle this effect came from (copied from
  // WasmContext::abi_version at register time). 0 = legacy bundle that exports
  // no nano_abi_version(). See NANO_ABI_VERSION in module_api.h.
  int32_t abi_version = 0;

  // Convenience: the table index for a named callback, or 0 ("not provided").
  uint32_t fn(const char* name) const {
    auto it = fns.find(name);
    return it != fns.end() ? it->second : 0u;
  }
};

struct WasmContext {
  WasmHost* host = nullptr;
  // Host<->effect ABI version this bundle was built against (read from the
  // bundle's nano_abi_version() export before nano_module_main runs). 0 when
  // the export is absent (legacy bundle). register_effect_begin copies it onto
  // each WasmEffectDesc as a coarse compatibility signal. With name-keyed
  // registration it no longer gates descriptor layout (absent names are simply
  // "not provided"); a bump is only needed for a changed import/callback
  // signature. See NANO_ABI_VERSION in module_api.h.
  int32_t abi_version = 0;
  canvas::DrawList* draw_list = nullptr;
  FrameState* frame_state = nullptr;
  AudioTriggerCallback audio_callback = nullptr;
  void* audio_userdata = nullptr;

  // Seekable-streams registry (streams.* imports). Null outside comp mode —
  // the imports then answer as the session-clock-only world (frame_state).
  // The table's frame sample is mutated in place by the comp executor; the
  // clock is its warp-aware beat→seconds map (lazy content positions).
  // NON-const: the write verbs (streams.seek/stop) queue into the table's
  // pendingOps — single-threaded on the render path, drained by the executor.
  comp::StreamsTable* streams_table = nullptr;
  const comp::WarpClock* streams_clock = nullptr;

  // State system
  bridge::StateDocument* state_doc = nullptr;
  std::string plugin_key;

  // Resolume param subscriptions (path queries, supports * wildcard)
  std::vector<std::string> subscribe_queries;

  // GPU backend
  gpu::GPUBackend* gpu_backend = nullptr;

  // Effects this module's nano_module_main registered (name-keyed capture).
  // One bundle may register many effects; the runtime drives each by index.
  std::vector<WasmEffectDesc> registered_effects;

  // In-progress effect registrations. module.register_effect_begin allocates a
  // builder (returns its handle); register_effect_str/_fn fill it by name;
  // register_effect_end moves it into registered_effects.
  int32_t next_effect_builder = 1;
  std::unordered_map<int32_t, WasmEffectDesc> effect_builders;

  // The effect (chain entry) currently being driven. The WASM driver sets this
  // before each lifecycle call_indirect — the WASM analogue of
  // EffectRuntime::setActive — so executor-facing host imports (schema, texture
  // wiring, will_render, ...) route to the right instance. One bundle's module
  // instance is shared across its chain entries, so this rotates per call. The
  // abstract EffectHostSink keeps wasm decoupled from the runtime (no cycle);
  // effect_runtime::EffectInstance implements it.
  EffectHostSink* effect_instance = nullptr;

  // Input textures (injected by sketch executor for chaining)
  std::vector<int32_t> input_texture_handles;

  // Named texture fields (populated by sketch executor from schema)
  std::unordered_map<std::string, int32_t> texture_fields;

  // Pending patches for the current on_state_patched call
  std::vector<nlohmann::json> pending_patches;

  // Val handle system — maps handle IDs to JSON values owned by the host
  int32_t next_val_handle = 1;
  std::unordered_map<int32_t, nlohmann::json> val_handles;

  int32_t alloc_val(const nlohmann::json& v) {
    int32_t h = next_val_handle++;
    val_handles[h] = v;
    return h;
  }
  nlohmann::json* get_val(int32_t h) {
    auto it = val_handles.find(h);
    return it != val_handles.end() ? &it->second : nullptr;
  }
  void release_val(int32_t h) { val_handles.erase(h); }

  // set/push CONSUME the value handle: once the value has been copied into the
  // container's subtree, the standalone child handle is freed. Without this,
  // every intermediate val::number/object/array/... built into a published tree
  // LEAKS — the effect only releases the root (see val.h: "release(root) frees
  // the tree") — so `val_handles` grows by dozens-to-hundreds of entries every
  // frame for a busy publisher (e.g. control.nanolooper's per-tick publish_state
  // builds grid/notes/live_notes/triggers). That unbounded growth eventually
  // exhausts the host heap → a trap that poisons the WAMR runtime → the whole
  // executor stops rendering (even unrelated effects). Returns false (nothing
  // consumed) if the handles are missing or the container is mistyped.
  bool set_val_member(int32_t obj_h, const std::string& key, int32_t value_h) {
    auto* obj = get_val(obj_h);
    auto* val = get_val(value_h);
    if (!obj || !obj->is_object() || !val) return false;
    (*obj)[key] = *val;
    if (value_h != obj_h) release_val(value_h);
    return true;
  }
  bool push_val_member(int32_t arr_h, int32_t value_h) {
    auto* arr = get_val(arr_h);
    auto* val = get_val(value_h);
    if (!arr || !arr->is_array() || !val) return false;
    arr->push_back(*val);
    if (value_h != arr_h) release_val(value_h);
    return true;
  }

  size_t val_handle_count() const { return val_handles.size(); }
};

} // namespace wasm
