#pragma once

#include "bridge/bridge_api.h"
#include "plugin/bridge_loader.h"

#include <ffgl/FFGLPluginSDK.h>

class RepatchPlugin : public CFFGLPlugin {
public:
  RepatchPlugin();

  FFResult InitGL(const FFGLViewportStruct* vp) override;
  FFResult ProcessOpenGL(ProcessOpenGLStruct* pGL) override;
  FFResult DeInitGL() override;

private:
  plugin::BridgeLoader loader_;
  BridgeHandle bridge_ = nullptr;
};
