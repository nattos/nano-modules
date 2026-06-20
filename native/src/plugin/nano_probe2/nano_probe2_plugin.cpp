// nano_probe2_plugin.cpp — NanoProbe2 FFGL plugin.
//
// Targets the two open questions left by NanoProbe v1:
//
//  (a) Does SetParamDisplayName(idx, name, raiseEvent=true) update the
//      Resolume inspector label live, without restart? Required for the
//      "slot pool" barrel design where each FFGL param's *meaning*
//      (and label) changes as effects are loaded into the sketch.
//      Also probes SetParamVisibility live-show/hide.
//
//  (b) What is the practical upper byte length of an FF_TYPE_TEXT param
//      that Resolume persists intact across composition save+reload?
//      Probes 64 B → 16 MB in buckets, with a deterministic payload
//      so any truncation / corruption is visible as a first-divergence
//      byte offset.
//
// Two independent dials drive the two experiments:
//   - `phase` — walks 10 relabel/visibility test phases.
//   - `size`  — selects one of 7 text payload size buckets.
//
// Same render approach as v1 (passthrough + corner badge), badge tinted
// cyan so the two plugins are visually distinct in a comp.

#include <array>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include <OpenGL/gl3.h>

#include <ffgl/FFGLPluginSDK.h>
#include <ffgl/FFGLPluginInfo.h>
#include <ffgl/FFGLLib.h>

#include "probe2_log.h"

