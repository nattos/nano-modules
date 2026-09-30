// video_encoder_win.cpp — VideoEncoder on Windows, over Media Foundation's sink
// writer: the twin of video_encoder.mm (AVAssetWriter). H.264 in MP4, a
// keyframe about every two seconds, the requested (or derived) bitrate, tagged
// BT.709 so a player's YUV→RGB matches the conversion here.
//
// Frames go in as NV12 converted HERE with the BT.709 matrix (video range): fed
// RGB32, the sink writer inserts a converter that ignores the BT.709 tags and
// uses BT.601 — decoded back, pure green came out 216 and red picked up 25 of
// green. WriteSample queues, so append() returns once the writer has taken the
// frame — memory stays bounded by MF's own queue.

#include "video_encoder.h"

#include <initguid.h>
#include <windows.h>
#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "media/mf_util.h"
#include "platform/paths.h"

namespace nano_media {
namespace {

template <typename T>
struct Com {
  T* p = nullptr;
  ~Com() { reset(); }
  void reset() { if (p) { p->Release(); p = nullptr; } }
  T** put() { reset(); return &p; }
  T* operator->() const { return p; }
  explicit operator bool() const { return p != nullptr; }
};

std::string hr(const char* what, HRESULT h) {
  char buf[96];
  std::snprintf(buf, sizeof buf, "%s (0x%08lx)", what, (unsigned long)h);
  return buf;
}

/// RGBA8 (full range, BT.709 primaries) → NV12, BT.709 matrix, video range.
/// Chroma is the 2×2 block's average. `w` and `h` are even.
void rgbaToNv12(const uint8_t* rgba, int w, int h, uint8_t* nv12) {
  uint8_t* yPlane = nv12;
  uint8_t* uv = nv12 + (size_t)w * h;
  const auto clamp8 = [](double v) { return (uint8_t)std::clamp((int)std::lround(v), 0, 255); };
  for (int y = 0; y < h; y++) {
    const uint8_t* s = rgba + (size_t)y * w * 4;
    for (int x = 0; x < w; x++, s += 4) {
      yPlane[(size_t)y * w + x] =
          clamp8(16.0 + (0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]) * (219.0 / 255.0));
    }
  }
  for (int y = 0; y < h; y += 2) {
    for (int x = 0; x < w; x += 2) {
      double r = 0, g = 0, b = 0;
      for (int dy = 0; dy < 2; dy++) {
        const uint8_t* s = rgba + ((size_t)(y + dy) * w + x) * 4;
        r += s[0] + s[4]; g += s[1] + s[5]; b += s[2] + s[6];
      }
      r *= 0.25; g *= 0.25; b *= 0.25;
      uint8_t* d = uv + (size_t)(y / 2) * w + x;
      d[0] = clamp8(128.0 + (-0.1146 * r - 0.3854 * g + 0.5 * b) * (224.0 / 255.0));   // Cb
      d[1] = clamp8(128.0 + (0.5 * r - 0.4542 * g - 0.0458 * b) * (224.0 / 255.0));    // Cr
    }
  }
}

/// BT.709 throughout: primaries, transfer, matrix, and video (16-235) range.
void tag709(IMFMediaType* t) {
  t->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
  t->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
  t->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
}

}  // namespace

struct VideoEncoder::Impl {
  Com<IMFSinkWriter> writer;
  DWORD stream = 0;
  Config cfg;
  LONGLONG frameHns = 0;
  bool finished = false;
};

VideoEncoder::VideoEncoder() : impl_(std::make_unique<Impl>()) {}

VideoEncoder::~VideoEncoder() {
  if (impl_->writer && !impl_->finished) cancel();
}

