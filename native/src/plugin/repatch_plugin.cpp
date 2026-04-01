#include "plugin/repatch_plugin.h"

#include <dlfcn.h>
#include <string>

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
    "nattos"                            // Author
);

RepatchPlugin::RepatchPlugin() {
  SetMinInputs(1);
  SetMaxInputs(1);
}

FFResult RepatchPlugin::InitGL(const FFGLViewportStruct* vp) {
  // Find the bridge dylib relative to our own bundle location
  Dl_info info;
  std::string dylib_path;
  if (dladdr(reinterpret_cast<void*>(&PluginInfo), &info) && info.dli_fname) {
    dylib_path = info.dli_fname;
    // Navigate from plugin bundle to dylib location
    // e.g., /path/to/NanoRepatch.bundle/Contents/MacOS/NanoRepatch
    //     -> /path/to/libbridge_server.dylib
    auto pos = dylib_path.rfind(".bundle");
    if (pos != std::string::npos) {
      dylib_path = dylib_path.substr(0, pos);
      auto slash = dylib_path.rfind('/');
      if (slash != std::string::npos) {
        dylib_path = dylib_path.substr(0, slash + 1);
      }
      dylib_path += "libbridge_server.dylib";
    }
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