namespace {

// -- Parameter indices --------------------------------------------------
constexpr unsigned int P_PHASE   = 0;   // STANDARD: drives relabel phases
constexpr unsigned int P_SIZE    = 1;   // STANDARD: drives payload bucket
constexpr unsigned int P_SLOT_A  = 2;   // STANDARD: relabel target A
constexpr unsigned int P_SLOT_B  = 3;   // STANDARD: relabel + visibility target B
constexpr unsigned int P_SLOT_C  = 4;   // STANDARD: relabel target C
constexpr unsigned int P_SLOT_D  = 5;   // STANDARD: relabel target D
constexpr unsigned int P_CONFIG  = 6;   // TEXT: the sized payload

// -- Size buckets -------------------------------------------------------
struct SizeBucket {
  float    minPhase;
  size_t   bytes;
  const char* label;
};
constexpr SizeBucket kSizeBuckets[] = {
  { 0.00f,        64, "64B"   },
  { 0.15f,      4096, "4KB"   },
  { 0.30f,     65536, "64KB"  },
  { 0.45f,    262144, "256KB" },
  { 0.60f,   1048576, "1MB"   },
  { 0.75f,   4194304, "4MB"   },
  { 0.90f,  16777216, "16MB"  },
};
constexpr int kNumSizeBuckets =
    sizeof(kSizeBuckets) / sizeof(kSizeBuckets[0]);

int bucket_from_knob(float v) {
  for (int i = kNumSizeBuckets - 1; i >= 0; --i) {
    if (v >= kSizeBuckets[i].minPhase) return i;
  }
  return 0;
}

int bucket_for_size(size_t bytes) {
  for (int i = 0; i < kNumSizeBuckets; ++i) {
    if (kSizeBuckets[i].bytes == bytes) return i;
  }
  return -1;
}

// -- Relabel phase walk -------------------------------------------------
enum RelabelPhase {
  RP_QUIESCENT_LOW = 0,   // < 0.10
  RP_RELABEL_BASIC,       // 0.10 - 0.20
  RP_RELABEL_UNICODE,     // 0.20 - 0.30
  RP_RELABEL_EMPTY,       // 0.30 - 0.40  (docs: empty reverts to registered name)
  RP_RELABEL_NOEVENT,     // 0.40 - 0.50  (raiseEvent=false → +60 frames → manual raise)
  RP_HIDE_SLOT_B,         // 0.50 - 0.60
  RP_SHOW_SLOT_B,         // 0.60 - 0.70
  RP_RELABEL_BURST,       // 0.70 - 0.80  (every 15 frames, relabel all 4 slots)
  RP_QUIESCENT_MID,       // 0.80 - 0.90
  RP_SAVE_RELOAD,         // > 0.90
};

RelabelPhase rphase_from_float(float v) {
  if (v < 0.10f) return RP_QUIESCENT_LOW;
  if (v < 0.20f) return RP_RELABEL_BASIC;
  if (v < 0.30f) return RP_RELABEL_UNICODE;
  if (v < 0.40f) return RP_RELABEL_EMPTY;
  if (v < 0.50f) return RP_RELABEL_NOEVENT;
  if (v < 0.60f) return RP_HIDE_SLOT_B;
  if (v < 0.70f) return RP_SHOW_SLOT_B;
  if (v < 0.80f) return RP_RELABEL_BURST;
  if (v < 0.90f) return RP_QUIESCENT_MID;
  return RP_SAVE_RELOAD;
}

const char* rphase_name(RelabelPhase p) {
  switch (p) {
    case RP_QUIESCENT_LOW:   return "QUIESCENT_LOW";
    case RP_RELABEL_BASIC:   return "RELABEL_BASIC";
    case RP_RELABEL_UNICODE: return "RELABEL_UNICODE";
    case RP_RELABEL_EMPTY:   return "RELABEL_EMPTY";
    case RP_RELABEL_NOEVENT: return "RELABEL_NOEVENT";
    case RP_HIDE_SLOT_B:     return "HIDE_SLOT_B";
    case RP_SHOW_SLOT_B:     return "SHOW_SLOT_B";
    case RP_RELABEL_BURST:   return "RELABEL_BURST";
    case RP_QUIESCENT_MID:   return "QUIESCENT_MID";
    case RP_SAVE_RELOAD:     return "SAVE_RELOAD";
  }
  return "?";
}

// -- Deterministic payload ---------------------------------------------
// Format: a one-line ASCII header, then a repeating 16-byte alphabet
// pattern padded to exactly target_bytes. The header lets the plugin
// recover the intended size from a restored value, so the round-trip
// integrity check can rebuild the canonical bytes and compare.
void generate_payload(size_t target_bytes, std::string& out) {
  static const char kAlphabet[17] = "0123456789ABCDEF";
  out.clear();
  out.reserve(target_bytes);

  char header[128];
  // Trailing space + newline keeps the header self-contained even if
  // someone reads up to the first \n.
  int hlen = snprintf(header, sizeof(header),
                      "NANOPROBE2 SIZE=%zu BODY=alphabet16 \n",
                      target_bytes);
  if (hlen < 0) hlen = 0;
  if ((size_t)hlen > target_bytes) hlen = (int)target_bytes;
  out.append(header, hlen);

  while (out.size() < target_bytes) {
    size_t remaining = target_bytes - out.size();
    size_t chunk = remaining < 16 ? remaining : 16;
    out.append(kAlphabet, chunk);
  }
}

struct VerifyResult {
  bool   size_match;
  bool   body_match;
  size_t expected_size;
  size_t received_size;
  size_t first_diff_offset;   // SIZE_MAX if bodies match up to min size
};

VerifyResult verify_payload(const std::string& expected,
                            const std::string& received) {
  VerifyResult r{};
  r.expected_size = expected.size();
  r.received_size = received.size();
  r.size_match = (expected.size() == received.size());
  r.first_diff_offset = SIZE_MAX;
  size_t min_size = expected.size() < received.size()
                        ? expected.size()
                        : received.size();
  for (size_t i = 0; i < min_size; ++i) {
    if (expected[i] != received[i]) {
      r.first_diff_offset = i;
      break;
    }
  }
  r.body_match = (r.first_diff_offset == SIZE_MAX) && r.size_match;
  return r;
}

}  // namespace

// ============================================================================
class NanoProbe2Plugin : public CFFGLPlugin {
 public:
  NanoProbe2Plugin() : CFFGLPlugin() {
    PROBE_LOG("ctor", "this=%p", (void*)this);

    SetMinInputs(1);
    SetMaxInputs(1);
    SetTimeSupported(true);

    phaseVal_ = 0.0f;
    sizeKnob_ = 0.0f;
    slots_[0] = slots_[1] = slots_[2] = slots_[3] = 0.0f;
    config_.clear();
    currentBucket_ = -1;

    SetParamInfo(P_PHASE,  "phase",  FF_TYPE_STANDARD, phaseVal_);
    PROBE_LOG("SetParamInfo", "idx=%u name=phase type=STANDARD default=%.3f",
              P_PHASE, (double)phaseVal_);

    SetParamInfo(P_SIZE,   "size",   FF_TYPE_STANDARD, sizeKnob_);
    PROBE_LOG("SetParamInfo", "idx=%u name=size type=STANDARD default=%.3f",
              P_SIZE, (double)sizeKnob_);

    SetParamInfo(P_SLOT_A, "slot_a", FF_TYPE_STANDARD, slots_[0]);
    SetParamInfo(P_SLOT_B, "slot_b", FF_TYPE_STANDARD, slots_[1]);
    SetParamInfo(P_SLOT_C, "slot_c", FF_TYPE_STANDARD, slots_[2]);
    SetParamInfo(P_SLOT_D, "slot_d", FF_TYPE_STANDARD, slots_[3]);
    PROBE_LOG("SetParamInfo", "4 slots (slot_a..slot_d) registered STANDARD default=0");

    SetParamInfo(P_CONFIG, "config", FF_TYPE_TEXT, "");
    PROBE_LOG("SetParamInfo", "idx=%u name=config type=TEXT default=<empty>",
              P_CONFIG);

    PROBE_LOG("ctor-done", "7 static params total");
  }

