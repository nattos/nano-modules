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
};

} // namespace wasm
