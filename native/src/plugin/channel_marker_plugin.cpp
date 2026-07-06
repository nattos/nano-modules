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

#include <OpenGL/gl3.h>

#include <dlfcn.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <functional>
#include <random>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include <ffgl/FFGLPluginSDK.h>
#include <ffgl/FFGLPluginInfo.h>
#include <ffglquickstart/FFGLPlugin.h>

#include "plugin/bridge_loader.h"
#include "plugin/nano_barrel/channel_marker_codec.h"
#include "bridge/preview_codec.h"

namespace {
constexpr unsigned int P_CONFIG = 0;   // FF_TYPE_FILE: nanoch://config?<...>
constexpr unsigned int P_CHANNEL = 1;  // FF_TYPE_STANDARD: 1..4 via 0..1
constexpr unsigned int P_NAME = 2;     // FF_TYPE_TEXT: cosmetic channel label
constexpr unsigned int N_PARAMS = 3;
// Normalized slider (0..1) <-> 1-based channel — shared with the server's
// CompositionCache via channel_marker_codec.h so both agree.
using channel_marker::channel_to_norm;
using channel_marker::norm_to_channel;

// ThumbCapturer — grabs the marker's FFGL input texture into a small NBPV
// thumbnail WITHOUT ever stalling Resolume's render thread. A bare glReadPixels
// syncs the GL pipeline; instead we downscale on-GPU (glBlitFramebuffer) and
// read back through an async PBO ring: each capture ISSUES a read into the
// write slot and MAPS a slot whose read was enqueued two frames earlier (its
// fence long since signaled), so the map never waits on the GPU. All GL state
// touched is saved/restored so the passthrough render is undisturbed.
class ThumbCapturer {
 public:
  using Broadcast = std::function<void(const uint8_t* data, size_t len)>;

  // Capture `pInput` (downscaled to w×h) and, once a prior frame's read is
  // ready, ship it as an NBPV frame under (key, traceId) via `broadcast`.
  void capture(const FFGLTextureStruct* pInput, uint32_t hwW, uint32_t hwH,
               const std::string& key, const std::string& traceId,
               int w, int h, const Broadcast& broadcast) {
    w = std::clamp(w, 16, 512);
    h = std::clamp(h, 16, 512);
    if (w != cur_w_ || h != cur_h_) resize(w, h);
    ensure_gl();
    if (!down_fbo_ || !blit_fbo_) return;

    GLint prevRead = 0, prevDraw = 0, prevPack = 0;
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
    glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &prevPack);

    // Autodetect GL_TEXTURE_2D vs GL_TEXTURE_RECTANGLE the way the barrel does:
    // a rectangle texture reports Hardware dims == logical dims.
    GLenum target = GL_TEXTURE_RECTANGLE;
    if (hwW > (uint32_t)pInput->Width || hwH > (uint32_t)pInput->Height)
      target = GL_TEXTURE_2D;

