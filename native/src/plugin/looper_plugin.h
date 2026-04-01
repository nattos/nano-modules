#pragma once

#include <chrono>
#include <cstdint>

#include <ffgl/FFGLPluginSDK.h>

#include "plugin/bridge_loader.h"
#include "plugin/synth.h"

namespace canvas {
class CanvasRenderer;
}

enum LooperParamID : FFUInt32 {
  PID_TRIGGER_1 = 0,
  PID_TRIGGER_2,
  PID_TRIGGER_3,
  PID_TRIGGER_4,
  PID_DELETE,
  PID_MUTE,
  PID_UNDO,
  PID_REDO,
  PID_RECORD,
  PID_SHOW_OVERLAY,
  PID_SYNTH,
  PID_SYNTH_GAIN,
  PID_COUNT,
};

class LooperPlugin : public CFFGLPlugin {
public:
  LooperPlugin();
  ~LooperPlugin() override;

  FFResult InitGL(const FFGLViewportStruct* vp) override;
  FFResult DeInitGL() override;
  FFResult ProcessOpenGL(ProcessOpenGLStruct* pGL) override;
  FFResult SetFloatParameter(unsigned int index, float value) override;
  float GetFloatParameter(unsigned int index) override;

private:
  static void audio_trigger_callback(int channel, void* userdata);

  plugin::BridgeLoader loader_;
  BridgeHandle bridge_ = nullptr;
  int32_t wasm_module_ = -1;

  canvas::CanvasRenderer* renderer_ = nullptr;
  Synth synth_;

  float param_values_[PID_COUNT] = {};
  std::chrono::steady_clock::time_point last_tick_;
  double elapsed_time_ = 0;
  bool first_frame_ = true;
};
