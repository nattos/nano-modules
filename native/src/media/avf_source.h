// avf_source.h — the macOS video source over AVFoundation (stills: image_source.h,
// which avf_source.mm implements over ImageIO).
//
// The classes live in avf_source.mm (their members are Objective-C objects);
// these factories are the plain-C++ way in. See frame_source.h.

#pragma once

#include <memory>
#include <string>

#include "frame_source.h"
#include "image_source.h"

namespace nano_media {

/// A video track AVFoundation can decode (H.264, HEVC, ProRes, ...), decoded
/// to BGRA8. `open` decodes the first frame, so a file AVFoundation parses but
/// can't decode is refused here rather than failing every pull.
std::unique_ptr<FrameSource> openAvfVideoSource(const std::string& path, std::string* error);

}  // namespace nano_media