    // Downscale on-GPU into down_fbo_. Flip Y (dst H→0) so the readback rows
    // (GL bottom-up) come out top-down for the web.
    glBindFramebuffer(GL_READ_FRAMEBUFFER, blit_fbo_);
    glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, target,
                           pInput->Handle, 0);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, down_fbo_);
    glBlitFramebuffer(0, 0, (GLint)pInput->Width, (GLint)pInput->Height,
                      0, cur_h_, cur_w_, 0, GL_COLOR_BUFFER_BIT, GL_LINEAR);

    // Issue an ASYNC readback of the downscaled image into the write slot.
    glBindFramebuffer(GL_READ_FRAMEBUFFER, down_fbo_);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, pbo_[write_]);
    glReadPixels(0, 0, cur_w_, cur_h_, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    if (fence_[write_]) glDeleteSync(fence_[write_]);
    fence_[write_] = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    inflight_[write_] = true;
    slot_w_[write_] = cur_w_;
    slot_h_[write_] = cur_h_;
    slot_trace_[write_] = traceId;

    // Map the OLDEST in-flight slot (its read was enqueued kRing-1 frames ago),
    // but only if its fence has signaled — never block.
    const int map = (write_ + 1) % kRing;
    if (inflight_[map] && fence_[map]) {
      GLenum s = glClientWaitSync(fence_[map], 0, 0);
      if (s == GL_ALREADY_SIGNALED || s == GL_CONDITION_SATISFIED) {
        const size_t bytes = (size_t)slot_w_[map] * slot_h_[map] * 4;
        glBindBuffer(GL_PIXEL_PACK_BUFFER, pbo_[map]);
        void* p = glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0, bytes, GL_MAP_READ_BIT);
        if (p) {
          preview_codec::build_nbpv_frame(scratch_, key, slot_trace_[map],
                                          (uint16_t)slot_w_[map],
                                          (uint16_t)slot_h_[map],
                                          (const uint8_t*)p, bytes);
          glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
          broadcast(scratch_.data(), scratch_.size());
        }
        glDeleteSync(fence_[map]);
        fence_[map] = nullptr;
        inflight_[map] = false;
      }
    }

    write_ = (write_ + 1) % kRing;
    glBindBuffer(GL_PIXEL_PACK_BUFFER, (GLuint)prevPack);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
  }

  // Release GL objects (call with the GL context current — DeInitGL).
  void destroy() {
    for (int i = 0; i < kRing; i++) {
      if (fence_[i]) { glDeleteSync(fence_[i]); fence_[i] = nullptr; }
      inflight_[i] = false;
    }
    if (pbo_[0]) glDeleteBuffers(kRing, pbo_.data());
    pbo_.fill(0);
    if (down_tex_) glDeleteTextures(1, &down_tex_), down_tex_ = 0;
    if (down_fbo_) glDeleteFramebuffers(1, &down_fbo_), down_fbo_ = 0;
    if (blit_fbo_) glDeleteFramebuffers(1, &blit_fbo_), blit_fbo_ = 0;
    cur_w_ = cur_h_ = 0;
    write_ = 0;
  }

 private:
  static constexpr int kRing = 3;

  void ensure_gl() {
    if (!blit_fbo_) glGenFramebuffers(1, &blit_fbo_);
    if (!pbo_[0]) glGenBuffers(kRing, pbo_.data());
  }

  void resize(int w, int h) {
    // Drop any in-flight reads sized for the old dims.
    for (int i = 0; i < kRing; i++) {
      if (fence_[i]) { glDeleteSync(fence_[i]); fence_[i] = nullptr; }
      inflight_[i] = false;
    }
    if (down_tex_) glDeleteTextures(1, &down_tex_), down_tex_ = 0;
    if (down_fbo_) glDeleteFramebuffers(1, &down_fbo_), down_fbo_ = 0;
    glGenTextures(1, &down_tex_);
    glBindTexture(GL_TEXTURE_2D, down_tex_);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA,
                 GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glBindTexture(GL_TEXTURE_2D, 0);
    glGenFramebuffers(1, &down_fbo_);
    glBindFramebuffer(GL_FRAMEBUFFER, down_fbo_);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                           down_tex_, 0);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    ensure_gl();
    for (int i = 0; i < kRing; i++) {
      glBindBuffer(GL_PIXEL_PACK_BUFFER, pbo_[i]);
      glBufferData(GL_PIXEL_PACK_BUFFER, (GLsizeiptr)w * h * 4, nullptr,
                   GL_STREAM_READ);
    }
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    cur_w_ = w;
    cur_h_ = h;
    write_ = 0;
  }

  GLuint blit_fbo_ = 0;
  GLuint down_fbo_ = 0;
  GLuint down_tex_ = 0;
  std::array<GLuint, kRing> pbo_{};
  std::array<GLsync, kRing> fence_{};
  std::array<bool, kRing> inflight_{};
  std::array<int, kRing> slot_w_{};
  std::array<int, kRing> slot_h_{};
  std::array<std::string, kRing> slot_trace_{};
  int cur_w_ = 0, cur_h_ = 0;
  int write_ = 0;
  std::vector<uint8_t> scratch_;
};
}  // namespace

class ChannelMarkerPlugin : public CFFGLPlugin {
 public:
  ChannelMarkerPlugin() : CFFGLPlugin(false) {
    SetMinInputs(1);
    SetMaxInputs(1);
    SetFileParamInfo(P_CONFIG, "config", std::vector<std::string>{}, "");
    SetParamInfo(P_CHANNEL, "Channel", FF_TYPE_STANDARD, channel_to_norm(1));
    // Cosmetic label for the channel (numeric Channel stays the matching key).
    SetParamInfo(P_NAME, "Name", FF_TYPE_TEXT, name_.c_str());
  }

