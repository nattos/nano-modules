#pragma once

#include <cstdint>

namespace canvas {
struct DrawList;
}

namespace wasm {

class WasmHost;

/// Per-frame state provided by the plugin to the WASM module.
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

/// Audio trigger callback — called from WASM host function, forwarded to plugin's synth.
using AudioTriggerCallback = void (*)(int channel, void* userdata);

/// Context passed as user_data on the WAMR execution environment.
/// Provides access to the WasmHost, DrawList, and per-frame state.
struct WasmContext {
  WasmHost* host = nullptr;
  canvas::DrawList* draw_list = nullptr;
  FrameState* frame_state = nullptr;
  AudioTriggerCallback audio_callback = nullptr;
  void* audio_userdata = nullptr;
};

} // namespace wasm
