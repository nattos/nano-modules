// mf_source.cpp — video on Windows, over Media Foundation's source reader
// (mf_source.h). The twin of AvfVideoSource in avf_source.mm, and built the
// same way:
//
//   - The source reader is a forward-only stream, so random access is built on
//     it: a pull at or just past the reader's position reads FORWARD (playback,
//     read-ahead), no seek; anything else seeks to that frame's time. MF lands
//     on the preceding keyframe and decodes from there, handing back the
//     earlier frames too, which are skipped — slow on a sparse-keyframe file,
//     but EXACT.
//   - A frame's index is its presentation time (from the first frame's) × fps,
//     rounded — frame N is the one on screen at N/fps.
//   - Hardware decode and colour conversion (DXVA) on a PRIVATE D3D11 device
//     MF owns (mfDevice()), never the engine's: sharing ours would need it
//     multithread-protected, and the engine assumes it isn't. Software MF was
//     10x slower than AVFoundation on a seek (231 ms vs 23), enough to miss a
//     primed follow launch. Without a usable device it falls back to software.
//   - CPU output: the reader converts to RGB32, prepare() reads it back and
//     repacks it tightly as BGRA8 with an opaque alpha (RGB32's fourth byte is
//     undefined), and upload() is one writeTexture.

#include "mf_source.h"

#include <initguid.h>  // first: the MF GUIDs are defined here, not in an mfuuid lib
#include <windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <d3d11.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "gpu/gpu_backend.h"
#include "platform/paths.h"

