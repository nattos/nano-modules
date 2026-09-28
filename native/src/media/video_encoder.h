// video_encoder.h — H.264 MP4 encoding for the native exporter.
//
// The twin of export-renderer.ts's WebCodecs VideoEncoder + mp4-muxer: frames
// in (RGBA8, already composited over the backdrop), an MP4 out, a keyframe
// about every two seconds, the bitrate the export settings asked for. On macOS
// it is AVAssetWriter, so the encode runs on the media engine (VideoToolbox).
//
// HOST ONLY.

#pragma once

#include <cstdint>
#include <memory>
#include <string>

namespace nano_media {

class VideoEncoder {
 public:
  struct Config {
    std::string path;  ///< output .mp4 (replaced if it exists)
    int width = 0;     ///< even
    int height = 0;    ///< even
    double fps = 30;
    int64_t bitrate = 0;  ///< bits/s; 0 = derived (0.12 bpp)
  };

  VideoEncoder();
  ~VideoEncoder();
  VideoEncoder(const VideoEncoder&) = delete;
  VideoEncoder& operator=(const VideoEncoder&) = delete;

  /// False + error() when the file can't be created or the settings are refused.
  bool open(const Config& cfg);
  /// Append frame `index` (RGBA8, width*height*4 bytes). Blocks while the
  /// encoder is saturated, so memory stays flat.
  bool append(const uint8_t* rgba, int index);
  /// Finish the file (writes the index). Blocks until it's on disk.
  bool finish();
  /// Abandon: stop writing and delete the partial file.
  void cancel();

  const std::string& error() const { return error_; }

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  std::string error_;
};

}  // namespace nano_media
