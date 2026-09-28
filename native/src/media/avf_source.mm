#include "avf_source.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>

#include <chrono>
#include <cmath>
#include <cstring>
#include <vector>

#include "gpu/gpu_backend.h"

// The synchronous AVAsset property getters are deprecated in favour of async
// `load…` calls, but they still work and this host decodes synchronously.
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

namespace nano_media {
namespace {

constexpr int32_t kFmtBGRA8 = 0;
constexpr int32_t kFmtRGBA8 = 1;

double nowMs() {
  using clock = std::chrono::steady_clock;
  return std::chrono::duration<double, std::milli>(clock::now().time_since_epoch()).count();
}

NSURL* fileUrl(const std::string& path) {
  return [NSURL fileURLWithPath:[NSString stringWithUTF8String:path.c_str()]];
}

// ---------------------------------------------------------------------------
// Stills
// ---------------------------------------------------------------------------

class ImageFrameSource : public FrameSource {
 public:
  bool open(const std::string& path) {
    @autoreleasepool {
      CGImageSourceRef src = CGImageSourceCreateWithURL((__bridge CFURLRef)fileUrl(path), nullptr);
      if (!src) { error_ = "cannot open " + path; return false; }
      CFStringRef type = CGImageSourceGetType(src);
      if (!type || CGImageSourceGetCount(src) == 0) {
        CFRelease(src);
        error_ = "not an image";
        return false;
      }
      codec_ = std::string("image:") + [(__bridge NSString*)type UTF8String];
      // Frame 0 only — an animated GIF shows its first frame, as on web.
      CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, nullptr);
      CFRelease(src);
      if (!img) { error_ = "image decode failed"; return false; }
      w_ = (uint32_t)CGImageGetWidth(img);
      h_ = (uint32_t)CGImageGetHeight(img);
      if (!w_ || !h_) { CGImageRelease(img); error_ = "image has no dimensions"; return false; }

      // Into sRGB RGBA8. CoreGraphics only draws PREMULTIPLIED RGBA8, so undo it
      // afterwards: web's copyExternalImageToTexture leaves alpha straight.
      pixels_.assign((size_t)w_ * h_ * 4, 0);
      CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
      CGContextRef ctx = CGBitmapContextCreate(
          pixels_.data(), w_, h_, 8, (size_t)w_ * 4, cs,
          (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
      CGColorSpaceRelease(cs);
      if (!ctx) { CGImageRelease(img); error_ = "bitmap context failed"; return false; }
      CGContextSetBlendMode(ctx, kCGBlendModeCopy);
      CGContextDrawImage(ctx, CGRectMake(0, 0, w_, h_), img);
      CGContextRelease(ctx);
      CGImageRelease(img);
      for (size_t i = 0; i < pixels_.size(); i += 4) {
        const uint32_t a = pixels_[i + 3];
        if (a == 0 || a == 255) continue;
        for (int c = 0; c < 3; c++) {
          pixels_[i + c] = (uint8_t)std::min<uint32_t>(255, (pixels_[i + c] * 255u + a / 2) / a);
        }
      }
      return true;
    }
  }

  uint32_t width() const override { return w_; }
  uint32_t height() const override { return h_; }
  int frameCount() const override { return 1; }
  double fps() const override { return 0; }
  std::string codec() const override { return codec_; }
  int32_t formatCode() const override { return kFmtRGBA8; }
  const std::string& error() const override { return error_; }

  /// Decoded once at open; the pixels are immutable after, so upload() reads
  /// them from any thread.
  std::unique_ptr<DecodedFrame> prepare(int idx) override {
    if (idx != 0) { error_ = "frame index out of range"; return nullptr; }
    auto f = std::make_unique<DecodedFrame>();
    f->index = 0;
    return f;
  }
  bool upload(gpu::GPUBackend* backend, const DecodedFrame&, int32_t outTexHandle) override {
    backend->writeTexture(outTexHandle, w_, h_, pixels_.data(), (uint32_t)pixels_.size());
    return true;
  }

 private:
  uint32_t w_ = 0, h_ = 0;
  std::string codec_;
  std::vector<uint8_t> pixels_;
  std::string error_;
};

/// A decoded video frame: the pixel buffer, retained until uploaded.
struct AvfFrame : DecodedFrame {
  CVImageBufferRef image = nullptr;
  ~AvfFrame() override { if (image) CVBufferRelease(image); }
};

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/**
 * AVAssetReader is a forward-only stream, so random access is built on it:
 *
 *   - a pull at or just past the reader's position reads FORWARD (the common
 *     case — playback, read-ahead), no seek;
 *   - anything else restarts the reader at that frame's time. AVFoundation
 *     decodes from the preceding keyframe and may hand back earlier frames,
 *     which are skipped — slow on a sparse-keyframe file, but EXACT, which is
 *     the property the web's <video> path can't offer.
 *
 * A frame's index is its presentation time × fps, rounded — so frame N is the
 * one on screen at N/fps, matching the web's seek-to-mid-frame.
 */
class AvfVideoSource : public FrameSource {
 public:
  ~AvfVideoSource() override { reset(); }

