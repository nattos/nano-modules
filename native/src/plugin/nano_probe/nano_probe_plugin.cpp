// nano_probe_plugin.cpp — NanoProbe FFGL plugin.
//
// A probe, not a product. Drops into Resolume and writes a single-line
// log of every FFGL callback + every probe action we take, so we can
// answer empirically:
//
//   * Does Resolume honor SetParamInfo calls issued AFTER construction?
//   * Does Resolume persist plugin-owned text/file parameter values
//     across composition save+load?
//   * What's the host's cadence for GetTextParameter polling, and does
//     RaiseParamEvent(FF_EVENT_FLAG_VALUE) accelerate it?
//   * Does mutating an FF_TYPE_OPTION's element list with raiseEvent=true
//     update the host UI live?
//
// The plugin renders a passthrough with a magenta corner badge so it's
// visually identifiable in a live composition. No WASM, no bridge, no
// effect runtime.

#include <array>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include <OpenGL/gl3.h>

#include <ffgl/FFGLPluginSDK.h>
#include <ffgl/FFGLPluginInfo.h>
#include <ffgl/FFGLLib.h>

#include "probe_log.h"

namespace {

// -- Parameter indices --------------------------------------------------
// Static (registered in ctor, present at host's prototype scan):
constexpr unsigned int P_CONFIG   = 0;   // FF_TYPE_TEXT
constexpr unsigned int P_WASMFILE = 1;   // FF_TYPE_FILE
constexpr unsigned int P_PHASE    = 2;   // FF_TYPE_STANDARD
constexpr unsigned int P_EFFECTS  = 3;   // FF_TYPE_OPTION
constexpr unsigned int P_NOTES    = 4;   // FF_TYPE_TEXT
// Dynamic (registered later via SetParamInfo, mid-life — the part we
// want to find out if Resolume even acknowledges):
constexpr unsigned int P_DYN_F    = 5;   // FF_TYPE_STANDARD, dyn
constexpr unsigned int P_DYN_T    = 6;   // FF_TYPE_TEXT, dyn

// -- Probe phases -------------------------------------------------------
enum ProbePhase {
  PH_QUIESCENT_LOW = 0,   // phase < 0.2
  PH_DYN_REGISTER  = 1,   // 0.2 .. 0.4
  PH_CONFIG_MUTATE = 2,   // 0.4 .. 0.6
  PH_ELEMENTS_MUT  = 3,   // 0.6 .. 0.8
  PH_QUIESCENT_HI  = 4,   // > 0.8
};

const char* phase_name(ProbePhase p) {
  switch (p) {
    case PH_QUIESCENT_LOW: return "QUIESCENT_LOW";
    case PH_DYN_REGISTER:  return "DYN_REGISTER";
    case PH_CONFIG_MUTATE: return "CONFIG_MUTATE";
    case PH_ELEMENTS_MUT:  return "ELEMENTS_MUT";
    case PH_QUIESCENT_HI:  return "QUIESCENT_HI";
  }
  return "?";
}

ProbePhase phase_from_float(float v) {
  if (v < 0.2f) return PH_QUIESCENT_LOW;
  if (v < 0.4f) return PH_DYN_REGISTER;
  if (v < 0.6f) return PH_CONFIG_MUTATE;
  if (v < 0.8f) return PH_ELEMENTS_MUT;
  return PH_QUIESCENT_HI;
}

}  // namespace

