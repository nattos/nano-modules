#include "video_encoder.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>

#include <unistd.h>

#include <cmath>
#include <cstring>

namespace nano_media {

struct VideoEncoder::Impl {
  AVAssetWriter* writer = nil;
  AVAssetWriterInput* input = nil;
  AVAssetWriterInputPixelBufferAdaptor* adaptor = nil;
  Config cfg;
  NSURL* url = nil;
  bool finished = false;
};

VideoEncoder::VideoEncoder() : impl_(std::make_unique<Impl>()) {}

VideoEncoder::~VideoEncoder() {
  if (impl_->writer && !impl_->finished) cancel();
}

bool VideoEncoder::open(const Config& cfg) {
  @autoreleasepool {
    Impl& m = *impl_;
    m.cfg = cfg;
    if (cfg.width <= 0 || cfg.height <= 0 || cfg.fps <= 0) {
      error_ = "bad export size or rate";
      return false;
    }
    m.url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:cfg.path.c_str()]];
    [[NSFileManager defaultManager] removeItemAtURL:m.url error:nil];
    NSError* err = nil;
    m.writer = [[AVAssetWriter alloc] initWithURL:m.url fileType:AVFileTypeMPEG4 error:&err];
    if (!m.writer) {
      error_ = std::string("can't create ") + cfg.path + ": " + err.localizedDescription.UTF8String;
      return false;
    }
    const int64_t bitrate = cfg.bitrate > 0
        ? cfg.bitrate
        : std::max<int64_t>(1'000'000, (int64_t)std::llround(cfg.width * cfg.height * cfg.fps * 0.12));
    NSDictionary* settings = @{
      AVVideoCodecKey : AVVideoCodecTypeH264,
      AVVideoWidthKey : @(cfg.width),
      AVVideoHeightKey : @(cfg.height),
      AVVideoCompressionPropertiesKey : @{
        AVVideoAverageBitRateKey : @(bitrate),
        AVVideoExpectedSourceFrameRateKey : @(cfg.fps),
        // A keyframe about every two seconds, as the web exporter does.
        AVVideoMaxKeyFrameIntervalKey : @(std::max(1, (int)std::lround(cfg.fps * 2))),
        AVVideoProfileLevelKey : AVVideoProfileLevelH264HighAutoLevel,
      },
      // Tagged BT.709 (what an HD player assumes) so the RGB→YUV conversion
      // here and a decoder's YUV→RGB agree; untagged, saturated colours come
      // back ~10% dull.
      AVVideoColorPropertiesKey : @{
        AVVideoColorPrimariesKey : AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey : AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey : AVVideoYCbCrMatrix_ITU_R_709_2,
      },
    };
    if (![m.writer canApplyOutputSettings:settings forMediaType:AVMediaTypeVideo]) {
      error_ = "the H.264 encoder refused these settings";
      return false;
    }
    m.input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                                  outputSettings:settings];
    m.input.expectsMediaDataInRealTime = NO;
    m.adaptor = [AVAssetWriterInputPixelBufferAdaptor
        assetWriterInputPixelBufferAdaptorWithAssetWriterInput:m.input
                                   sourcePixelBufferAttributes:@{
                                     (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
                                     (id)kCVPixelBufferWidthKey : @(cfg.width),
                                     (id)kCVPixelBufferHeightKey : @(cfg.height),
                                   }];
    [m.writer addInput:m.input];
    if (![m.writer startWriting]) {
      error_ = std::string("startWriting: ") + m.writer.error.localizedDescription.UTF8String;
      return false;
    }
    [m.writer startSessionAtSourceTime:kCMTimeZero];
    return true;
  }
}

bool VideoEncoder::append(const uint8_t* rgba, int index) {
  @autoreleasepool {
    Impl& m = *impl_;
    if (!m.writer || m.finished) { error_ = "encoder not open"; return false; }
    // Backpressure: the input drains as the media engine encodes.
    while (!m.input.readyForMoreMediaData) {
      if (m.writer.status != AVAssetWriterStatusWriting) break;
      usleep(1000);
    }
    if (m.writer.status != AVAssetWriterStatusWriting) {
      error_ = std::string("encoder stopped: ") +
               (m.writer.error ? m.writer.error.localizedDescription.UTF8String : "unknown");
      return false;
    }
    CVPixelBufferRef pb = nullptr;
    if (!m.adaptor.pixelBufferPool ||
        CVPixelBufferPoolCreatePixelBuffer(nullptr, m.adaptor.pixelBufferPool, &pb) != kCVReturnSuccess) {
      error_ = "no pixel buffer";
      return false;
    }
    CVPixelBufferLockBaseAddress(pb, 0);
    uint8_t* dst = (uint8_t*)CVPixelBufferGetBaseAddress(pb);
    const size_t stride = CVPixelBufferGetBytesPerRow(pb);
    const int w = m.cfg.width, h = m.cfg.height;
    for (int y = 0; y < h; y++) {
      const uint8_t* s = rgba + (size_t)y * w * 4;
      uint8_t* d = dst + (size_t)y * stride;
      for (int x = 0; x < w; x++, s += 4, d += 4) {
        d[0] = s[2]; d[1] = s[1]; d[2] = s[0]; d[3] = 255;   // RGBA → BGRA, opaque
      }
    }
    CVPixelBufferUnlockBaseAddress(pb, 0);
    // The frames are sRGB-encoded BT.709-primaries RGB; say so, or the writer
    // leaves the file's colour untagged whatever the output settings ask.
    CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey,
                          kCVImageBufferColorPrimaries_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey,
                          kCVImageBufferTransferFunction_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey,
                          kCVImageBufferYCbCrMatrix_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    // Rational frame times: index / fps exactly, for fractional rates too.
    const int32_t scale = (int32_t)std::lround(m.cfg.fps * 1000);
    const CMTime pts = CMTimeMake((int64_t)index * 1000, scale);
    const BOOL ok = [m.adaptor appendPixelBuffer:pb withPresentationTime:pts];
    CVPixelBufferRelease(pb);
    if (!ok) {
      error_ = std::string("append: ") +
               (m.writer.error ? m.writer.error.localizedDescription.UTF8String : "refused");
      return false;
    }
    return true;
  }
}

bool VideoEncoder::finish() {
  @autoreleasepool {
    Impl& m = *impl_;
    if (!m.writer || m.finished) return false;
    m.finished = true;
    [m.input markAsFinished];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [m.writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    if (m.writer.status != AVAssetWriterStatusCompleted) {
      error_ = std::string("finish: ") +
               (m.writer.error ? m.writer.error.localizedDescription.UTF8String : "unknown");
      return false;
    }
    return true;
  }
}

void VideoEncoder::cancel() {
  @autoreleasepool {
    Impl& m = *impl_;
    if (!m.writer || m.finished) return;
    m.finished = true;
    [m.writer cancelWriting];
    [[NSFileManager defaultManager] removeItemAtURL:m.url error:nil];
  }
}

}  // namespace nano_media