  bool open(const std::string& path) {
    @autoreleasepool {
      asset_ = [AVURLAsset URLAssetWithURL:fileUrl(path)
                                   options:@{AVURLAssetPreferPreciseDurationAndTimingKey : @YES}];
      NSArray<AVAssetTrack*>* tracks = [asset_ tracksWithMediaType:AVMediaTypeVideo];
      if (tracks.count == 0) { error_ = "no video track"; return false; }
      track_ = tracks.firstObject;
      fps_ = track_.nominalFrameRate;
      if (!(fps_ > 0)) { error_ = "video track has no frame rate"; return false; }
      origin_ = track_.timeRange.start;
      const double durSec = CMTimeGetSeconds(track_.timeRange.duration);
      frameCount_ = std::max(1, (int)std::lround(durSec * fps_));

      CMFormatDescriptionRef fmt = (__bridge CMFormatDescriptionRef)track_.formatDescriptions.firstObject;
      if (fmt) {
        const FourCharCode sub = CMFormatDescriptionGetMediaSubType(fmt);
        char s[5] = {(char)(sub >> 24), (char)(sub >> 16), (char)(sub >> 8), (char)sub, 0};
        codec_ = s;
      }

      // Decode frame 0 now: the decoded size is the truth (naturalSize can
      // disagree by a clean aperture), and a track AVFoundation lists but can't
      // decode fails HERE, where the pump names it, not on every pull.
      if (!restart(0)) return false;
      CMSampleBufferRef first = readForward(0);
      if (!first) { if (error_.empty()) error_ = "no decodable frame"; return false; }
      CVImageBufferRef img = CMSampleBufferGetImageBuffer(first);
      w_ = (uint32_t)CVPixelBufferGetWidth(img);
      h_ = (uint32_t)CVPixelBufferGetHeight(img);
      return w_ > 0 && h_ > 0;
    }
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
    @autoreleasepool {
      const double t0 = nowMs();
      CMSampleBufferRef s = frameAt(idx);
      if (!s) { if (error_.empty()) error_ = "decode failed"; return nullptr; }
      CVImageBufferRef img = CMSampleBufferGetImageBuffer(s);
      if (!img) { error_ = "sample has no image"; return nullptr; }
      auto f = std::make_unique<AvfFrame>();
      f->image = CVBufferRetain(img);
      f->index = idx;
      f->payloadBytes = (uint32_t)CMSampleBufferGetTotalSampleSize(s);
      f->prepareMs = nowMs() - t0;
      return f;
    }
  }

  bool upload(gpu::GPUBackend* backend, const DecodedFrame& frame, int32_t tex) override {
    CVImageBufferRef img = static_cast<const AvfFrame&>(frame).image;
    CVPixelBufferLockBaseAddress(img, kCVPixelBufferLock_ReadOnly);
    const uint8_t* base = (const uint8_t*)CVPixelBufferGetBaseAddress(img);
    const size_t stride = CVPixelBufferGetBytesPerRow(img);
    const uint32_t w = std::min<uint32_t>(w_, (uint32_t)CVPixelBufferGetWidth(img));
    const uint32_t h = std::min<uint32_t>(h_, (uint32_t)CVPixelBufferGetHeight(img));
    const bool ok = base != nullptr;
    if (ok) {
      const size_t row = (size_t)w_ * 4;
      if (stride == row && w == w_ && h == h_) {
        backend->writeTexture(tex, w_, h_, base, (uint32_t)(row * h_));
      } else {
        // Row padding (or a frame smaller than the first): repack tightly.
        std::vector<uint8_t> packed(row * h_, 0);
        for (uint32_t y = 0; y < h; y++) std::memcpy(&packed[y * row], base + y * stride, (size_t)w * 4);
        backend->writeTexture(tex, w_, h_, packed.data(), (uint32_t)packed.size());
      }
    }
    CVPixelBufferUnlockBaseAddress(img, kCVPixelBufferLock_ReadOnly);
    return ok;
  }