namespace nano_media {
namespace {

constexpr int32_t kFmtBGRA8 = 0;
constexpr double kHns = 1e7;  // MF time: 100 ns units

double nowMs() {
  using clock = std::chrono::steady_clock;
  return std::chrono::duration<double, std::milli>(clock::now().time_since_epoch()).count();
}

template <typename T>
struct Com {
  T* p = nullptr;
  Com() = default;
  Com(const Com& o) : p(o.p) { if (p) p->AddRef(); }
  Com& operator=(const Com& o) {
    if (this != &o) { reset(); p = o.p; if (p) p->AddRef(); }
    return *this;
  }
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

/// COM + MF for the process, once, and never torn down (like the runtime
/// itself). open() and prepare() run on the pump's decode threads, which come
/// and go: CoIncrementMTAUsage keeps the multithreaded apartment alive for all
/// of them without a per-thread init — and a per-thread teardown is exactly
/// what can't be done, since thread-exit destructors run under the loader lock
/// and MFShutdown/CoUninitialize there deadlock.
bool ensureMf() {
  static const bool ok = [] {
    CO_MTA_USAGE_COOKIE cookie{};
    CoIncrementMTAUsage(&cookie);
    return SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_LITE));
  }();
  return ok;
}

/// The D3D11 device MF decodes on, shared by every source, or null (software
/// MF). Its own device on the default adapter — the one the engine takes too —
/// multithread-protected, as MF drives it from its own threads.
IMFDXGIDeviceManager* mfDevice() {
  static IMFDXGIDeviceManager* mgr = [] () -> IMFDXGIDeviceManager* {
    if (const char* e = std::getenv("NANO_MF_SOFTWARE"); e && *e == '1') return nullptr;
    using CreateFn = HRESULT(WINAPI*)(IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT,
                                      const D3D_FEATURE_LEVEL*, UINT, UINT, ID3D11Device**,
                                      D3D_FEATURE_LEVEL*, ID3D11DeviceContext**);
    HMODULE d3d = LoadLibraryA("d3d11.dll");
    auto create = d3d ? (CreateFn)GetProcAddress(d3d, "D3D11CreateDevice") : nullptr;
    if (!create) return nullptr;
    ID3D11Device* dev = nullptr;
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    if (FAILED(create(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                      D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                      levels, 2, D3D11_SDK_VERSION, &dev, nullptr, nullptr))) {
      std::fprintf(stderr, "[mf] no D3D11 video device: decoding in software\n");
      return nullptr;
    }
    ID3D10Multithread* mt = nullptr;
    if (SUCCEEDED(dev->QueryInterface(__uuidof(ID3D10Multithread), reinterpret_cast<void**>(&mt)))) {
      mt->SetMultithreadProtected(TRUE);
      mt->Release();
    }
    UINT token = 0;
    IMFDXGIDeviceManager* m = nullptr;
    if (FAILED(MFCreateDXGIDeviceManager(&token, &m)) || FAILED(m->ResetDevice(dev, token))) {
      if (m) m->Release();
      dev->Release();
      std::fprintf(stderr, "[mf] no DXGI device manager: decoding in software\n");
      return nullptr;
    }
    dev->Release();  // the manager holds it
    return m;
  }();
  return mgr;
}

/// "avc1" for H.264 as on macOS; otherwise the subtype's FOURCC.
std::string codecName(const GUID& sub) {
  if (sub == MFVideoFormat_H264) return "avc1";
  if (sub == MFVideoFormat_HEVC) return "hvc1";
  char s[5] = {(char)(sub.Data1 & 0xff), (char)((sub.Data1 >> 8) & 0xff),
               (char)((sub.Data1 >> 16) & 0xff), (char)((sub.Data1 >> 24) & 0xff), 0};
  for (char& c : s) if (c && (c < 32 || c > 126)) c = '?';
  return s;
}

/// A decoded frame: its pixels, already BGRA8 and tightly packed.
struct MfFrame : DecodedFrame {
  std::vector<uint8_t> pixels;
};

class MfVideoSource : public FrameSource {
 public:
  bool open(const std::string& path) {
    if (!ensureMf()) { error_ = "MFStartup failed"; return false; }
    Com<IMFAttributes> attrs;
    MFCreateAttributes(attrs.put(), 4);
    if (attrs) {
      if (IMFDXGIDeviceManager* mgr = mfDevice()) {
        attrs->SetUnknown(MF_SOURCE_READER_D3D_MANAGER, mgr);
        attrs->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE);
        attrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
        attrs->SetUINT32(MF_LOW_LATENCY, TRUE);
      } else {
        attrs->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
      }
    }
    HRESULT h = MFCreateSourceReaderFromURL(nano_paths::widen(path).c_str(), attrs.p, reader_.put());
    if (FAILED(h)) { error_ = hr("not a media file", h); return false; }
    reader_->SetStreamSelection((DWORD)MF_SOURCE_READER_ALL_STREAMS, FALSE);
    h = reader_->SetStreamSelection((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE);
    if (FAILED(h)) { error_ = "no video track"; return false; }

    Com<IMFMediaType> native;
    h = reader_->GetNativeMediaType((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, native.put());
    if (FAILED(h)) { error_ = "no video track"; return false; }
    GUID sub{};
    native->GetGUID(MF_MT_SUBTYPE, &sub);
    codec_ = codecName(sub);
    UINT32 num = 0, den = 0;
    if (SUCCEEDED(MFGetAttributeRatio(native.p, MF_MT_FRAME_RATE, &num, &den)) && num && den) {
      fps_ = (double)num / (double)den;
    }
    if (!(fps_ > 0)) { error_ = "video track has no frame rate"; return false; }

    Com<IMFMediaType> want;
    MFCreateMediaType(want.put());
    want->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    want->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    h = reader_->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, want.p);
    if (FAILED(h)) { error_ = hr(("no RGB32 conversion for " + codec_).c_str(), h); return false; }
    if (!readOutputType()) return false;

    PROPVARIANT dur;
    PropVariantInit(&dur);
    double durSec = 0;
    if (SUCCEEDED(reader_->GetPresentationAttribute((DWORD)MF_SOURCE_READER_MEDIASOURCE,
                                                    MF_PD_DURATION, &dur)) && dur.vt == VT_UI8) {
      durSec = (double)dur.uhVal.QuadPart / kHns;
      durHns_ = (LONGLONG)dur.uhVal.QuadPart;
    }
    PropVariantClear(&dur);

    // Decode frame 0 now: its timestamp is the origin every index counts from
    // (an MP4's first PTS need not be 0), and a track MF lists but can't
    // decode fails HERE, where the pump names it, not on every pull.
    atEnd_ = false;
    Com<IMFSample> first;
    LONGLONG ts = 0;
    if (!nextSample(first, ts)) { if (error_.empty()) error_ = "no decodable frame"; return false; }
    origin_ = ts;
    frameCount_ = std::max(1, (int)std::lround(durSec * fps_));
    setLast(first, 0);
    return w_ > 0 && h_ > 0;
  }

  uint32_t width() const override { return w_; }
  uint32_t height() const override { return h_; }
  int frameCount() const override { return frameCount_; }
  double fps() const override { return fps_; }
  std::string codec() const override { return codec_; }
  int32_t formatCode() const override { return kFmtBGRA8; }
  const std::string& error() const override { return error_; }

