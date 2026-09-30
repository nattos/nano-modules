// mf_util.h — Media Foundation plumbing shared by the Windows decoder
// (mf_source.cpp) and encoder (video_encoder_win.cpp).

#pragma once

namespace nano_media {

/// COM + MF for the whole process, started once and never torn down (see the
/// definition in mf_source.cpp for why). False when MF is unavailable.
bool ensureMediaFoundation();

}  // namespace nano_media
