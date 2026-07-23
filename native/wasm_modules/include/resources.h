#pragma once
/*
 * resources.h — the host RESOURCES surface (import module "resources").
 *
 * A resource is an ASSET the host owns — today: a clip's playable media;
 * later: binary files, static images, audio. A stream (streams.h) is a
 * TRANSPORT VIEW of a resource: resources_stream(res) fetches the seekable
 * stream behind a stream-backed resource. Future kinds add data/texture views
 * on the SAME handle namespace by appending ops — never new handle schemes.
 *
 * Handles are identity-derived i64s exactly like stream handles (disjoint
 * identity domain — "res:clip:<id>"), STABLE across document edits,
 * recompiles, and sessions: cache them, store them in state JSON (as
 * unsigned-decimal strings — they exceed 2^53), pass them over rails
 * (schema type "resource"). A handle whose asset vanished simply describes
 * as ResInvalid.
 *
 * Host twins: native/src/sketch/comp/streams_table.h (resource section) ↔
 * web/src/streams-registry.ts — enum VALUES are shared ABI.
 */

#include <cstdint>

// --- Raw C imports ---
extern "C" {
  // ── Scoping ──
  // THIS clip's content resource (the media the clip plays). 0 when the clip
  // has none (effect-only clip, standalone sketch).
  __attribute__((import_module("resources"), import_name("content")))
  int64_t resources_content(void);
  // The resource of the clip currently LIVE on a scene track (h = the scene
  // track's STREAM handle). 0 when idle / not a scene track / no media.
  __attribute__((import_module("resources"), import_name("live")))
  int64_t resources_live(int64_t track_stream);
  // The resource of the clip at grid ordinal N on a track stream (scene or
  // timeline). 0 when out of range / the clip has no media.
  __attribute__((import_module("resources"), import_name("clip_at")))
  int64_t resources_clip_at(int64_t track_stream, int32_t ordinal);

  // ── Introspection ──
  // Sized-descriptor fill (module_api.h convention): returns 1 and fills on a
  // live handle; returns 0 (and writes kind = ResInvalid) otherwise.
  __attribute__((import_module("resources"), import_name("describe")))
  int32_t resources_describe(int64_t res, void* desc);
  // Change token for this resource's static data — mirrors the underlying
  // stream's rev for stream-backed resources. Compare, don't interpret.
  __attribute__((import_module("resources"), import_name("rev")))
  int32_t resources_rev(int64_t res);
  // The seekable-stream view (every streams.h op applies to the result).
  // 0 when the resource is not stream-backed.
  __attribute__((import_module("resources"), import_name("stream")))
  int64_t resources_stream(int64_t res);

  // ── Fork (owner-controlled successor instance) ──
  // Declares THIS instance the standing fork owner of the resource's live
  // playback on its track. LEVEL-TRIGGERED like streams.announce: re-assert
  // every tick; the host expires an arm not re-asserted within ~0.5 s. When
  // the track commits a launch to a DIFFERENT clip, the outgoing playback is
  // moved into the fork — same stream handle, same decode, same effect
  // instances — now advancing under this owner's control (streams.seek on the
  // returned handle re-times it; streams.stop releases it). Returns the fork
  // STREAM handle (== resources_stream(res)) when accepted, 0 otherwise
  // (non-forkable resource, or its clip is not the track's live scene).
  __attribute__((import_module("resources"), import_name("fork")))
  int64_t resources_fork(int64_t res);

  // ── RESERVED (documented, not yet provided by hosts) ──
  //   int64_t resources_data_size(int64_t res);          // byte view (files)
  //   int32_t resources_read(int64_t res, int64_t off, void* buf, int32_t cap);
  //   int32_t resources_texture(int64_t res);            // texture view (images)
}

// --- C++ wrappers ---
namespace resources {

using Resource = int64_t;

inline constexpr Resource kInvalid = 0;

enum Kind : int32_t {
  ResInvalid = 0,      // handle resolves to nothing (stale / absent)
  ResClipContent = 1,  // a clip's playable media
  ResFile = 2,         // RESERVED: raw binary asset
  ResImage = 3,        // RESERVED: static image
  ResAudio = 4,        // RESERVED: audio asset
};

enum Flags : int32_t {
  kHasStream = 1 << 0,   // resources_stream() answers non-zero
  kHasData = 1 << 1,     // RESERVED: byte view available
  kHasTexture = 1 << 2,  // RESERVED: texture view available
  kForkable = 1 << 3,    // resources_fork() accepted
};

/**
 * Resource descriptor — SIZED-STRUCT convention (module_api.h): set
 * struct_size to sizeof(ResourceDesc) before the call; the host fills
 * min(sent, known) bytes and your defaults survive for anything newer than it
 * knows. Grows by APPEND only. 8-byte fields sit at 8-aligned offsets.
 */
struct ResourceDesc {
  int32_t struct_size = static_cast<int32_t>(sizeof(ResourceDesc));
  int32_t kind = ResInvalid;
  int32_t flags = 0;
  int32_t rev = 0;
  int64_t stream = 0;       // the seekable-stream view handle; 0 = none
  int64_t size_bytes = -1;  // byte size; -1 = unknown / N-A
  double duration_sec = -1; // playable duration; -1 = N/A
  int32_t width = 0;        // pixel dimensions; 0 = N/A
  int32_t height = 0;
  int32_t reserved0 = 0;
  int32_t reserved1 = 0;
  int32_t reserved2 = 0;
  int32_t reserved3 = 0;
};
static_assert(sizeof(ResourceDesc) == 64, "ResourceDesc grows by append only");

inline Resource content() { return resources_content(); }
inline Resource live(int64_t trackStream) { return resources_live(trackStream); }
inline Resource clipAt(int64_t trackStream, int ordinal) {
  return resources_clip_at(trackStream, ordinal);
}
inline bool describe(Resource r, ResourceDesc& d) {
  d.struct_size = static_cast<int32_t>(sizeof(ResourceDesc));
  return resources_describe(r, &d) != 0;
}
inline int rev(Resource r) { return resources_rev(r); }
inline int64_t stream(Resource r) { return resources_stream(r); }
inline int64_t fork(Resource r) { return resources_fork(r); }

}  // namespace resources