  // -- Config persistence (durable across host restarts) ----------------
  FFResult SetTextParameter(unsigned int idx, const char* value) override {
    const char* v = value ? value : "";
    if (idx == P_NAME) {
      if (name_ != v) {
        name_ = v;
        regenerate_config();
      }
      return FF_SUCCESS;
    }
    if (idx != P_CONFIG) return FF_SUCCESS;
    config_blob_ = std::string(v);
    // Restore uuid + channel + name from the persisted blob (cold start: the
    // host restores this before InitGL).
    const std::string u = channel_marker::uuid_of(config_blob_);
    if (!u.empty()) instance_uuid_ = u;
    const int ch = channel_marker::channel_of(config_blob_);
    if (ch >= 1) channel_ = ch;
    const std::string nm = channel_marker::name_of(config_blob_);
    if (!nm.empty()) name_ = nm;
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
    if (idx == P_NAME) {
      if (name_return_buf_.size() <= name_.size())
        name_return_buf_.resize(name_.size() + 1);
      if (!name_.empty())
        std::memcpy(name_return_buf_.data(), name_.data(), name_.size());
      name_return_buf_[name_.size()] = '\0';
      return name_return_buf_.data();
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

  FFResult ProcessOpenGL(ProcessOpenGLStruct* pGL) override {
    if (bridge_ && loader_.bridge_tick) loader_.bridge_tick(bridge_);
    maybe_capture_thumbnail(pGL);
    // Pure marker: bypass rendering so the clip's image is untouched.
    return FF_FAIL;
  }

  FFResult DeInitGL() override {
    capturer_.destroy();  // GL context is current here
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
  // Capture this clip's video as a thumbnail — but only on-demand: gated on a
  // web client observing this marker (key_observed) AND a preview request being
  // present, and rate-limited to ~30 Hz. The capture itself is non-blocking
  // (async PBO ring in ThumbCapturer).
  void maybe_capture_thumbnail(ProcessOpenGLStruct* pGL) {
    if (!bridge_ || key_.empty() || !pGL) return;
    if (pGL->numInputTextures < 1 || !pGL->inputTextures || !pGL->inputTextures[0])
      return;
    if (!loader_.bridge_key_observed ||
        !loader_.bridge_key_observed(bridge_, key_.c_str()))
      return;
    const auto now = std::chrono::steady_clock::now();
    if (now - last_capture_ < std::chrono::milliseconds(33)) return;

    int req_w = 0, req_h = 0;
    std::string trace_id;
    if (!read_preview_request(&trace_id, &req_w, &req_h)) return;
    last_capture_ = now;

    const FFGLTextureStruct* in = pGL->inputTextures[0];
    capturer_.capture(in, in->HardwareWidth, in->HardwareHeight, key_, trace_id,
                      req_w, req_h,
                      [this](const uint8_t* data, size_t len) {
                        if (loader_.bridge_broadcast_binary)
                          loader_.bridge_broadcast_binary(bridge_, data,
                                                          (uint32_t)len);
                      });
  }

  // Read this marker's preview request from the shared doc (the web writes it
  // when the Instances-tab card mounts, and clears it — {} — on unmount). Picks
  // the entry keyed by our own `inst_thumb:<key>` id, else any entry. false if
  // nothing is requested. Only the small per-instance subtree is fetched.
  bool read_preview_request(std::string* trace_id, int* w, int* h) {
    if (!loader_.bridge_get_at) return false;
    const std::string path = "/plugins/" + key_ + "/state/preview_requests";
    char* raw = loader_.bridge_get_at(bridge_, path.c_str());
    if (!raw) return false;
    std::string js(raw);
    if (loader_.bridge_free_string) loader_.bridge_free_string(raw);
    auto j = nlohmann::json::parse(js, nullptr, /*allow_exceptions=*/false);
    if (!j.is_object() || j.empty()) return false;
    const std::string mine = "inst_thumb:" + key_;
    const nlohmann::json* entry = nullptr;
    if (j.contains(mine) && j[mine].is_object()) {
      entry = &j[mine];
      *trace_id = mine;
    } else {
      for (auto it = j.begin(); it != j.end(); ++it) {
        if (it.value().is_object()) { entry = &it.value(); *trace_id = it.key(); break; }
      }
    }
    if (!entry) return false;
    // width/height may be present-but-zero (a thumbnail monitor registered
    // without an explicit size) — fall back to the low-res default.
    *w = entry->value("width", 0);
    *h = entry->value("height", 0);
    if (*w <= 0) *w = 128;
    if (*h <= 0) *h = 72;
    return true;
  }

  void regenerate_config() {
    if (!instance_uuid_.empty())
      config_blob_ = channel_marker::wrap_config(instance_uuid_, channel_, name_);
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
  std::string name_;
  int channel_ = 1;
  std::vector<char> config_return_buf_;
  std::vector<char> name_return_buf_;
  char small_return_buf_[1] = {0};
  ThumbCapturer capturer_;
  std::chrono::steady_clock::time_point last_capture_{};
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