// ============================================================================
class NanoProbePlugin : public CFFGLPlugin {
 public:
  NanoProbePlugin() : CFFGLPlugin() {
    PROBE_LOG("ctor", "this=%p", (void*)this);

    SetMinInputs(1);
    SetMaxInputs(1);
    SetTimeSupported(true);

    // -- Initial parameter set, registered before the ctor returns so
    //    Resolume sees them during the prototype scan as well as in any
    //    real instance. Default values are what the host will use if
    //    nothing was persisted from a prior save.
    config_   = "{}";
    wasmFile_ = "";
    phaseVal_ = 0.0f;
    effects_  = 0.0f;
    notes_    = "probe-notes";
    dynF_     = 0.5f;
    dynT_     = "dyn-text-default";
    dynRegistered_ = false;

    SetParamInfo(P_CONFIG,   "config",   FF_TYPE_TEXT, config_.c_str());
    PROBE_LOG("SetParamInfo", "idx=%u name=config type=TEXT default=%s",
              P_CONFIG, nano_probe_log::redact(config_.c_str()).c_str());

    {
      std::vector<std::string> exts = {"wasm", "json"};
      SetFileParamInfo(P_WASMFILE, "wasmFile", exts, wasmFile_.c_str());
      PROBE_LOG("SetFileParamInfo",
                "idx=%u name=wasmFile exts=wasm,json default=%s",
                P_WASMFILE,
                nano_probe_log::redact(wasmFile_.c_str()).c_str());
    }

    SetParamInfo(P_PHASE, "phase", FF_TYPE_STANDARD, phaseVal_);
    PROBE_LOG("SetParamInfo", "idx=%u name=phase type=STANDARD default=%.3f",
              P_PHASE, (double)phaseVal_);

    // FF_TYPE_OPTION: register the param then attach 3 initial elements.
    SetOptionParamInfo(P_EFFECTS, "effects", /*numElements=*/3, 0.0f);
    SetParamElementInfo(P_EFFECTS, 0, "soft_glow",   0.0f);
    SetParamElementInfo(P_EFFECTS, 1, "motion_blur", 0.5f);
    SetParamElementInfo(P_EFFECTS, 2, "passthrough", 1.0f);
    PROBE_LOG("SetOptionParamInfo",
              "idx=%u name=effects nElements=3 [soft_glow,motion_blur,passthrough]",
              P_EFFECTS);

    SetParamInfo(P_NOTES, "notes", FF_TYPE_TEXT, notes_.c_str());
    PROBE_LOG("SetParamInfo", "idx=%u name=notes type=TEXT default=%s",
              P_NOTES, nano_probe_log::redact(notes_.c_str()).c_str());

    PROBE_LOG("ctor-done", "static_params=5 dyn_pending=2");
  }

  ~NanoProbePlugin() override {
    PROBE_LOG("dtor", "this=%p", (void*)this);
  }

  // -- Lifecycle ---------------------------------------------------------
  FFResult InitGL(const FFGLViewportStruct* vp) override {
    PROBE_LOG("InitGL", "viewport=%ux%u", vp->width, vp->height);
    CFFGLPlugin::InitGL(vp);
    glGenFramebuffers(1, &srcFbo_);
    return FF_SUCCESS;
  }

  FFResult DeInitGL() override {
    PROBE_LOG("DeInitGL", "frame=%d", frame_);
    if (srcFbo_) { glDeleteFramebuffers(1, &srcFbo_); srcFbo_ = 0; }
    return FF_SUCCESS;
  }

  unsigned int Resize(const FFGLViewportStruct* vp) override {
    PROBE_LOG("Resize", "viewport=%ux%u", vp->width, vp->height);
    return CFFGLPlugin::Resize(vp);
  }

  unsigned int Connect() override {
    PROBE_LOG("Connect", "");
    return CFFGLPlugin::Connect();
  }

  unsigned int Disconnect() override {
    PROBE_LOG("Disconnect", "");
    return CFFGLPlugin::Disconnect();
  }

  void SetHostInfo(const char* hostname, const char* version) override {
    PROBE_LOG("SetHostInfo", "host='%s' version='%s'",
              hostname ? hostname : "", version ? version : "");
    CFFGLPlugin::SetHostInfo(hostname, version);
  }

  FFResult SetTime(double t) override {
    // High-frequency callback. Log only first arrival + on every 5 s.
    static double lastLogged = -1e9;
    if (t - lastLogged > 5.0) {
      PROBE_LOG("SetTime", "t=%.3f", t);
      lastLogged = t;
    }
    return CFFGLPlugin::SetTime(t);
  }

  // -- Parameter callbacks (host → plugin) ------------------------------
  FFResult SetFloatParameter(unsigned int idx, float value) override {
    PROBE_LOG("SetFloatParameter", "idx=%u value=%.6f", idx, (double)value);
    switch (idx) {
      case P_PHASE:   phaseVal_ = value; PROBE_CTX_PHASE(value); break;
      case P_EFFECTS: effects_  = value; break;
      case P_DYN_F:   dynF_     = value; break;
      default: break;
    }
    return FF_SUCCESS;
  }

  FFResult SetTextParameter(unsigned int idx, const char* value) override {
    const char* v = value ? value : "";
    PROBE_LOG("SetTextParameter", "idx=%u value=%s",
              idx, nano_probe_log::redact(v).c_str());
    switch (idx) {
      case P_CONFIG:   config_   = v; break;
      case P_WASMFILE: wasmFile_ = v; break;
      case P_NOTES:    notes_    = v; break;
      case P_DYN_T:    dynT_     = v; break;
      default: break;
    }
    return FF_SUCCESS;
  }

  float GetFloatParameter(unsigned int idx) override {
    float v = 0.0f;
    switch (idx) {
      case P_PHASE:   v = phaseVal_; break;
      case P_EFFECTS: v = effects_;  break;
      case P_DYN_F:   v = dynF_;     break;
      default: break;
    }
    // Polling cadence matters; log every Nth call to avoid drowning.
    static int poll = 0;
    if ((poll++ % 240) == 0) {
      PROBE_LOG("GetFloatParameter", "idx=%u value=%.6f n=%d",
                idx, (double)v, poll);
    }
    return v;
  }

