// channel_marker_plugin.cpp — "NanoLooper Ch" (NLCH): a minimal FFGL effect
// dropped on a Resolume clip to mark it as a launchable SCENE on a trigger
// channel.
//
// It is the scene-track analogue for Resolume: place it on the clips you want
// launchable, pick a Channel, and the shared server launches those clips when a
// sketch (a looper or a Trigger Send node) fires that channel on the trigger
// rail (see trigger_bus / clip_launcher).
//
// The marker does two things:
//   1. Registers with the shared libbridge_server.dylib (like NanoBarrel), so it
//      is a first-class instance the editor can enumerate.
//   2. Persists {uuid, channel} inline in a `nanoch://config?<base64>` FILE
//      param. The server's CompositionCache decodes the channel from that blob
//      to resolve channel → clips (channel_marker_codec.h). A distinct scheme
//      from the barrel's `nanobarrel://` keeps the InstanceLocator from ever
//      mistaking a marker for a barrel.
//
// The video passes through untouched — this is a pure marker, not an effect.

#include <dlfcn.h>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#include <ffgl/FFGLPluginSDK.h>
#include <ffgl/FFGLPluginInfo.h>
#include <ffglquickstart/FFGLPlugin.h>

#include "plugin/bridge_loader.h"
#include "plugin/nano_barrel/channel_marker_codec.h"

namespace {
constexpr unsigned int P_CONFIG = 0;   // FF_TYPE_FILE: nanoch://config?<...>
constexpr unsigned int P_CHANNEL = 1;  // FF_TYPE_STANDARD: 1..4 via 0..1
constexpr unsigned int N_PARAMS = 2;
// Normalized slider (0..1) <-> 1-based channel — shared with the server's
// CompositionCache via channel_marker_codec.h so both agree.
using channel_marker::channel_to_norm;
using channel_marker::norm_to_channel;
}  // namespace

class ChannelMarkerPlugin : public CFFGLPlugin {
 public:
  ChannelMarkerPlugin() : CFFGLPlugin(false) {
    SetMinInputs(1);
    SetMaxInputs(1);
    SetFileParamInfo(P_CONFIG, "config", std::vector<std::string>{}, "");
    SetParamInfo(P_CHANNEL, "Channel", FF_TYPE_STANDARD, channel_to_norm(1));
  }

  // -- Config persistence (durable across host restarts) ----------------
  FFResult SetTextParameter(unsigned int idx, const char* value) override {
    if (idx != P_CONFIG) return FF_SUCCESS;
    const char* v = value ? value : "";
    config_blob_ = std::string(v);
    // Restore uuid + channel from the persisted blob (cold start: the host
    // restores this before InitGL).
    const std::string u = channel_marker::uuid_of(config_blob_);
    if (!u.empty()) instance_uuid_ = u;
    const int ch = channel_marker::channel_of(config_blob_);
    if (ch >= 1) channel_ = ch;
    return FF_SUCCESS;
  }

  char* GetTextParameter(unsigned int idx) override {
    if (idx == P_CONFIG) {
      if (config_return_buf_.size() <= config_blob_.size())
        config_return_buf_.resize(config_blob_.size() + 1);
      if (!config_blob_.empty())
        std::memcpy(config_return_buf_.data(), config_blob_.data(), config_blob_.size());
      config_return_buf_[config_blob_.size()] = '\0';
      return config_return_buf_.data();
    }
    small_return_buf_[0] = '\0';
    return small_return_buf_;
  }

  FFResult SetFloatParameter(unsigned int idx, float value) override {
    if (idx == P_CHANNEL) {
      const int ch = norm_to_channel(value);
      if (ch != channel_) {
        channel_ = ch;
        regenerate_config();
      }
    }
    return FF_SUCCESS;
  }

  float GetFloatParameter(unsigned int idx) override {
    if (idx == P_CHANNEL) return channel_to_norm(channel_);
    return 0.0f;
  }

