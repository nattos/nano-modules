// nano_probe3_plugin.cpp — NanoProbe3 FFGL plugin.
//
// Probe 2 established that storing significant config in an FF_TYPE_TEXT
// param wedges Resolume's inspector at >= 4 KB (text widget render
// pipeline can't keep up). FF_TYPE_FILE is internally the same
// SetTextParameter/GetTextParameter byte channel but renders as a path +
// "Browse…" button — no text reflow, no monospace layout. The
// hypothesis this probe tests: **a FILE param can carry an arbitrarily
// large config blob without the Resolume UI chugging, and the value
// survives composition save/reload byte-for-byte.**
//
// Two knobs:
//   - `size` selects one of seven payload size buckets (64 B → 16 MB).
//   - `mode` selects one of three encoding strategies for the payload
//      header, so we can tell whether Resolume validates / normalises
//      the string as if it were a real path:
//        RAW  — "NANOPROBE3 SIZE=… MODE=RAW BODY=alphabet16\n<body>"
//        PATH — "nanobarrel://inline.cfg?SIZE=…&MODE=PATH&BODY=<body>"
//        DATA — "data:application/octet-stream;b16,SIZE=…,MODE=DATA,BODY=<body>"
//
// Whenever either knob crosses a bucket boundary the plugin regenerates
// the blob, raises FF_EVENT_FLAG_VALUE, and lets Resolume re-read +
// persist. SetTextParameter callbacks are classified into:
//   - echo:      value matches what we last set (host roundtripping)
//   - restore:   value parses as one of our headers but didn't match
//                what we set (likely save/reload from a previous
//                session); integrity-check the body and log first-
//                divergence offset.
//   - clobber:   value is neither empty nor one of our headers; user
//                probably clicked Browse… and picked a real file.
//
// A second FF_TYPE_FILE param (blob2) holds a fixed marker payload
// throughout — sanity check that Resolume persists multiple FILE params
// independently.
//
// Orange corner badge to visually distinguish this plugin from probes
// 1 (magenta) and 2 (cyan).

#include <array>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include <OpenGL/gl3.h>

#include <ffgl/FFGLPluginSDK.h>
#include <ffgl/FFGLPluginInfo.h>
#include <ffgl/FFGLLib.h>

#include "probe3_log.h"

