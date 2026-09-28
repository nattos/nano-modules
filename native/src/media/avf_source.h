// avf_source.h — macOS frame sources over AVFoundation and ImageIO.
//
// The classes live in avf_source.mm (their members are Objective-C objects);
// these factories are the plain-C++ way in. See frame_source.h.

#pragma once

#include <memory>
#include <string>

#include "frame_source.h"

namespace nano_media {

/// A still image (anything ImageIO reads) as a 1-frame, straight-alpha RGBA8
/// source — the twin of web's ImageFrameSource (createImageBitmap +
/// copyExternalImageToTexture, which un-premultiplies). Null + `*error` when
/// ImageIO doesn't recognise the file.
std::unique_ptr<FrameSource> openImageFrameSource(const std::string& path, std::string* error);

/// A video track AVFoundation can decode (H.264, HEVC, ProRes, ...), decoded
/// to BGRA8. `open` decodes the first frame, so a file AVFoundation parses but
/// can't decode is refused here rather than failing every pull.
std::unique_ptr<FrameSource> openAvfVideoSource(const std::string& path, std::string* error);

}  // namespace nano_media
