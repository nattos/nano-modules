#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

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

struct WasmContext {
  WasmHost* host = nullptr;
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

  // Input textures (injected by sketch executor for chaining)
  std::vector<int32_t> input_texture_handles;

  // Named texture fields (populated by sketch executor from schema)
  std::unordered_map<std::string, int32_t> texture_fields;

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
