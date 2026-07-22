#pragma once
/*
 * streams.h — the seekable-streams host surface (import module "streams").
 *
 * Every time-based thing the host knows about is modeled as a STREAM behind an
 * opaque i64 handle: the arrangement timeline, each timeline/scene track, and
 * each clip's content (video source; sequence interiors later). Handles are
 * identity-derived and STABLE across document edits, recompiles, and sessions
 * — cache them freely; a stale handle simply describes as KindInvalid. Streams
 * whose data changed are detected via rev(): poll that one i32 per frame and
 * re-read descriptors/events only on change (the zero-per-frame-JSON pattern).
 *
 * Time axes: every stream declares a PRIMARY axis (seconds / beats / ordinal).
 * pos()/duration() are in primary-axis units; pos_sec()/duration_sec() are
 * always additionally available.
 *
 * Events. TRACK streams: the ordered clip start/stop list in primary-axis
 * units, static per rev(). On a stream flagged TriggerOnSeek, moving the
 * transport onto a start event's time triggers that clip — literally for
 * scene tracks, effectively for timeline (and later sequence) clips.
 * CONTENT streams: the semantic transport TIMELINE — 'looped' (one full pass
 * of the source slice; record carries the 1-based pass count) and 'ended'
 * (exactly the standard clip duration — when the engine's one-shot auto-stop
 * fires). Times are on the ELAPSED axis (streams_elapsed: seconds since the
 * clip's anchor; BEATS for beat-sync clips), the list holds past edges AND
 * predicted future ones: entries with time > elapsed(h) are upcoming hints
 * ("clip will end in 1s" = next 'ended' minus elapsed). The list is VIRTUAL
 * and index-stable — event_count may grow as time passes at a FIXED rev();
 * rev bumps only when the generator changes (relaunch, config edit, a
 * controller revising its declared future). Random play mode has no
 * boundaries — fall back to clip_duration. A driven clip's events come from
 * its controller's declarations instead of the built-in analytics.
 *
 * Host-side twin: native/src/sketch/comp/streams_table.h — enum VALUES and the
 * event record layout are shared ABI; the record layout is version-gated
 * (NANO_ABI_VERSION, module_api.h).
 */

#include <cstdint>

