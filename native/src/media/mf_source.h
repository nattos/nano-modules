// mf_source.h — the Windows video source over Media Foundation (the twin of
// avf_source.h). The class lives in mf_source.cpp; this factory is the way in.
// See frame_source.h.

#pragma once

#include <memory>
#include <string>

#include "frame_source.h"

namespace nano_media {

/// A video track Media Foundation can decode (H.264, HEVC with the system
/// extension, MJPEG, ...), decoded to BGRA8. `open` decodes the first frame,
/// so a file MF parses but can't decode is refused here rather than failing
/// every pull.
std::unique_ptr<FrameSource> openMfVideoSource(const std::string& path, std::string* error);

}  // namespace nano_media
