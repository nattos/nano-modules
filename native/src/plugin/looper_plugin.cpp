#include "plugin/looper_plugin.h"
#include "canvas/canvas_renderer.h"
#include "canvas/draw_list.h"

#include <dlfcn.h>
#include <cmath>
#include <string>

#ifdef __APPLE__
#include <OpenGL/gl3.h>
#endif

#include <ffgl/FFGLPluginInfo.h>
#include <ffglquickstart/FFGLPlugin.h>

// FFGL plugin registration
static CFFGLPluginInfo PluginInfo(
    PluginFactory<LooperPlugin>,
    "NLPR",                                // Same 4-char code as original
    "NanoLooper",                           // Plugin name
    2, 1,                                   // FFGL API version
    1, 0,                                   // Plugin version
    FF_EFFECT,                              // Plugin type
    "NanoLooper (WASM) step sequencer",     // Description
    "nattos"                                // Author
);

LooperPlugin::LooperPlugin() : CFFGLPlugin(false) {
  SetMinInputs(1);
  SetMaxInputs(1);

  SetParamInfo(PID_TRIGGER_1,    "Trigger 1",    FF_TYPE_BOOLEAN,  0.0f);
  SetParamInfo(PID_TRIGGER_2,    "Trigger 2",    FF_TYPE_BOOLEAN,  0.0f);
  SetParamInfo(PID_TRIGGER_3,    "Trigger 3",    FF_TYPE_BOOLEAN,  0.0f);
  SetParamInfo(PID_TRIGGER_4,    "Trigger 4",    FF_TYPE_BOOLEAN,  0.0f);
  SetParamInfo(PID_DELETE,       "Delete",       FF_TYPE_BOOLEAN,  0.0f);
  SetParamInfo(PID_MUTE,         "Mute",         FF_TYPE_BOOLEAN,  0.0f);
  SetParamInfo(PID_UNDO,         "Undo",         FF_TYPE_BOOLEAN,  0.0f);
  SetParamInfo(PID_REDO,         "Redo",         FF_TYPE_BOOLEAN,  0.0f);
  SetParamInfo(PID_RECORD,       "Record",       FF_TYPE_BOOLEAN,  0.0f);
  SetParamInfo(PID_SHOW_OVERLAY, "Show Overlay", FF_TYPE_BOOLEAN,  1.0f);
  SetParamInfo(PID_SYNTH,        "Synth",        FF_TYPE_BOOLEAN,  0.0f);
  SetParamInfo(PID_SYNTH_GAIN,   "Synth Gain",   FF_TYPE_STANDARD, 0.5f);

  param_values_[PID_SHOW_OVERLAY] = 1.0f;
  param_values_[PID_SYNTH_GAIN] = 0.5f;
}

LooperPlugin::~LooperPlugin() = default;

void LooperPlugin::audio_trigger_callback(int channel, void* userdata) {
  auto* self = static_cast<LooperPlugin*>(userdata);
  if (self && self->synth_.is_enabled()) {
    self->synth_.trigger(channel);
  }
}

FFResult LooperPlugin::InitGL(const FFGLViewportStruct* vp) {
  // Find and load the bridge dylib
  Dl_info info;
  std::string dylib_path;
  if (dladdr(reinterpret_cast<void*>(&PluginInfo), &info) && info.dli_fname) {
    dylib_path = info.dli_fname;
    auto pos = dylib_path.rfind(".bundle");
    if (pos != std::string::npos) {
      dylib_path = dylib_path.substr(0, pos);
      auto slash = dylib_path.rfind('/');
      if (slash != std::string::npos)
        dylib_path = dylib_path.substr(0, slash + 1);
      dylib_path += "libbridge_server.dylib";
    }
  }

  if (dylib_path.empty() || !loader_.load(dylib_path.c_str()))
    return FF_FAIL;

  bridge_ = loader_.bridge_init();
  if (!bridge_) return FF_FAIL;

  // TODO: Load WASM bytecode for the NanoLooper module
  // For now, wasm_module_ remains -1 (no WASM loaded)
  // When the WASM module is built (Phase E), this will load nanolooper.wasm
  // from a known path or embedded bytes.

  // Set up audio callback
  if (loader_.bridge_set_audio_callback && wasm_module_ >= 0) {
    loader_.bridge_set_audio_callback(bridge_, wasm_module_,
        audio_trigger_callback, this);
  }

  // Initialize renderer and synth
  renderer_ = new canvas::CanvasRenderer();
  renderer_->init();
  synth_.init();

  last_tick_ = std::chrono::steady_clock::now();
  elapsed_time_ = 0;
  first_frame_ = true;

  return FF_SUCCESS;
}