  // -- Lifecycle --------------------------------------------------------
  FFResult InitGL(const FFGLViewportStruct* /*vp*/) override {
    std::string dylib_path;
    Dl_info info;
    if (dladdr(reinterpret_cast<void*>(&ChannelMarkerPlugin::init_marker), &info) &&
        info.dli_fname) {
      dylib_path = info.dli_fname;
      auto pos = dylib_path.rfind(".bundle");
      if (pos != std::string::npos) {
        dylib_path = dylib_path.substr(0, pos);
        auto slash = dylib_path.rfind('/');
        if (slash != std::string::npos) dylib_path = dylib_path.substr(0, slash + 1);
        dylib_path += "libbridge_server.dylib";
      }
    }
    if (dylib_path.empty() || !loader_.load(dylib_path.c_str())) return FF_FAIL;
    bridge_ = loader_.bridge_init();
    if (!bridge_) return FF_FAIL;

    if (instance_uuid_.empty()) instance_uuid_ = generate_uuid();
    regenerate_config();  // ensure the FILE param carries {uuid, channel}

    if (loader_.bridge_register_plugin) {
      char keybuf[128] = {0};
      loader_.bridge_register_plugin(bridge_, "com.nano.nanolooper.ch", 0, 1, 0,
                                     /*schema_json=*/"", instance_uuid_.c_str(),
                                     keybuf, (int32_t)sizeof(keybuf));
      key_ = keybuf;
    }
    return FF_SUCCESS;
  }

  FFResult ProcessOpenGL(ProcessOpenGLStruct* /*pGL*/) override {
    if (bridge_ && loader_.bridge_tick) loader_.bridge_tick(bridge_);
    // Pure marker: bypass rendering so the clip's image is untouched.
    return FF_FAIL;
  }

  FFResult DeInitGL() override {
    if (bridge_ && loader_.is_loaded()) {
      if (loader_.bridge_unregister_plugin && !key_.empty())
        loader_.bridge_unregister_plugin(bridge_, key_.c_str());
      if (loader_.bridge_release) loader_.bridge_release(bridge_);
      bridge_ = nullptr;
    }
    loader_.unload();
    return FF_SUCCESS;
  }

  // Anchor symbol for dladdr (resolves this bundle's path).
  static void init_marker() {}

 private:
  void regenerate_config() {
    if (!instance_uuid_.empty())
      config_blob_ = channel_marker::wrap_config(instance_uuid_, channel_);
  }

  static std::string generate_uuid() {
    static std::mt19937_64 rng{std::random_device{}()};
    std::uniform_int_distribution<uint64_t> d;
    uint64_t hi = d(rng), lo = d(rng);
    char buf[40];
    std::snprintf(buf, sizeof(buf),
                  "%08X-%04X-4%03X-%04X-%012llX",
                  (unsigned)(hi >> 32), (unsigned)((hi >> 16) & 0xFFFF),
                  (unsigned)(hi & 0xFFF),
                  (unsigned)(0x8000 | (lo >> 48 & 0x3FFF)),
                  (unsigned long long)(lo & 0xFFFFFFFFFFFFULL));
    return buf;
  }

  plugin::BridgeLoader loader_;
  BridgeHandle bridge_ = nullptr;
  std::string instance_uuid_;
  std::string key_;
  std::string config_blob_;
  int channel_ = 1;
  std::vector<char> config_return_buf_;
  char small_return_buf_[1] = {0};
};

static CFFGLPluginInfo PluginInfo(
    PluginFactory<ChannelMarkerPlugin>,
    "NLCH",                                  // Unique 4-char ID
    "NanoLooper Ch",                          // Plugin name
    2, 1,                                     // FFGL API version
    1, 0,                                     // Plugin version
    FF_EFFECT,                                // Plugin type
    "Marks a clip as a launchable scene on a trigger channel",
    "nano");
