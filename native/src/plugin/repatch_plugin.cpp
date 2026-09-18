#include "plugin/repatch_plugin.h"

#include <string>

#include "platform/paths.h"

#include <ffgl/FFGLPluginInfo.h>
#include <ffglquickstart/FFGLPlugin.h>

// FFGL plugin registration
static CFFGLPluginInfo PluginInfo(
    PluginFactory<RepatchPlugin>,
    "NRPT",                            // Unique 4-char ID
    "NanoRepatch",                      // Plugin name (16 chars max)
    2, 1,                               // FFGL API version
    1, 0,                               // Plugin version
    FF_EFFECT,                          // Plugin type
    "NanoRepatch bridge plugin",        // Description
    "nano"                            // Author
);

RepatchPlugin::RepatchPlugin() {
  SetMinInputs(1);
  SetMaxInputs(1);
}

FFResult RepatchPlugin::InitGL(const FFGLViewportStruct* vp) {
  // Find the bridge dylib relative to our own bundle location, e.g.
  //   /path/to/NanoRepatch.bundle/Contents/MacOS/NanoRepatch
  //     -> /path/to/libbridge_server.dylib
  std::string dylib_path;
  const std::string self =
      nano_paths::imagePathContaining(reinterpret_cast<void*>(&PluginInfo));
  if (!self.empty()) {
    auto pos = self.rfind(".bundle");
    if (pos != std::string::npos)
      dylib_path = nano_paths::joinPath(
          nano_paths::parentDir(self.substr(0, pos)), "libbridge_server.dylib");
  }

  if (dylib_path.empty() || !loader_.load(dylib_path.c_str())) {
    return FF_FAIL;
  }

  bridge_ = loader_.bridge_init();
  return bridge_ ? FF_SUCCESS : FF_FAIL;
}

FFResult RepatchPlugin::ProcessOpenGL(ProcessOpenGLStruct* pGL) {
  if (bridge_) {
    loader_.bridge_tick(bridge_);
  }
  // Passthrough — return FF_FAIL to bypass rendering (like channel_tag_plugin)
  // In the future this could render an overlay
  return FF_FAIL;
}

FFResult RepatchPlugin::DeInitGL() {
  if (bridge_ && loader_.is_loaded()) {
    loader_.bridge_release(bridge_);
    bridge_ = nullptr;
  }
  loader_.unload();
  return FF_SUCCESS;
}