  std::unique_ptr<DecodedFrame> prepare(int idx) override {
    if (idx < 0 || idx >= frameCount_) { error_ = "frame index out of range"; return nullptr; }
    if (!ensureMf()) { error_ = "MFStartup failed"; return nullptr; }
    const double t0 = nowMs();
    Com<IMFSample> s = frameAt(idx);
    if (!s) { if (error_.empty()) error_ = "decode failed"; return nullptr; }
    auto f = std::make_unique<MfFrame>();
    if (!pack(s.p, f->pixels)) return nullptr;
    f->index = idx;
    f->prepareMs = nowMs() - t0;
    return f;
  }

  bool upload(gpu::GPUBackend* backend, const DecodedFrame& frame, int32_t tex) override {
    const auto& px = static_cast<const MfFrame&>(frame).pixels;
    if (px.size() != (size_t)w_ * h_ * 4) return false;
    backend->writeTexture(tex, w_, h_, px.data(), (uint32_t)px.size());
    return true;
  }

 private:
  /// The output type as negotiated: its size and row stride (RGB32 is often
  /// bottom-up — a negative stride).
  bool readOutputType() {
    Com<IMFMediaType> cur;
    HRESULT h = reader_->GetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, cur.put());
    if (FAILED(h)) { error_ = hr("GetCurrentMediaType", h); return false; }
    UINT32 w = 0, ht = 0;
    MFGetAttributeSize(cur.p, MF_MT_FRAME_SIZE, &w, &ht);
    if (!w || !ht) { error_ = "video has no dimensions"; return false; }
    if (w_ == 0) { w_ = w; h_ = ht; }  // the first frame's size is the source's
    frameW_ = w;
    frameH_ = ht;
    UINT32 stride = 0;
    if (SUCCEEDED(cur->GetUINT32(MF_MT_DEFAULT_STRIDE, &stride))) {
      stride_ = (LONG)(INT32)stride;
    } else {
      LONG s = 0;
      stride_ = SUCCEEDED(MFGetStrideForBitmapInfoHeader(MFVideoFormat_RGB32.Data1, w, &s)) ? s : (LONG)w * 4;
    }
    return true;
  }

  /// The next sample the reader delivers, with its timestamp. False at the end
  /// of the stream (error_ untouched) or on a failure (error_ set).
  bool nextSample(Com<IMFSample>& out, LONGLONG& ts) {
    for (;;) {
      if (atEnd_) return false;
      DWORD stream = 0, flags = 0;
      out.reset();
      HRESULT h = reader_->ReadSample((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &stream,
                                      &flags, &ts, out.put());
      if (FAILED(h)) { error_ = hr("ReadSample", h); return false; }
      if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) {
        if (!readOutputType()) return false;
      }
      if (flags & MF_SOURCE_READERF_ERROR) { error_ = "stream error"; return false; }
      // The last sample may come WITH the end-of-stream flag: keep it.
      if (flags & MF_SOURCE_READERF_ENDOFSTREAM) atEnd_ = true;
      if (out) return true;
      if (atEnd_) return false;  // (no sample: a gap/tick — keep reading)
    }
  }

  int indexOf(LONGLONG ts) const {
    return (int)std::lround((double)(ts - origin_) / kHns * fps_);
  }

  /// Frames past the reader's position a pull may read forward through rather
  /// than seek — about a second, well inside any keyframe interval a seek
  /// would have to decode through anyway.
  int forwardWindow() const { return std::max(30, (int)std::ceil(fps_)); }

  Com<IMFSample> frameAt(int idx) {
    if (last_ && lastIdx_ == idx) return last_;
    const bool forward = !atEnd_ && idx > lastIdx_ && idx - lastIdx_ <= forwardWindow();
    if (!forward && !seek(idx)) return {};
    return readForward(idx);
  }

  /// Read until the frame on screen at `idx`, keeping the one past it (if we
  /// overshoot a gap) for the next call.
  Com<IMFSample> readForward(int idx) {
    for (;;) {
      Com<IMFSample> s = pending_;
      int si = pendingIdx_;
      pending_.reset();
      if (!s) {
        LONGLONG ts = 0;
        if (!nextSample(s, ts)) {
          // End of stream: the tail frame holds (a duration rounding up past
          // the last sample); anything else is a real failure.
          if (!error_.empty()) return {};
          return last_ && lastIdx_ < idx ? last_ : Com<IMFSample>{};
        }
        si = indexOf(ts);
      }
      if (si > idx && last_ && lastIdx_ < idx) {
        // `idx` has no sample of its own: the previous one is still on screen.
        pending_ = s;
        pendingIdx_ = si;
        return last_;
      }
      setLast(s, si);
      if (si >= idx) return last_;
    }
  }