// --- Raw C imports ---
extern "C" {
  // ── Scoping ──
  // The stream that carries THIS effect's clip: the timeline track containing
  // it (its parent transport), the scene track for a scene's effects, or —
  // outside any arrangement (standalone sketch) — the session clock.
  __attribute__((import_module("streams"), import_name("parent")))
  int64_t streams_parent(void);
  // This clip's CONTENT stream (the video source / future sequence interior a
  // transport-controller effect drives). 0 when the clip has no time-based
  // content (effect-only clip, standalone sketch).
  __attribute__((import_module("streams"), import_name("content")))
  int64_t streams_content(void);
  // The arrangement root (transport) stream. 0 outside comp mode.
  __attribute__((import_module("streams"), import_name("timeline")))
  int64_t streams_timeline(void);

  // ── Enumeration: [session clock, timeline, tracks in document order] ──
  // (content streams are NOT enumerated — reach them via streams_content.)
  __attribute__((import_module("streams"), import_name("count")))
  int32_t streams_count(void);
  __attribute__((import_module("streams"), import_name("at")))
  int64_t streams_at(int32_t index);
  // Display name (track/clip name; "" for clocks). Copies min(cap, len) bytes,
  // returns the FULL length (grow-and-retry, comp_api convention).
  __attribute__((import_module("streams"), import_name("name")))
  int32_t streams_name(int64_t h, char* buf, int32_t cap);

  // ── Descriptor (sized struct — see streams::StreamDesc below) ──
  // Returns 1 and fills the descriptor on a live handle; returns 0 (and writes
  // kind = KindInvalid) when the handle resolves to nothing.
  __attribute__((import_module("streams"), import_name("describe")))
  int32_t streams_describe(int64_t h, void* desc);
  // PER-STREAM revision of this stream's static data / event GENERATOR
  // (descriptor fields, event timeline shape, declared future). Bumps on doc
  // (re)load, scene (re)launch/stop, and declaration revisions — never merely
  // because time passed. A per-host change token: compare for inequality,
  // don't interpret the value. THE per-frame poll.
  __attribute__((import_module("streams"), import_name("rev")))
  int32_t streams_rev(int64_t h);

  // ── Hot path: flat scalars, callable every tick ──
  // Position on the stream's PRIMARY axis: beats for timeline/tracks, seconds
  // for content, ordinal for scene tracks (floor = active scene ordinal,
  // fraction = launch progress; NaN when nothing is launched). Content-stream
  // positions reflect the host-APPLIED content time (a transport controller's
  // own published time round-trips back with one frame of latency).
  __attribute__((import_module("streams"), import_name("pos")))
  double streams_pos(int64_t h);
  // Position in SECONDS regardless of axis (timeline: warp-correct transport
  // seconds). NaN when undefined (idle scene track).
  __attribute__((import_module("streams"), import_name("pos_sec")))
  double streams_pos_sec(int64_t h);
  // 1 while the stream's transport runs (session clock: always 1).
  __attribute__((import_module("streams"), import_name("playing")))
  int32_t streams_playing(int64_t h);
  // Active loop region on the primary axis: returns 1 and writes out2[0]=start,
  // out2[1]=end, or 0 (out untouched). Timeline/tracks: the loop brace;
  // content: the effective source slice of a looping play mode.
  __attribute__((import_module("streams"), import_name("loop")))
  int32_t streams_loop(int64_t h, double* out2);
  // Duration on the primary axis / in seconds; -1 = infinite/unknown/live.
  __attribute__((import_module("streams"), import_name("duration")))
  double streams_duration(int64_t h);
  __attribute__((import_module("streams"), import_name("duration_sec")))
  double streams_duration_sec(int64_t h);
  // Tempo governing this stream (doc baseBPM today; per-sequence tempo later).
  __attribute__((import_module("streams"), import_name("bpm")))
  double streams_bpm(int64_t h);
  // Native frame rate for video content streams; 0 when N/A.
  __attribute__((import_module("streams"), import_name("fps")))
  double streams_fps(int64_t h);
  // CONTENT streams: where this content sits on its PARENT's primary axis
  // (the clip's start beat; a scene's launch beat). NaN for non-content
  // streams. anchor_sec = the same instant in warp-correct parent seconds —
  // `parent posSec − anchor_sec` is the clip-local elapsed time the built-in
  // play modes integrate (clip_time.h elapsedSec).
  __attribute__((import_module("streams"), import_name("anchor")))
  double streams_anchor(int64_t h);
  __attribute__((import_module("streams"), import_name("anchor_sec")))
  double streams_anchor_sec(int64_t h);
  // "Now" on the stream's EVENT axis: elapsed since anchor for content streams
  // (seconds; BEATS for beat-sync clips — always the unit content event times
  // use), posSec for track/timeline streams, session seconds for the clock.
  // NaN when undefined (idle scene track). Compare directly with event times.
  __attribute__((import_module("streams"), import_name("elapsed")))
  double streams_elapsed(int64_t h);

  // ── Per-clip queries on TRACK streams (ordinal = grid position) ──
  // STANDARD clip duration in seconds: what the engine's one-shot auto-stop
  // waits — a video scene's source slice ÷ |speed|; an effect-only scene's
  // lengthBeat at the base tempo (warp-approximate — scenes are launch-
  // anchored, warp segments are timeline-derived). NaN for a bad ordinal /
  // non-track stream. Transport-section effects may override it (a looping
  // controller effectively makes it infinite; a follower substitutes its own).
  __attribute__((import_module("streams"), import_name("clip_duration")))
  double streams_clip_duration(int64_t h, int32_t ordinal);
  // The clip's GRID slot (scene tracks: startBeat / bar length — contiguous
  // integers form a Live-style follow GROUP). NaN for bad ordinal/stream.
  __attribute__((import_module("streams"), import_name("clip_grid")))
  double streams_clip_grid(int64_t h, int32_t ordinal);

  // ── Write verbs (queued; applied by the host after the transport pre-pass,
  // landing next frame — the same latency as trigger-ring launches) ──
  // On a kTriggerOnSeek stream: trigger the clip whose start event covers
  // time t (scene tracks: ordinal floor(t) — launches it, evicting the
  // track's current scene). Returns 1 when queued, 0 for an invalid handle /
  // non-seek-triggerable stream. Bypassed/empty targets are dropped at apply
  // time (same matcher as trigger launches). `cls` is the launch deadline
  // class: 0 = instant (commit now, flash or not — a played stab), 1 = loose
  // (the handover may LINGER on the outgoing scene while the incoming video
  // warms; the transport-effect default).
  __attribute__((import_module("streams"), import_name("seek")))
  int32_t streams_seek(int64_t h, double t, int32_t cls);
  // Stop the playing clip on a scene track (the track leaves the composite).
  __attribute__((import_module("streams"), import_name("stop")))
  int32_t streams_stop(int64_t h);

  // ── Events (index-stable; tracks static per rev(), content may GROW) ──
  __attribute__((import_module("streams"), import_name("event_count")))
  int32_t streams_event_count(int64_t h);
  // Copy up to cap_events records starting at `first` (0-based) into out[],
  // 5 doubles per event. Returns records written; 0 when first >= count; -1 on
  // an invalid handle. Record layout (VERSION-GATED, ABI 3):
  //   [0] time         — track streams: primary-axis units;
  //                      content streams: the ELAPSED axis (streams_elapsed)
  //   [1] kind         — 0 = start, 1 = stop, 2 = looped, 3 = ended
  //   [2] clipOrdinal  — start/stop: index into the grid-ordered clip list
  //                      (pairs a start with its stop); looped: 1-based pass
  //                      count
  //   [3] clipIdHash48 — low 48 bits of FNV-1a64(clip.id), exact in f64
  //   [4] channel      — scene trigger channel; NaN for non-scene streams
  __attribute__((import_module("streams"), import_name("read_events")))
  int32_t streams_read_events(int64_t h, int32_t first, double* out, int32_t cap_events);
  // Index of the first event with time >= t (== event_count past the end) —
  // position a cursor without copying the whole list.
  __attribute__((import_module("streams"), import_name("event_lower_bound")))
  int32_t streams_event_lower_bound(int64_t h, double t);
}

