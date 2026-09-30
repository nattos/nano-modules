// video_encoder_win.cpp — VideoEncoder on Windows: not yet.
//
// Media Foundation's IMFSinkWriter is the twin of AVAssetWriter here (M4 step 5
// in COMPOSITOR.md). Until then an export is refused at open with a sentence
// the page can show, rather than failing somewhere inside the render.

#include "video_encoder.h"

namespace nano_media {

struct VideoEncoder::Impl {};

VideoEncoder::VideoEncoder() = default;
VideoEncoder::~VideoEncoder() = default;

bool VideoEncoder::open(const Config&) {
  error_ = "MP4 export isn't available on Windows yet";
  return false;
}
bool VideoEncoder::append(const uint8_t*, int) { return false; }
bool VideoEncoder::finish() { return false; }
void VideoEncoder::cancel() {}

}  // namespace nano_media