  char* GetTextParameter(unsigned int idx) override {
    std::string* src = nullptr;
    switch (idx) {
      case P_CONFIG:   src = &config_;   break;
      case P_WASMFILE: src = &wasmFile_; break;
      case P_NOTES:    src = &notes_;    break;
      case P_DYN_T:    src = &dynT_;     break;
      default: break;
    }
    // Return a stable buffer per param so the host can read the char*
    // without UAF.
    char* buf = textBufFor(idx);
    if (src) {
      size_t n = std::min(src->size(), kTextBufSize - 1);
      memcpy(buf, src->data(), n);
      buf[n] = '\0';
    } else {
      buf[0] = '\0';
    }
    // GetTextParameter is the polling we want to characterize. Log every
    // call until we have a feel for cadence, then sample.
    static int poll = 0;
    if (poll < 32 || (poll % 60) == 0) {
      PROBE_LOG("GetTextParameter", "idx=%u value=%s n=%d",
                idx, nano_probe_log::redact(buf).c_str(), poll);
    }
    ++poll;
    return buf;
  }

  // -- Render -----------------------------------------------------------
  FFResult ProcessOpenGL(ProcessOpenGLStruct* pGL) override {
    ++frame_;
    PROBE_CTX_FRAME(frame_);

    // Phase tracking (driven by the user-controlled `phase` knob).
    ProbePhase ph = phase_from_float(phaseVal_);
    if (ph != lastPhase_) {
      PROBE_LOG("PROBE_PHASE_CHANGE", "old=%s new=%s phase=%.3f",
                phase_name(lastPhase_), phase_name(ph), (double)phaseVal_);
      lastPhase_ = ph;
      phaseEnteredFrame_ = frame_;
      onPhaseEnter(ph);
    } else {
      onPhaseTick(ph);
    }

    // Render: blit input → output, plus a magenta corner badge.
    drawPassthroughAndBadge(pGL);

    return FF_SUCCESS;
  }

 private:
  // -- Probe actions -----------------------------------------------------
  void onPhaseEnter(ProbePhase ph) {
    switch (ph) {
      case PH_DYN_REGISTER:
        if (!dynRegistered_) {
          PROBE_LOG("PROBE_ACTION", "calling SetParamInfo for idx=%u (dyn5,STANDARD)", P_DYN_F);
          SetParamInfo(P_DYN_F, "dyn5", FF_TYPE_STANDARD, dynF_);
          PROBE_LOG("PROBE_ACTION", "calling SetParamInfo for idx=%u (dyn6,TEXT)", P_DYN_T);
          SetParamInfo(P_DYN_T, "dyn6", FF_TYPE_TEXT, dynT_.c_str());
          dynRegistered_ = true;
          PROBE_LOG("PROBE_ACTION", "now=%u params total (5 static + 2 dyn)",
                    GetNumParams());
        }
        break;
      case PH_QUIESCENT_HI:
        PROBE_LOG("PROBE_MARKER",
                  ">>> SAVE composition, QUIT Resolume, RELAUNCH, REOPEN now.");
        PROBE_LOG("PROBE_MARKER",
                  ">>> Watch for ctor / SetTextParameter / SetFloatParameter callbacks on reload.");
        break;
      default:
        break;
    }
  }