bool VideoEncoder::open(const Config& cfg) {
  Impl& m = *impl_;
  m.cfg = cfg;
  if (cfg.width <= 0 || cfg.height <= 0 || cfg.fps <= 0 || (cfg.width | cfg.height) & 1) {
    error_ = "bad export size or rate";
    return false;
  }
  if (!ensureMediaFoundation()) { error_ = "Media Foundation unavailable"; return false; }
  DeleteFileW(nano_paths::widen(cfg.path).c_str());

  Com<IMFAttributes> attrs;
  MFCreateAttributes(attrs.put(), 2);
  attrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
  attrs->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4);
  HRESULT h = MFCreateSinkWriterFromURL(nano_paths::widen(cfg.path).c_str(), nullptr, attrs.p,
                                        m.writer.put());
  if (FAILED(h)) { error_ = hr(("can't create " + cfg.path).c_str(), h); return false; }

  const int64_t bitrate = cfg.bitrate > 0
      ? cfg.bitrate
      : std::max<int64_t>(1'000'000, (int64_t)std::llround(cfg.width * cfg.height * cfg.fps * 0.12));
  // Rational frame rate: fps × 1000 / 1000, as the macOS encoder's timescale.
  const UINT32 rateNum = (UINT32)std::lround(cfg.fps * 1000), rateDen = 1000;
  m.frameHns = (LONGLONG)std::llround(1e7 / cfg.fps);

  Com<IMFMediaType> out;
  MFCreateMediaType(out.put());
  out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  out->SetUINT32(MF_MT_AVG_BITRATE, (UINT32)std::min<int64_t>(bitrate, 0xffffffffll));
  out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  out->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
  MFSetAttributeSize(out.p, MF_MT_FRAME_SIZE, (UINT32)cfg.width, (UINT32)cfg.height);
  MFSetAttributeRatio(out.p, MF_MT_FRAME_RATE, rateNum, rateDen);
  MFSetAttributeRatio(out.p, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  out->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
  tag709(out.p);
  h = m.writer->AddStream(out.p, &m.stream);
  if (FAILED(h)) { error_ = hr("the H.264 encoder refused these settings", h); return false; }

  Com<IMFMediaType> in;
  MFCreateMediaType(in.put());
  in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  in->SetUINT32(MF_MT_DEFAULT_STRIDE, (UINT32)cfg.width);
  MFSetAttributeSize(in.p, MF_MT_FRAME_SIZE, (UINT32)cfg.width, (UINT32)cfg.height);
  MFSetAttributeRatio(in.p, MF_MT_FRAME_RATE, rateNum, rateDen);
  MFSetAttributeRatio(in.p, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  in->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
  tag709(in.p);
  // Encoder properties ride here (the output type's MF_MT_MAX_KEYFRAME_SPACING
  // is ignored): a keyframe about every two seconds, as the web exporter does.
  Com<IMFAttributes> enc;
  MFCreateAttributes(enc.put(), 1);
  enc->SetUINT32(CODECAPI_AVEncMPVGOPSize, (UINT32)std::max(1, (int)std::lround(cfg.fps * 2)));
  h = m.writer->SetInputMediaType(m.stream, in.p, enc.p);
  if (FAILED(h)) { error_ = hr("the H.264 encoder takes no NV12 input", h); return false; }
  h = m.writer->BeginWriting();
  if (FAILED(h)) { error_ = hr("BeginWriting", h); return false; }
  return true;
}

bool VideoEncoder::append(const uint8_t* rgba, int index) {
  Impl& m = *impl_;
  if (!m.writer || m.finished) { error_ = "encoder not open"; return false; }
  const int w = m.cfg.width, ht = m.cfg.height;
  const DWORD bytes = (DWORD)w * ht * 3 / 2;
  Com<IMFMediaBuffer> buf;
  HRESULT h = MFCreateMemoryBuffer(bytes, buf.put());
  if (FAILED(h)) { error_ = hr("MFCreateMemoryBuffer", h); return false; }
  BYTE* dst = nullptr;
  if (FAILED(buf->Lock(&dst, nullptr, nullptr))) { error_ = "buffer lock failed"; return false; }
  rgbaToNv12(rgba, w, ht, dst);
  buf->Unlock();
  buf->SetCurrentLength(bytes);

  Com<IMFSample> sample;
  MFCreateSample(sample.put());
  sample->AddBuffer(buf.p);
  sample->SetSampleTime((LONGLONG)index * m.frameHns);
  sample->SetSampleDuration(m.frameHns);
  h = m.writer->WriteSample(m.stream, sample.p);
  if (FAILED(h)) { error_ = hr("append", h); return false; }
  return true;
}

bool VideoEncoder::finish() {
  Impl& m = *impl_;
  if (!m.writer || m.finished) return false;
  m.finished = true;
  const HRESULT h = m.writer->Finalize();
  m.writer.reset();
  if (FAILED(h)) { error_ = hr("finish", h); return false; }
  return true;
}

void VideoEncoder::cancel() {
  Impl& m = *impl_;
  if (!m.writer || m.finished) return;
  m.finished = true;
  m.writer.reset();  // without Finalize: the file is incomplete — remove it
  DeleteFileW(nano_paths::widen(m.cfg.path).c_str());
}

}  // namespace nano_media