namespace {

constexpr unsigned int P_SIZE  = 0;   // STANDARD: payload size bucket
constexpr unsigned int P_MODE  = 1;   // STANDARD: encoding mode
constexpr unsigned int P_BLOB  = 2;   // FILE:     the test payload
constexpr unsigned int P_BLOB2 = 3;   // FILE:     static marker (multi-FILE persistence)

// Static marker for blob2; never mutated, but probed for survival.
constexpr const char* kBlob2Default =
    "nanobarrel://blob2.cfg?secondary_marker_v1";

// -- Size buckets (same as probe 2) ------------------------------------
struct SizeBucket {
  float       minPhase;
  size_t      bytes;
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

// -- Encoding modes ----------------------------------------------------
enum EncodingMode {
  EM_RAW          = 0,
  EM_PATH_PREFIX  = 1,
  EM_DATA_URI     = 2,
};

EncodingMode mode_from_knob(float v) {
  if (v < 0.34f) return EM_RAW;
  if (v < 0.67f) return EM_PATH_PREFIX;
  return EM_DATA_URI;
}

const char* mode_name(EncodingMode m) {
  switch (m) {
    case EM_RAW:         return "RAW";
    case EM_PATH_PREFIX: return "PATH";
    case EM_DATA_URI:    return "DATA";
  }
  return "?";
}

// Generate the canonical payload for (mode, target_bytes). Body is a
// repeating 16-byte alphabet (`0123456789ABCDEF`), padded to fill
// exactly target_bytes including the header.
void generate_payload(EncodingMode mode, size_t target_bytes,
                      std::string& out) {
  char header[256];
  int hlen = 0;
  switch (mode) {
    case EM_RAW:
      hlen = snprintf(header, sizeof(header),
                      "NANOPROBE3 SIZE=%zu MODE=RAW BODY=alphabet16 \n",
                      target_bytes);
      break;
    case EM_PATH_PREFIX:
      hlen = snprintf(header, sizeof(header),
                      "nanobarrel://inline.cfg?SIZE=%zu&MODE=PATH&BODY=",
                      target_bytes);
      break;
    case EM_DATA_URI:
      hlen = snprintf(header, sizeof(header),
                      "data:application/octet-stream;b16,SIZE=%zu,MODE=DATA,BODY=",
                      target_bytes);
      break;
  }
  if (hlen < 0) hlen = 0;
  if ((size_t)hlen > target_bytes) hlen = (int)target_bytes;

  out.clear();
  out.reserve(target_bytes);
  out.append(header, hlen);

  static const char kAlphabet[17] = "0123456789ABCDEF";
  while (out.size() < target_bytes) {
    size_t r = target_bytes - out.size();
    size_t c = r < 16 ? r : 16;
    out.append(kAlphabet, c);
  }
}

// Parse a value we received from the host. Looks only at the head of
// the string so a 16 MB payload doesn't cost a full scan.
struct ParsedHeader {
  bool         recognized;     // looks like one of our 3 prefixes
  EncodingMode mode;
  size_t       size;
};

ParsedHeader parse_header(const char* s) {
  ParsedHeader p{};
  if (!s || !*s) return p;
  // Only look at the first 256 bytes — all headers fit comfortably.
  char head[257];
  size_t n = strnlen(s, sizeof(head) - 1);
  memcpy(head, s, n);
  head[n] = '\0';

  EncodingMode m = EM_RAW;
  bool found_mode = false;
  if (strstr(head, "MODE=RAW"))  { m = EM_RAW;         found_mode = true; }
  else if (strstr(head, "MODE=PATH")) { m = EM_PATH_PREFIX; found_mode = true; }
  else if (strstr(head, "MODE=DATA")) { m = EM_DATA_URI;    found_mode = true; }

  const char* sz = strstr(head, "SIZE=");
  size_t sz_val = 0;
  bool found_size = (sz && sscanf(sz, "SIZE=%zu", &sz_val) == 1);

  if (found_mode && found_size) {
    p.recognized = true;
    p.mode = m;
    p.size = sz_val;
  }
  return p;
}

struct VerifyResult {
  bool   size_match;
  bool   body_match;
  size_t expected_size;
  size_t received_size;
  size_t first_diff_offset;
};

VerifyResult verify_against_canonical(EncodingMode mode, size_t expected_size,
                                      const std::string& received) {
  VerifyResult r{};
  std::string expected;
  generate_payload(mode, expected_size, expected);
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
class NanoProbe3Plugin : public CFFGLPlugin {
 public:
  NanoProbe3Plugin() : CFFGLPlugin() {
    PROBE_LOG("ctor", "this=%p", (void*)this);

    SetMinInputs(1);
    SetMaxInputs(1);
    SetTimeSupported(true);

    sizeKnob_      = 0.0f;
    modeKnob_      = 0.0f;
    blob_.clear();
    blob2_         = kBlob2Default;
    currentBucket_ = -1;
    currentMode_   = (EncodingMode)-1;

    SetParamInfo(P_SIZE, "size", FF_TYPE_STANDARD, sizeKnob_);
    PROBE_LOG("SetParamInfo", "idx=%u name=size type=STANDARD default=%.3f",
              P_SIZE, (double)sizeKnob_);

    SetParamInfo(P_MODE, "mode", FF_TYPE_STANDARD, modeKnob_);
    PROBE_LOG("SetParamInfo",
              "idx=%u name=mode type=STANDARD default=%.3f (RAW=0..0.34, PATH=0.34..0.67, DATA=0.67..1.0)",
              P_MODE, (double)modeKnob_);

    {
      std::vector<std::string> exts = {"nanocfg"};
      SetFileParamInfo(P_BLOB, "blob", exts, "");
      PROBE_LOG("SetFileParamInfo",
                "idx=%u name=blob type=FILE exts=nanocfg default=<empty>",
                P_BLOB);
    }
    {
      std::vector<std::string> exts = {"nanocfg"};
      SetFileParamInfo(P_BLOB2, "blob2", exts, kBlob2Default);
      PROBE_LOG("SetFileParamInfo",
                "idx=%u name=blob2 type=FILE exts=nanocfg default=%s",
                P_BLOB2, PROBE_REDACT(kBlob2Default).c_str());
    }

    PROBE_LOG("ctor-done", "4 params total (size,mode,blob,blob2)");
  }

  ~NanoProbe3Plugin() override {
    PROBE_LOG("dtor", "this=%p blob_size=%zu currentBucket=%d currentMode=%d",
              (void*)this, blob_.size(), currentBucket_, (int)currentMode_);
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
      case P_SIZE: sizeKnob_ = value; PROBE_CTX_PHASE(value); break;
      case P_MODE: modeKnob_ = value;                          break;
      default: break;
    }
    return FF_SUCCESS;
  }

  FFResult SetTextParameter(unsigned int idx, const char* value) override {
    const char* v = value ? value : "";
    size_t len = strlen(v);

    if (idx == P_BLOB) {
      std::string received(v, len);
      classify_blob_callback("blob", received);
      blob_ = received;
      return FF_SUCCESS;
    }
    if (idx == P_BLOB2) {
      std::string received(v, len);
      bool unchanged = (received == blob2_);
      PROBE_LOG("SetTextParameter",
                "idx=%u (blob2) %s size=%zu head=%s",
                idx,
                unchanged ? "(echo/restore-default)" : "(MUTATED)",
                len, PROBE_REDACT(v, 80).c_str());
      blob2_ = received;
      return FF_SUCCESS;
    }
    PROBE_LOG("SetTextParameter", "idx=%u size=%zu head=%s",
              idx, len, PROBE_REDACT(v).c_str());
    return FF_SUCCESS;
  }

  float GetFloatParameter(unsigned int idx) override {
    float v = 0.0f;
    switch (idx) {
      case P_SIZE: v = sizeKnob_; break;
      case P_MODE: v = modeKnob_; break;
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
    static int blob_poll = 0;
    static int blob2_poll = 0;
    if (idx == P_BLOB) {
      if (blobReturnBuf_.size() <= blob_.size()) {
        blobReturnBuf_.resize(blob_.size() + 1);
      }
      if (!blob_.empty()) {
        memcpy(blobReturnBuf_.data(), blob_.data(), blob_.size());
      }
      blobReturnBuf_[blob_.size()] = '\0';
      if (blob_poll < 32 || (blob_poll % 60) == 0) {
        PROBE_LOG("GetTextParameter",
                  "idx=%u (blob) size=%zu head=%s n=%d",
                  idx, blob_.size(),
                  PROBE_REDACT(blobReturnBuf_.data(), 40).c_str(),
                  blob_poll);
      }
      ++blob_poll;
      return blobReturnBuf_.data();
    }
    if (idx == P_BLOB2) {
      if (blob2ReturnBuf_.size() <= blob2_.size()) {
        blob2ReturnBuf_.resize(blob2_.size() + 1);
      }
      if (!blob2_.empty()) {
        memcpy(blob2ReturnBuf_.data(), blob2_.data(), blob2_.size());
      }
      blob2ReturnBuf_[blob2_.size()] = '\0';
      if (blob2_poll < 32 || (blob2_poll % 60) == 0) {
        PROBE_LOG("GetTextParameter",
                  "idx=%u (blob2) size=%zu head=%s n=%d",
                  idx, blob2_.size(),
                  PROBE_REDACT(blob2ReturnBuf_.data(), 80).c_str(),
                  blob2_poll);
      }
      ++blob2_poll;
      return blob2ReturnBuf_.data();
    }
    smallReturnBuf_[0] = '\0';
    return smallReturnBuf_;
  }

  // -- Render ----------------------------------------------------------
  FFResult ProcessOpenGL(ProcessOpenGLStruct* pGL) override {
    ++frame_;
    PROBE_CTX_FRAME(frame_);

    // Recompute (mode, bucket) — either knob changing invalidates the blob.
    EncodingMode newMode = mode_from_knob(modeKnob_);
    int newBucket = bucket_from_knob(sizeKnob_);

    if (newMode != currentMode_ || newBucket != currentBucket_) {
      PROBE_LOG("PROBE_CHANGE",
                "mode: %s→%s | bucket: %d→%d sizeKnob=%.3f modeKnob=%.3f target=%s (%zu bytes)",
                currentMode_ == (EncodingMode)-1 ? "?" : mode_name(currentMode_),
                mode_name(newMode),
                currentBucket_, newBucket,
                (double)sizeKnob_, (double)modeKnob_,
                kSizeBuckets[newBucket].label, kSizeBuckets[newBucket].bytes);

      currentMode_   = newMode;
      currentBucket_ = newBucket;

      generate_payload(newMode, kSizeBuckets[newBucket].bytes, blob_);
      PROBE_LOG("PROBE_ACTION",
                "regenerated blob mode=%s size=%zu, raising FF_EVENT_FLAG_VALUE on idx=%u",
                mode_name(newMode), blob_.size(), P_BLOB);
      RaiseParamEvent(P_BLOB, FF_EVENT_FLAG_VALUE);
    }

    // Save/reload prompt: when sizeKnob crosses > 0.95 (effectively
    // 16MB bucket), nudge the user toward saving the comp.
    if (sizeKnob_ > 0.95f && !saveMarkerEmitted_) {
      PROBE_LOG("PROBE_MARKER",
                ">>> SAVE composition, QUIT Resolume, RELAUNCH, REOPEN now.");
      PROBE_LOG("PROBE_MARKER",
                ">>> On reload check blob size_match/body_match AND that blob2's marker survived.");
      saveMarkerEmitted_ = true;
    }
    if (sizeKnob_ <= 0.95f) saveMarkerEmitted_ = false;

    drawPassthroughAndBadge(pGL);
    return FF_SUCCESS;
  }

 private:
  void classify_blob_callback(const char* tag, const std::string& received) {
    if (received == blob_) {
      PROBE_LOG("SetTextParameter",
                "idx=%u (%s echo) size=%zu head=%s",
                P_BLOB, tag, received.size(),
                PROBE_REDACT(received.c_str(), 40).c_str());
      return;
    }
    ParsedHeader hdr = parse_header(received.c_str());
    if (hdr.recognized) {
      // Could be a save/reload restore from a previous session, or
      // mid-session bucket-change roundtrip we somehow missed.
      VerifyResult vr = verify_against_canonical(hdr.mode, hdr.size, received);
      PROBE_LOG("SetTextParameter",
                "idx=%u (%s restore) mode=%s hdr_size=%zu recv=%zu size_match=%d body_match=%d first_diff=%lld head=%s",
                P_BLOB, tag, mode_name(hdr.mode), hdr.size, received.size(),
                vr.size_match ? 1 : 0,
                vr.body_match ? 1 : 0,
                vr.first_diff_offset == SIZE_MAX
                    ? (long long)-1
                    : (long long)vr.first_diff_offset,
                PROBE_REDACT(received.c_str(), 40).c_str());
      // Adopt mode + bucket so the next ProcessOpenGL doesn't redundantly
      // regenerate.
      int b = bucket_for_size(hdr.size);
      if (b >= 0) {
        currentMode_ = hdr.mode;
        currentBucket_ = b;
        PROBE_LOG("PROBE_RESTORE",
                  "adopted mode=%s bucket=%d (%s)",
                  mode_name(hdr.mode), b, kSizeBuckets[b].label);
      }
    } else if (received.empty()) {
      PROBE_LOG("SetTextParameter",
                "idx=%u (%s empty) — host pushed empty default or user cleared",
                P_BLOB, tag);
    } else {
      // Doesn't parse and isn't empty — very likely the user clicked
      // Browse and selected a real file. This is the "CLOBBER" case
      // we need to know about.
      PROBE_LOG("SetTextParameter",
                "idx=%u (%s CLOBBER?) size=%zu head=%s — looks like a user Browse pick",
                P_BLOB, tag, received.size(),
                PROBE_REDACT(received.c_str(), 80).c_str());
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

    // Orange badge — probe1 magenta, probe2 cyan, probe3 orange.
    const int bx = (int)(W * 0.85f);
    const int by = (int)(H * 0.85f);
    const int bw = (int)(W * 0.12f);
    const int bh = (int)(H * 0.12f);
    glEnable(GL_SCISSOR_TEST);
    glScissor(bx, by, bw, bh);
    glClearColor(1.0f, 0.55f - 0.2f * sizeKnob_, 0.1f * modeKnob_, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
  }

  // -- State -----------------------------------------------------------
  float             sizeKnob_      = 0.0f;
  float             modeKnob_      = 0.0f;
  std::string       blob_;
  std::string       blob2_;
  std::vector<char> blobReturnBuf_;
  std::vector<char> blob2ReturnBuf_;
  char              smallReturnBuf_[64]{};

  int          currentBucket_       = -1;
  EncodingMode currentMode_         = (EncodingMode)-1;
  bool         saveMarkerEmitted_   = false;

  int    frame_  = 0;
  GLuint srcFbo_ = 0;
};

// ============================================================================
static CFFGLPluginInfo PluginInfo(
    PluginFactory<NanoProbe3Plugin>,
    "NPB3",
    "NanoProbe3",
    2, 1,
    1, 0,
    FF_EFFECT,
    "FFGL probe v3 — FF_TYPE_FILE as data carrier",
    "nano");
