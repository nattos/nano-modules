// image_source.h — a still image as a 1-frame video source.
//
// One per platform: avf_source.mm over ImageIO on macOS, wic_source.cpp over
// WIC on Windows.

#pragma once

#include <memory>
#include <string>

#include "frame_source.h"

namespace nano_media {

/// A still image (PNG, JPEG, ...) as a 1-frame, straight-alpha RGBA8 source —
/// the twin of web's ImageFrameSource (createImageBitmap +
/// copyExternalImageToTexture, which un-premultiplies). Frame 0 only: an
/// animated GIF shows its first frame, as on web. Null + `*error` when the
/// platform's decoder doesn't recognise the file.
std::unique_ptr<FrameSource> openImageFrameSource(const std::string& path, std::string* error);

}  // namespace nano_media