  void onPhaseTick(ProbePhase ph) {
    int sincePhase = frame_ - phaseEnteredFrame_;
    if (ph == PH_CONFIG_MUTATE) {
      // Every 30 frames: mutate config_ internally. Alternate between
      // (a) silent mutation (no event) and (b) raised FF_EVENT_FLAG_VALUE.
      if (sincePhase > 0 && (sincePhase % 30) == 0) {
        int bucket = (sincePhase / 30) % 2;
        char buf[256];
        snprintf(buf, sizeof(buf),
                 "{\"counter\":%d,\"frame\":%d,\"variant\":%s}",
                 sincePhase / 30, frame_,
                 bucket == 0 ? "\"silent\"" : "\"event\"");
        config_ = buf;
        PROBE_LOG("PROBE_ACTION",
                  "mutated config (variant=%s): %s",
                  bucket == 0 ? "silent" : "event",
                  nano_probe_log::redact(config_.c_str()).c_str());
        if (bucket == 1) {
          PROBE_LOG("PROBE_ACTION",
                    "RaiseParamEvent(idx=%u, FF_EVENT_FLAG_VALUE)", P_CONFIG);
          RaiseParamEvent(P_CONFIG, FF_EVENT_FLAG_VALUE);
        }
      }
    } else if (ph == PH_ELEMENTS_MUT) {
      // Once at 30 frames in: swap the element list out from under the
      // host with raiseEvent=true.
      if (sincePhase == 30 && !elementsMutated_) {
        std::vector<std::string> newNames = {
          "soft_glow", "dynamic_added", "passthrough", "fresh_item"
        };
        std::vector<float> newValues = { 0.0f, 0.33f, 0.66f, 1.0f };
        PROBE_LOG("PROBE_ACTION",
                  "SetParamElements(idx=%u, newCount=4, raiseEvent=true)",
                  P_EFFECTS);
        SetParamElements(P_EFFECTS, newNames, newValues, /*raiseEvent=*/true);
        elementsMutated_ = true;
      }
      // Then at 90 frames in: same payload with raiseEvent=false for a
      // back-to-back comparison.
      if (sincePhase == 90 && elementsMutated_) {
        std::vector<std::string> newNames = {
          "soft_glow", "dynamic_added", "passthrough", "fresh_item", "even_newer"
        };
        std::vector<float> newValues = { 0.0f, 0.25f, 0.5f, 0.75f, 1.0f };
        PROBE_LOG("PROBE_ACTION",
                  "SetParamElements(idx=%u, newCount=5, raiseEvent=false)",
                  P_EFFECTS);
        SetParamElements(P_EFFECTS, newNames, newValues, /*raiseEvent=*/false);
      }
    }
  }

  // -- Render helpers ----------------------------------------------------
  void drawPassthroughAndBadge(ProcessOpenGLStruct* pGL) {
    const unsigned int W = currentViewport.width;
    const unsigned int H = currentViewport.height;
    if (W == 0 || H == 0) return;

    // Save the host's output FBO so we can rebind it after the blit.
    GLint dstFbo = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &dstFbo);

    // Passthrough — only if we have an input texture.
    if (pGL->numInputTextures > 0 && pGL->inputTextures &&
        pGL->inputTextures[0] && srcFbo_) {
      const FFGLTextureStruct* in = pGL->inputTextures[0];
      glBindFramebuffer(GL_READ_FRAMEBUFFER, srcFbo_);
      glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                             GL_TEXTURE_2D, in->Handle, 0);
      glBindFramebuffer(GL_DRAW_FRAMEBUFFER, dstFbo);
      glBlitFramebuffer(0, 0, (GLint)in->Width, (GLint)in->Height,
                        0, 0, (GLint)W, (GLint)H,
                        GL_COLOR_BUFFER_BIT, GL_LINEAR);
      glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, dstFbo);

    // Corner badge — magenta-ish square in upper-right (~10% of the
    // frame). Hue rotates slightly with phase so we can eyeball-confirm
    // the value is reaching us.
    const int bx = (int)(W * 0.85f);
    const int by = (int)(H * 0.85f);
    const int bw = (int)(W * 0.12f);
    const int bh = (int)(H * 0.12f);
    glEnable(GL_SCISSOR_TEST);
    glScissor(bx, by, bw, bh);
    glClearColor(1.0f, 0.1f + 0.8f * phaseVal_, 1.0f - 0.6f * phaseVal_, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
  }

  // -- Storage -----------------------------------------------------------
  static constexpr size_t kTextBufSize = 8192;
  char* textBufFor(unsigned int idx) {
    auto& slot = textBufs_[idx % textBufs_.size()];
    return slot.data();
  }

  // Own values for every param we expose. The SDK doesn't track these;
  // we have to.
  std::string config_;
  std::string wasmFile_;
  std::string notes_;
  std::string dynT_;
  float       phaseVal_ = 0.0f;
  float       effects_  = 0.0f;
  float       dynF_     = 0.5f;
  bool        dynRegistered_ = false;
  bool        elementsMutated_ = false;

  // Per-text-param return buffer for GetTextParameter (must stay valid
  // through the host's read).
  std::array<std::array<char, kTextBufSize>, 16> textBufs_{};

  // Render state.
  GLuint srcFbo_ = 0;

  // Phase tracking.
  int frame_ = 0;
  ProbePhase lastPhase_ = PH_QUIESCENT_LOW;
  int phaseEnteredFrame_ = 0;
};

// ============================================================================
// FFGL plugin registration block.
static CFFGLPluginInfo PluginInfo(
    PluginFactory<NanoProbePlugin>,
    "NPRB",                   // 4-char unique ID
    "NanoProbe",              // Plugin name (≤ 16 chars)
    2, 1,                     // FFGL API version
    1, 0,                     // Plugin version
    FF_EFFECT,                // Type
    "FFGL probe — dynamic param + plugin-set value experiment",
    "nattos");
