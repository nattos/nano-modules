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

// A captured nano::EffectDesc_v2 from a bundle's nano_module_main →
// `module.register_effect`. The function fields are WASM indirect-function-
// table indices (invoke via WasmHost::call_indirect); 0 means "not provided".
// The host reads the descriptor struct out of the module's linear memory at
// registration time and stashes the resolved strings + indices here, so the
// effect runtime can drive the lifecycle without re-touching wasm memory.
struct WasmEffectDesc {
  int32_t struct_version = 0;
  std::string id;
  std::string name;
  std::string description;
  std::string category;
  std::string keywords;
  uint32_t idx_module_init = 0;
  uint32_t idx_create = 0;
  uint32_t idx_destroy = 0;
  uint32_t idx_init = 0;
  uint32_t idx_tick = 0;
  uint32_t idx_render = 0;
  uint32_t idx_on_state_patched = 0;
  uint32_t idx_is_identity = 0;
  uint32_t idx_on_active = 0;
  uint32_t idx_seek = 0;   // optional seek(self, from, to); 0 = not provided
  // Host<->effect ABI version of the bundle this effect came from (copied from
  // WasmContext::abi_version at register time). 0 = legacy bundle that exports
  // no nano_abi_version(). See NANO_ABI_VERSION in module_api.h.
  int32_t abi_version = 0;
};

struct WasmContext {
  WasmHost* host = nullptr;
  // Host<->effect ABI version this bundle was built against (read from the
  // bundle's nano_abi_version() export before nano_module_main runs). 0 when
  // the export is absent (legacy bundle). register_effect copies it onto each
  // WasmEffectDesc and gates trailing descriptor fields (e.g. seek) on it.
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

  // Effects this module's nano_module_main registered (EffectDesc_v2 capture).
  // One bundle may register many effects; the runtime drives each by index.
  std::vector<WasmEffectDesc> registered_effects;

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
