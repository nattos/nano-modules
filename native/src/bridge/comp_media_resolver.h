// comp_media_resolver.h — installs the comp document model's media hook.
//
// `clip.source.url` is runtime-only (an object URL the web store rebuilds, and
// `serializeComposition` strips it), so a `.nano-arr` read off disk carries
// only the portable `clip.source.ref = {libraryId, path[]}` binding. Without
// this, every video clip in such a document parses as effect-only: no video
// desc, no content stream, nothing for a pump to decode.
//
// The comp model can't do the lookup itself — it is dual-compiled into
// executor.wasm, which has no filesystem — so it takes a resolver from the
// host (comp::setMediaRefResolver). This is that host half, kept out of
// src/sketch/comp/ for exactly that reason.
//
// The resolver hands back an ABSOLUTE PATH, not a URL: the native pump opens
// files, it doesn't fetch. Web keeps handing the engine a blob: url and never
// installs a resolver at all.

#pragma once

#include <string>

#include <nlohmann/json.hpp>

#include "library_paths.h"
#include "../sketch/comp/comp_model.h"

namespace nano_assets {

/**
 * Point the comp document model at the library roots. Call once at host
 * startup, before any document is parsed.
 *
 * Resolution is against LibraryPaths' CURRENT roots, so a document parsed
 * before the roots arrive resolves to nothing — reload it once they land
 * (BarrelRuntime persists them to a sidecar precisely so a headless restart
 * has them up front).
 */
inline void installLibraryMediaResolver() {
  comp::setMediaRefResolver([](const nlohmann::json& ref) -> std::string {
    auto path = LibraryPaths::instance().resolveRef(ref);
    return path ? *path : std::string();
  });
}

}  // namespace nano_assets