FFResult LooperPlugin::ProcessOpenGL(ProcessOpenGLStruct* pGL) {
  if (!bridge_ || !renderer_) return FF_FAIL;

  // Compute timing
  auto now = std::chrono::steady_clock::now();
  double dt = first_frame_ ? 0.0 :
      std::chrono::duration<double>(now - last_tick_).count();
  last_tick_ = now;
  first_frame_ = false;
  elapsed_time_ += dt;

  int vp_w = pGL->inputTextures[0]->Width;
  int vp_h = pGL->inputTextures[0]->Height;

  // Set frame state for the WASM module
  if (loader_.bridge_set_frame_state && wasm_module_ >= 0) {
    loader_.bridge_set_frame_state(bridge_, wasm_module_,
        elapsed_time_, dt, barPhase, bpm, vp_w, vp_h);
  }

  // Poll Resolume WS messages
  loader_.bridge_tick(bridge_);

  // Call WASM tick
  if (loader_.bridge_call_tick && wasm_module_ >= 0) {
    loader_.bridge_call_tick(bridge_, wasm_module_, dt);
  }

  // Draw passthrough of input texture
  renderer_->drawPassthrough(
      pGL->inputTextures[0]->Handle,
      0, 0, vp_w, vp_h);

  // Call WASM render and execute the draw list
  if (loader_.bridge_render && wasm_module_ >= 0) {
    auto* draw_list = static_cast<canvas::DrawList*>(
        loader_.bridge_render(bridge_, wasm_module_, vp_w, vp_h));
    if (draw_list && !draw_list->empty()) {
      renderer_->execute(*draw_list, vp_w, vp_h);
    }
  }

  return FF_SUCCESS;
}

FFResult LooperPlugin::SetFloatParameter(unsigned int index, float value) {
  if (index >= PID_COUNT) return FF_FAIL;

  float prev = param_values_[index];
  param_values_[index] = value;

  // Synth controls (handled host-side, not in WASM)
  if (index == PID_SYNTH) {
    synth_.set_enabled(value >= 0.5f);
  } else if (index == PID_SYNTH_GAIN) {
    synth_.set_gain(value);
  }

  // Forward all param changes to WASM
  if (loader_.bridge_set_ffgl_param && wasm_module_ >= 0) {
    loader_.bridge_set_ffgl_param(bridge_, wasm_module_, index, value);
  }
  if (loader_.bridge_call_on_param && wasm_module_ >= 0) {
    loader_.bridge_call_on_param(bridge_, wasm_module_, index, value);
  }

  return FF_SUCCESS;
}

float LooperPlugin::GetFloatParameter(unsigned int index) {
  if (index >= PID_COUNT) return 0.0f;
  return param_values_[index];
}

FFResult LooperPlugin::DeInitGL() {
  if (bridge_ && loader_.is_loaded()) {
    if (wasm_module_ >= 0) {
      loader_.bridge_unload_wasm(bridge_, wasm_module_);
      wasm_module_ = -1;
    }
    loader_.bridge_release(bridge_);
    bridge_ = nullptr;
  }
  loader_.unload();

  synth_.deinit();

  if (renderer_) {
    renderer_->deinit();
    delete renderer_;
    renderer_ = nullptr;
  }

  return FF_SUCCESS;
}