  /// Reposition half a frame BEFORE the target: MF lands on the keyframe at or
  /// before the position and decodes on from there, and readForward skips up
  /// to the exact index — so early is harmless, while a position past the
  /// stream's reported end (the last frame, aimed a quarter frame in as
  /// AVFoundation needs) is MF_E_OUT_OF_RANGE.
  bool seek(int idx) {
    pending_.reset();
    last_.reset();
    lastIdx_ = -1;
    atEnd_ = false;
    error_.clear();
    PROPVARIANT pos;
    PropVariantInit(&pos);
    pos.vt = VT_I8;
    LONGLONG at = origin_ + (LONGLONG)std::llround(std::max(0.0, (idx - 0.5) / fps_) * kHns);
    // And never past what MF calls the end: the duration doesn't include the
    // first frame's presentation offset (B-frames), so the last frames' times
    // can lie beyond it.
    if (durHns_ > 0) at = std::min(at, std::max<LONGLONG>(0, durHns_ - (LONGLONG)std::llround(kHns / fps_)));
    pos.hVal.QuadPart = at;
    const HRESULT h = reader_->SetCurrentPosition(GUID{}, pos)  /* GUID_NULL: 100 ns units */;
    PropVariantClear(&pos);
    if (FAILED(h)) { error_ = hr("SetCurrentPosition", h); return false; }
    return true;
  }

  void setLast(const Com<IMFSample>& s, int si) {
    last_ = s;
    lastIdx_ = si;
  }

  /// A sample's pixels → tightly packed BGRA8, opaque.
  bool pack(IMFSample* s, std::vector<uint8_t>& out) {
    Com<IMFMediaBuffer> buf;
    HRESULT h = s->ConvertToContiguousBuffer(buf.put());
    if (FAILED(h)) { error_ = hr("ConvertToContiguousBuffer", h); return false; }
    out.assign((size_t)w_ * h_ * 4, 0);
    const uint32_t w = std::min(w_, frameW_), ht = std::min(h_, frameH_);
    const size_t row = (size_t)w_ * 4;
    Com<IMF2DBuffer> b2;
    BYTE* scan0 = nullptr;
    LONG pitch = 0;
    BYTE* base = nullptr;
    DWORD len = 0;
    const bool is2d = SUCCEEDED(buf->QueryInterface(IID_IMF2DBuffer, reinterpret_cast<void**>(b2.put()))) &&
                      SUCCEEDED(b2->Lock2D(&scan0, &pitch));
    if (!is2d) {
      h = buf->Lock(&base, nullptr, &len);
      if (FAILED(h)) { error_ = hr("Lock", h); return false; }
      // Row 0 of the IMAGE: at the end of the buffer when the stride is negative.
      pitch = stride_;
      scan0 = pitch < 0 ? base + (size_t)(-pitch) * (frameH_ - 1) : base;
    }
    for (uint32_t y = 0; y < ht; y++) {
      const BYTE* src = scan0 + (ptrdiff_t)pitch * y;
      uint8_t* dst = &out[y * row];
      std::memcpy(dst, src, (size_t)w * 4);
      for (uint32_t x = 0; x < w; x++) dst[x * 4 + 3] = 255;
    }
    if (is2d) b2->Unlock2D(); else buf->Unlock();
    return true;
  }

  Com<IMFSourceReader> reader_;
  LONGLONG origin_ = 0;
  LONGLONG durHns_ = 0;
  bool atEnd_ = false;
  Com<IMFSample> last_;
  int lastIdx_ = -1;
  Com<IMFSample> pending_;
  int pendingIdx_ = -1;

  uint32_t w_ = 0, h_ = 0;           // the source's size (the first frame's)
  uint32_t frameW_ = 0, frameH_ = 0; // the current output type's
  LONG stride_ = 0;
  double fps_ = 0;
  int frameCount_ = 0;
  std::string codec_;
  std::string error_;
};

}  // namespace

std::unique_ptr<FrameSource> openMfVideoSource(const std::string& path, std::string* error) {
  auto s = std::make_unique<MfVideoSource>();
  if (s->open(path)) return s;
  if (error) *error = s->error();
  return nullptr;
}

}  // namespace nano_media