// --- C++ wrappers ---
namespace streams {

using Stream = int64_t;

inline constexpr Stream kInvalid = 0;
inline constexpr Stream kSessionClock = 1;  // always exists

enum Kind : int32_t {
  KindInvalid = 0,          // handle resolves to nothing (stale / absent)
  KindSessionClock = 1,     // wall-clock pseudo-stream
  KindTimeline = 2,         // the arrangement root transport
  KindTimelineTrack = 3,    // one arrangement track (single lane, has events)
  KindSceneTrack = 4,       // scene track (ordinal axis, trigger-on-seek)
  KindVideoContent = 5,     // a clip's video source
  KindSequenceContent = 6,  // RESERVED: sequence-clip interior
  KindLiveInput = 7,        // RESERVED: live-only capture/feed
};

enum Axis : int32_t { AxisSeconds = 0, AxisBeats = 1, AxisOrdinal = 2 };

enum Flags : int32_t {
  kSeekInstant = 1 << 0,    // random access is cheap (stills, timelines)
  kSeekSlow = 1 << 1,       // seekable but variably slow (<video> decode)
                            // neither seek bit ⇒ NOT seekable
  kLiveOnly = 1 << 2,       // no timeline: position only ever advances
  kHasEvents = 1 << 3,      // event list is non-empty-capable
  kFinite = 1 << 4,         // duration is meaningful (else -1)
  kTriggerOnSeek = 1 << 5,  // transport reaching an event's time triggers it
  kDriven = 1 << 6,         // content driven by a transport-controller effect
};

/**
 * Stream descriptor — SIZED-STRUCT convention (module_api.h): set struct_size
 * to sizeof(StreamDesc) before the call; the host fills min(sent, known) bytes
 * and your defaults survive for anything newer than it knows. Grows by APPEND
 * only (never a version bump). All fields 4-byte scalars, no padding.
 */
struct StreamDesc {
  int32_t struct_size = static_cast<int32_t>(sizeof(StreamDesc));
  int32_t kind = KindInvalid;
  int32_t flags = 0;
  int32_t axis = AxisSeconds;
  int32_t frame_count = 0;   // video content: durationFrames; else 0
  int32_t event_count = 0;
  int32_t doc_rev = 0;       // == streams_rev(h) at fill time
  int32_t index = -1;        // enumeration position; -1 if not enumerated
  int32_t clip_count = 0;    // clips on this stream (tracks)
  int32_t reserved0 = 0;
  int32_t reserved1 = 0;
  int32_t reserved2 = 0;
};
static_assert(sizeof(StreamDesc) == 48, "StreamDesc grows by append only");

enum EventKind : int32_t {
  EvStart = 0,
  EvStop = 1,
  EvLooped = 2,  // one full pass of the source slice; clipOrdinal = pass count
  EvEnded = 3,   // the standard clip duration elapsed (one-shot auto-stop time)
};

/** One event, overlaying the 5-double wire record exactly (all doubles). */
struct Event {
  double time = 0;
  double kind = 0;         // EventKind
  double clipOrdinal = 0;
  double clipIdHash48 = 0;
  double channel = 0;      // NaN for non-scene streams
  bool isStart() const { return kind == EvStart; }
  bool isLooped() const { return kind == EvLooped; }
  bool isEnded() const { return kind == EvEnded; }
};
static_assert(sizeof(Event) == 40, "event record is 5 doubles");

inline Stream parent() { return streams_parent(); }
inline Stream content() { return streams_content(); }
inline Stream timeline() { return streams_timeline(); }
inline int count() { return streams_count(); }
inline Stream at(int i) { return streams_at(i); }

inline bool describe(Stream h, StreamDesc& d) {
  d.struct_size = static_cast<int32_t>(sizeof(StreamDesc));
  return streams_describe(h, &d) != 0;
}
inline int rev(Stream h) { return streams_rev(h); }

inline double pos(Stream h) { return streams_pos(h); }
inline double posSec(Stream h) { return streams_pos_sec(h); }
inline bool playing(Stream h) { return streams_playing(h) != 0; }
inline bool loop(Stream h, double& start, double& end) {
  double o[2];
  if (!streams_loop(h, o)) return false;
  start = o[0];
  end = o[1];
  return true;
}
inline double duration(Stream h) { return streams_duration(h); }
inline double durationSec(Stream h) { return streams_duration_sec(h); }
inline double bpm(Stream h) { return streams_bpm(h); }
inline double fps(Stream h) { return streams_fps(h); }
inline double anchor(Stream h) { return streams_anchor(h); }
inline double anchorSec(Stream h) { return streams_anchor_sec(h); }
inline double elapsed(Stream h) { return streams_elapsed(h); }
inline double clipDuration(Stream h, int ordinal) { return streams_clip_duration(h, ordinal); }
inline double clipGrid(Stream h, int ordinal) { return streams_clip_grid(h, ordinal); }
enum LaunchClass : int32_t { LaunchInstant = 0, LaunchLoose = 1 };

inline bool seek(Stream h, double t, LaunchClass cls = LaunchLoose) {
  return streams_seek(h, t, cls) != 0;
}
inline bool stop(Stream h) { return streams_stop(h) != 0; }

inline int eventCount(Stream h) { return streams_event_count(h); }
inline int readEvents(Stream h, int first, Event* out, int maxCount) {
  return streams_read_events(h, first, reinterpret_cast<double*>(out), maxCount);
}
inline int lowerBound(Stream h, double t) { return streams_event_lower_bound(h, t); }

}  // namespace streams