 private:
  /// Frames past the reader's position a pull may read forward through rather
  /// than restart — about a second, well inside any keyframe interval a
  /// restart would have to decode through anyway.
  int forwardWindow() const { return std::max(30, (int)std::ceil(fps_)); }

  CMSampleBufferRef frameAt(int idx) {
    if (last_ && lastIdx_ == idx) return last_;
    const bool forward = reader_ && reader_.status == AVAssetReaderStatusReading &&
                         idx > lastIdx_ && idx - lastIdx_ <= forwardWindow();
    if (!forward && !restart(idx)) return nullptr;
    return readForward(idx);
  }

  /// Read until the frame on screen at `idx`, keeping the one past it (if we
  /// overshoot a gap) for the next call.
  CMSampleBufferRef readForward(int idx) {
    for (;;) {
      CMSampleBufferRef s = pending_;
      int si = pendingIdx_;
      pending_ = nullptr;
      if (!s) {
        s = [output_ copyNextSampleBuffer];
        if (!s) {
          // End of stream: the tail frame holds (a duration rounding up past
          // the last sample), anything else is a real failure.
          if (reader_.status == AVAssetReaderStatusFailed) {
            error_ = std::string("reader failed: ") +
                     reader_.error.localizedDescription.UTF8String;
          }
          return last_ && lastIdx_ < idx ? last_ : nullptr;
        }
        if (!CMSampleBufferGetImageBuffer(s)) { CFRelease(s); continue; }
        si = indexOf(s);
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

  bool restart(int idx) {
    reset();
    NSError* err = nil;
    reader_ = [[AVAssetReader alloc] initWithAsset:asset_ error:&err];
    if (!reader_) {
      error_ = std::string("AVAssetReader: ") + err.localizedDescription.UTF8String;
      return false;
    }
    NSDictionary* settings = @{
      (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
      (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
      (id)kCVPixelBufferMetalCompatibilityKey : @YES,
    };
    output_ = [[AVAssetReaderTrackOutput alloc] initWithTrack:track_ outputSettings:settings];
    output_.alwaysCopiesSampleData = NO;
    if (![reader_ canAddOutput:output_]) { error_ = "reader refused the track output"; return false; }
    [reader_ addOutput:output_];
    // A quarter frame INTO the target: the reader starts with whichever frame
    // covers the range start and stamps it with that start time, so starting
    // even slightly early hands back frame idx-1 labelled as idx.
    const double startSec = (idx + 0.25) / fps_;
    reader_.timeRange = CMTimeRangeMake(
        CMTimeAdd(origin_, CMTimeMakeWithSeconds(startSec, 90000)), kCMTimePositiveInfinity);
    if (![reader_ startReading]) {
      error_ = std::string("startReading: ") +
               (reader_.error ? reader_.error.localizedDescription.UTF8String : "unknown");
      return false;
    }
    return true;
  }

  void reset() {
    if (reader_) [reader_ cancelReading];
    reader_ = nil;
    output_ = nil;
    if (pending_) CFRelease(pending_);
    pending_ = nullptr;
    if (last_) CFRelease(last_);
    last_ = nullptr;
    lastIdx_ = -1;
  }

  void setLast(CMSampleBufferRef s, int si) {
    if (last_) CFRelease(last_);
    last_ = s;
    lastIdx_ = si;
  }

  int indexOf(CMSampleBufferRef s) const {
    const CMTime pts = CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(s), origin_);
    return (int)std::lround(CMTimeGetSeconds(pts) * fps_);
  }

  AVURLAsset* asset_ = nil;
  AVAssetTrack* track_ = nil;
  AVAssetReader* reader_ = nil;
  AVAssetReaderTrackOutput* output_ = nil;
  CMTime origin_ = kCMTimeZero;

  CMSampleBufferRef last_ = nullptr;
  int lastIdx_ = -1;
  CMSampleBufferRef pending_ = nullptr;
  int pendingIdx_ = -1;

  uint32_t w_ = 0, h_ = 0;
  double fps_ = 0;
  int frameCount_ = 0;
  std::string codec_;
  std::string error_;
};

}  // namespace

std::unique_ptr<FrameSource> openImageFrameSource(const std::string& path, std::string* error) {
  auto s = std::make_unique<ImageFrameSource>();
  if (s->open(path)) return s;
  if (error) *error = s->error();
  return nullptr;
}

std::unique_ptr<FrameSource> openAvfVideoSource(const std::string& path, std::string* error) {
  auto s = std::make_unique<AvfVideoSource>();
  if (s->open(path)) return s;
  if (error) *error = s->error();
  return nullptr;
}

}  // namespace nano_media
