// media_fetch.h — turn a clip's url into a file the decoders can open.
//
// A document's runtime url is usually a PATH by the time it reaches the pump
// (the host resolver maps file.abs / library refs; see comp_media_resolver.h).
// What's left are urls only the editor's page can read: a browser document's
// media served by the dev server (`/media/clip.mp4`, which every e2e fixture
// uses) or any http(s) url. Those resolve against the editor's page url (the
// `mediaBase` its comp_reset carries) and are downloaded once per process into
// a temporary cache.
//
// blob: urls can't be fetched from outside the page that minted them; they
// stay unresolved and the pump names the clip as skipped.
//
// HOST ONLY.

#pragma once

#include <string>

namespace nano_media {

/**
 * A local path for `url`: an existing file path or file:// url as is; http(s),
 * or a relative url when `base` is given, downloaded (once per process). On
 * failure returns "" and sets `*error`.
 */
std::string localMediaPath(const std::string& url, const std::string& base, std::string* error);

}  // namespace nano_media