  ~NanoProbe2Plugin() override {
    PROBE_LOG("dtor", "this=%p config_size=%zu currentBucket=%d",
              (void*)this, config_.size(), currentBucket_);
  }

  // -- Lifecycle -------------------------------------------------------
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
    static double lastLogged = -1e9;
    if (t - lastLogged > 5.0) {
      PROBE_LOG("SetTime", "t=%.3f", t);
      lastLogged = t;
    }
    return CFFGLPlugin::SetTime(t);
  }

  // -- Parameter callbacks --------------------------------------------
  FFResult SetFloatParameter(unsigned int idx, float value) override {
    PROBE_LOG("SetFloatParameter", "idx=%u value=%.6f", idx, (double)value);
    switch (idx) {
      case P_PHASE:  phaseVal_ = value; PROBE_CTX_PHASE(value); break;
      case P_SIZE:   sizeKnob_ = value; break;
      case P_SLOT_A: slots_[0] = value; break;
      case P_SLOT_B: slots_[1] = value; break;
      case P_SLOT_C: slots_[2] = value; break;
      case P_SLOT_D: slots_[3] = value; break;
      default: break;
    }
    return FF_SUCCESS;
  }

  FFResult SetTextParameter(unsigned int idx, const char* value) override {
    const char* v = value ? value : "";
    size_t len = strlen(v);

    if (idx == P_CONFIG) {
      std::string received(v, len);
      if (received == config_) {
        // Host echoing back what we already have — confirms read consistency.
        PROBE_LOG("SetTextParameter",
                  "idx=%u (echo) size=%zu head=%s",
                  idx, len, PROBE_REDACT(v, 40).c_str());
      } else {
        // Different from our internal value — either initial default
        // push, host-side default, or a save/reload restore. Try to
        // parse the canonical header and verify the bytes survived.
        size_t hdr_size = 0;
        bool parsed = (sscanf(v, "NANOPROBE2 SIZE=%zu", &hdr_size) == 1);
        if (parsed && hdr_size > 0 && hdr_size <= 64 * 1024 * 1024) {
          std::string expected;
          generate_payload(hdr_size, expected);
          VerifyResult vr = verify_payload(expected, received);
          PROBE_LOG("SetTextParameter",
                    "idx=%u (restore?) recv=%zu hdr_size=%zu size_match=%d body_match=%d first_diff=%lld head=%s",
                    idx, len, hdr_size,
                    vr.size_match ? 1 : 0,
                    vr.body_match ? 1 : 0,
                    vr.first_diff_offset == SIZE_MAX
                        ? (long long)-1
                        : (long long)vr.first_diff_offset,
                    PROBE_REDACT(v, 40).c_str());
          // Adopt the restored value AND its bucket so the
          // ProcessOpenGL bucket check doesn't redundantly regenerate.
          int b = bucket_for_size(hdr_size);
          if (b >= 0) {
            currentBucket_ = b;
            PROBE_LOG("PROBE_RESTORE",
                      "adopted bucket=%d label=%s", b, kSizeBuckets[b].label);
          }
        } else {
          PROBE_LOG("SetTextParameter",
                    "idx=%u (unrecognized) size=%zu head=%s",
                    idx, len, PROBE_REDACT(v, 40).c_str());
        }
        config_ = received;
      }
      return FF_SUCCESS;
    }

    PROBE_LOG("SetTextParameter", "idx=%u size=%zu head=%s",
              idx, len, PROBE_REDACT(v).c_str());
    return FF_SUCCESS;
  }

  float GetFloatParameter(unsigned int idx) override {
    float v = 0.0f;
    switch (idx) {
      case P_PHASE:  v = phaseVal_; break;
      case P_SIZE:   v = sizeKnob_; break;
      case P_SLOT_A: v = slots_[0]; break;
      case P_SLOT_B: v = slots_[1]; break;
      case P_SLOT_C: v = slots_[2]; break;
      case P_SLOT_D: v = slots_[3]; break;
      default: break;
    }
    static int poll = 0;
    if ((poll++ % 240) == 0) {
      PROBE_LOG("GetFloatParameter", "idx=%u value=%.6f n=%d",
                idx, (double)v, poll);
    }
    return v;
  }

  char* GetTextParameter(unsigned int idx) override {
    static int poll = 0;
    if (idx == P_CONFIG) {
      if (configReturnBuf_.size() <= config_.size()) {
        configReturnBuf_.resize(config_.size() + 1);
      }
      if (!config_.empty()) {
        memcpy(configReturnBuf_.data(), config_.data(), config_.size());
      }
      configReturnBuf_[config_.size()] = '\0';
      if (poll < 32 || (poll % 60) == 0) {
        PROBE_LOG("GetTextParameter",
                  "idx=%u size=%zu head=%s n=%d",
                  idx, config_.size(),
                  PROBE_REDACT(configReturnBuf_.data(), 40).c_str(),
                  poll);
      }
      ++poll;
      return configReturnBuf_.data();
    }
    smallReturnBuf_[0] = '\0';
    ++poll;
    return smallReturnBuf_;
  }

  // -- Render ----------------------------------------------------------
  FFResult ProcessOpenGL(ProcessOpenGLStruct* pGL) override {
    ++frame_;
    PROBE_CTX_FRAME(frame_);

    // Phase walk
    RelabelPhase rp = rphase_from_float(phaseVal_);
    if (rp != lastRP_) {
      PROBE_LOG("PROBE_RPHASE_CHANGE", "old=%s new=%s phase=%.3f",
                rphase_name(lastRP_), rphase_name(rp), (double)phaseVal_);
      lastRP_ = rp;
      rphaseEnteredFrame_ = frame_;
      onRPhaseEnter(rp);
    } else {
      onRPhaseTick(rp);
    }

    // Size bucket
    int newBucket = bucket_from_knob(sizeKnob_);
    if (newBucket != currentBucket_) {
      PROBE_LOG("PROBE_SIZE_BUCKET_CHANGE",
                "old=%d new=%d sizeKnob=%.3f target=%s (%zu bytes)",
                currentBucket_, newBucket, (double)sizeKnob_,
                kSizeBuckets[newBucket].label, kSizeBuckets[newBucket].bytes);
      currentBucket_ = newBucket;
      generate_payload(kSizeBuckets[newBucket].bytes, config_);
      PROBE_LOG("PROBE_ACTION",
                "regenerated config payload size=%zu, raising FF_EVENT_FLAG_VALUE on idx=%u",
                config_.size(), P_CONFIG);
      RaiseParamEvent(P_CONFIG, FF_EVENT_FLAG_VALUE);
    }

    drawPassthroughAndBadge(pGL);
    return FF_SUCCESS;
  }

 private:
  // -- Probe actions ---------------------------------------------------
  void onRPhaseEnter(RelabelPhase rp) {
    switch (rp) {
      case RP_RELABEL_BASIC:
        PROBE_LOG("PROBE_ACTION",
                  "SetParamDisplayName(idx=%u, 'Slot Alpha', raiseEvent=true)",
                  P_SLOT_A);
        SetParamDisplayName(P_SLOT_A, "Slot Alpha", true);
        break;

      case RP_RELABEL_UNICODE: {
        const char* label = "\xF0\x9F\x8E\x9A Vol-Unicode";  // 🎚 Vol-Unicode
        PROBE_LOG("PROBE_ACTION",
                  "SetParamDisplayName(idx=%u, '\\u1f39a Vol-Unicode', raiseEvent=true)",
                  P_SLOT_A);
        SetParamDisplayName(P_SLOT_A, label, true);
        break;
      }

      case RP_RELABEL_EMPTY:
        PROBE_LOG("PROBE_ACTION",
                  "SetParamDisplayName(idx=%u, '', raiseEvent=true) — docs say empty reverts",
                  P_SLOT_A);
        SetParamDisplayName(P_SLOT_A, "", true);
        break;

      case RP_RELABEL_NOEVENT:
        PROBE_LOG("PROBE_ACTION",
                  "SetParamDisplayName(idx=%u, 'NoEvent', raiseEvent=false) — UI should NOT update yet",
                  P_SLOT_A);
        SetParamDisplayName(P_SLOT_A, "NoEvent", false);
        break;

      case RP_HIDE_SLOT_B:
        PROBE_LOG("PROBE_ACTION",
                  "SetParamVisibility(idx=%u, false, raiseEvent=true) — slot_b should vanish",
                  P_SLOT_B);
        SetParamVisibility(P_SLOT_B, false, true);
        break;

      case RP_SHOW_SLOT_B:
        PROBE_LOG("PROBE_ACTION",
                  "SetParamVisibility(idx=%u, true, raiseEvent=true) — slot_b should reappear",
                  P_SLOT_B);
        SetParamVisibility(P_SLOT_B, true, true);
        break;

      case RP_RELABEL_BURST:
        burstCounter_ = 0;
        PROBE_LOG("PROBE_ACTION",
                  "entering RELABEL_BURST — will relabel A/B/C/D every 15 frames");
        break;

      case RP_SAVE_RELOAD:
        PROBE_LOG("PROBE_MARKER",
                  ">>> SAVE composition, QUIT Resolume, RELAUNCH, REOPEN now.");
        PROBE_LOG("PROBE_MARKER",
                  ">>> On reload, watch SetTextParameter(idx=6) for size_match/body_match.");
        PROBE_LOG("PROBE_MARKER",
                  ">>> Also check whether slot_a's display name persisted as the last-set value.");
        break;

      default:
        break;
    }
  }

  void onRPhaseTick(RelabelPhase rp) {
    int since = frame_ - rphaseEnteredFrame_;
    if (rp == RP_RELABEL_NOEVENT) {
      // 60 frames after entering, raise DISPLAY_NAME event manually.
      // Compare UI: should snap to "NoEvent" only AFTER this point.
      if (since == 60) {
        PROBE_LOG("PROBE_ACTION",
                  "RaiseParamEvent(idx=%u, FF_EVENT_FLAG_DISPLAY_NAME) — UI should NOW show 'NoEvent'",
                  P_SLOT_A);
        RaiseParamEvent(P_SLOT_A, FF_EVENT_FLAG_DISPLAY_NAME);
      }
    } else if (rp == RP_RELABEL_BURST) {
      if (since > 0 && (since % 15) == 0) {
        ++burstCounter_;
        char buf[64];
        snprintf(buf, sizeof(buf), "A%d", burstCounter_);
        SetParamDisplayName(P_SLOT_A, buf, true);
        snprintf(buf, sizeof(buf), "B%d", burstCounter_);
        SetParamDisplayName(P_SLOT_B, buf, true);
        snprintf(buf, sizeof(buf), "C%d", burstCounter_);
        SetParamDisplayName(P_SLOT_C, buf, true);
        snprintf(buf, sizeof(buf), "D%d", burstCounter_);
        SetParamDisplayName(P_SLOT_D, buf, true);
        PROBE_LOG("PROBE_ACTION",
                  "burst relabel #%d → A%d/B%d/C%d/D%d (raiseEvent=true)",
                  burstCounter_, burstCounter_, burstCounter_,
                  burstCounter_, burstCounter_);
      }
    }
  }

  // -- Render helpers --------------------------------------------------
  void drawPassthroughAndBadge(ProcessOpenGLStruct* pGL) {
    const unsigned int W = currentViewport.width;
    const unsigned int H = currentViewport.height;
    if (W == 0 || H == 0) return;

    GLint dstFbo = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &dstFbo);

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

    // Cyan badge — distinguishes v2 from v1's magenta in side-by-side comps.
    const int bx = (int)(W * 0.85f);
    const int by = (int)(H * 0.85f);
    const int bw = (int)(W * 0.12f);
    const int bh = (int)(H * 0.12f);
    glEnable(GL_SCISSOR_TEST);
    glScissor(bx, by, bw, bh);
    glClearColor(0.1f + 0.6f * phaseVal_, 1.0f, 1.0f - 0.4f * sizeKnob_, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
  }

  // -- State -----------------------------------------------------------
  float                phaseVal_  = 0.0f;
  float                sizeKnob_  = 0.0f;
  std::array<float, 4> slots_{};
  std::string          config_;
  std::vector<char>    configReturnBuf_;   // grows on demand for GetText
  char                 smallReturnBuf_[64]{};

  int          currentBucket_       = -1;
  RelabelPhase lastRP_              = RP_QUIESCENT_LOW;
  int          rphaseEnteredFrame_  = 0;
  int          burstCounter_        = 0;

  int    frame_  = 0;
  GLuint srcFbo_ = 0;
};

// ============================================================================
static CFFGLPluginInfo PluginInfo(
    PluginFactory<NanoProbe2Plugin>,
    "NPB2",                       // 4-char unique ID
    "NanoProbe2",                 // Plugin name (≤ 16 chars)
    2, 1,                         // FFGL API
    1, 0,                         // Plugin version
    FF_EFFECT,
    "FFGL probe v2 — display name relabel + text payload size",
    "nano");
