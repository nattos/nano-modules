#pragma once

#include <cstdint>
#include <string>
#include <vector>

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
};

} // namespace wasm
