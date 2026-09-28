// frame_source.h — the native twin of web/src/video/frame-source.ts.
//
// "Decode frame N into this texture, here are your dimensions." The pump's
// cache, classifier and read-ahead stay codec-agnostic behind it; each codec
// is one implementation:
//
//   DxvSource        (dxv_source.h)  DXV3 via the reused wasm demuxer + BC1 blit
//   AvfVideoSource   (avf_source.mm) everything AVFoundation decodes (H.264,
//                                    HEVC, ProRes, ...)
//   ImageFrameSource (avf_source.mm) a still (PNG, JPEG, ...) as a 1-frame video
//
// Every source here is RANDOM ACCESS — there is no `streaming` flavour as on
// web. A browser <video> can't seek a sparse-keyframe clip in real time, so the
// web samples it live; AVFoundation decodes forward from the preceding keyframe
// on a seek, which is slow but exact, and the pump reads forward sequentially
// without a seek for the common case.
//
// HOST ONLY. Never include from src/sketch/comp/.

#pragma once

#include <cstdint>
#include <memory>
#include <string>

namespace gpu { class GPUBackend; }

namespace nano_media {

class FrameSource {
 public:
  virtual ~FrameSource() = default;

  virtual uint32_t width() const = 0;
  virtual uint32_t height() const = 0;
  virtual int frameCount() const = 0;
  /// The container's frame rate, or 0 = unknown (the pump then uses the
  /// document's probed `fps`).
  virtual double fps() const = 0;
  /// Codec id for telemetry and errors ("DXD3", "avc1", "image:png", ...).
  virtual std::string codec() const = 0;
  /// TextureFormat code the decoded frames are written as — what the cache
  /// allocates. The pump's blit samples it, so BGRA and RGBA both work.
  virtual int32_t formatCode() const = 0;

  /// Decode frame `idx` into `outTexHandle` (from the same backend, sized
  /// width() × height(), formatCode()). False on failure; error() says why.
  virtual bool decode(gpu::GPUBackend* backend, int idx, int32_t outTexHandle) = 0;

  /// Milliseconds the last decode() took — the cost tracker's input.
  virtual double lastDecodeMs() const = 0;
  /// Compressed payload of a frame, for the cost tracker's size EWMA; 0 when
  /// the codec doesn't expose it.
  virtual uint32_t payloadBytes(int idx) const { (void)idx; return 0; }

  virtual const std::string& error() const = 0;
};

/**
 * Open `path` with the first decoder that takes it: DXV (the codec tag), then
 * a still image, then AVFoundation. Null with `*error` naming every refusal
 * when nothing can.
 */
std::unique_ptr<FrameSource> openFrameSource(const std::string& path, std::string* error);

}  // namespace nano_media
