// frame_source.h — the native twin of web/src/video/frame-source.ts.
//
// "Decode frame N into this texture, here are your dimensions." The pump's
// cache, classifier and read-ahead stay codec-agnostic behind it; each codec
// is one implementation:
//
//   DxvSource        (dxv_source.h)  DXV3 via the reused wasm demuxer + BC1 blit
//   AvfVideoSource   (avf_source.mm) everything AVFoundation decodes (H.264,
//                                    HEVC, ProRes, ...)
//   MfVideoSource    (mf_source.cpp) everything Media Foundation decodes, on
//                                    Windows (H.264, HEVC with the extension, ...)
//   ImageFrameSource (image_source.h: avf_source.mm over ImageIO, wic_source.cpp
//                    over WIC) a still (PNG, JPEG, ...) as a 1-frame video
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

/// One frame's CPU-side decode result (FrameSource::prepare), waiting for its
/// GPU upload. Each source subclasses it with whatever it holds (BC1 bytes, a
/// retained pixel buffer).
struct DecodedFrame {
  virtual ~DecodedFrame() = default;
  int index = -1;
  /// Milliseconds the CPU half took.
  double prepareMs = 0;
  /// Compressed payload, for the cost tracker's size EWMA; 0 = not exposed.
  uint32_t payloadBytes = 0;
};

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

  /**
   * The CPU half of a decode: read and decompress frame `idx`. Touches no GPU,
   * so it may run on a decode thread — one call at a time per source, but
   * concurrently with upload(). Null on failure; error() says why (read it on
   * the same thread).
   */
  virtual std::unique_ptr<DecodedFrame> prepare(int idx) = 0;
  /// The GPU half: write a prepared frame into `outTexHandle` (from the same
  /// backend, sized width() × height(), formatCode()). The backend's thread.
  virtual bool upload(gpu::GPUBackend* backend, const DecodedFrame& frame,
                      int32_t outTexHandle) = 0;

  virtual const std::string& error() const = 0;

  /// prepare + upload, synchronously.
  bool decode(gpu::GPUBackend* backend, int idx, int32_t outTexHandle);
  /// Milliseconds the last decode() took, both halves — the cost tracker's input.
  double lastDecodeMs() const { return lastDecodeMs_; }

 private:
  double lastDecodeMs_ = 0;
};

/**
 * Open `path` with the first decoder that takes it: DXV (the codec tag), then
 * a still image, then the platform's video decoder (AVFoundation / Media
 * Foundation). Null with `*error` naming every refusal
 * when nothing can.
 */
std::unique_ptr<FrameSource> openFrameSource(const std::string& path, std::string* error);

}  // namespace nano_media
