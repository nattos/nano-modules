// streams_table.h — the seekable-streams registry: every time-based thing in
// the composition modeled as a STREAM, keyed by a stable i64 handle. This is
// the host-side data source for the effect-facing `streams` import module
// (wasm_modules/include/streams.h carries the effect-side enum twins — keep
// values identical).
//
// Zero-per-frame-JSON contract: the table is rebuilt only on document load
// (docRev-keyed); the per-frame transport sample (`frame`) is mutated in
// place; content-stream positions are computed LAZILY inside the import
// handlers via clip_time.h — nothing stream-shaped crosses any boundary per
// frame. The web engine worker mirrors the STATIC registry from
// comp_streams_json (fetched on doc-epoch change only).
//
// Handles are identity-derived (FNV-1a 64 of "track:<id>" / "content:<id>",
// MSB forced 1) so effects may cache them across doc edits, recompiles, and
// sessions; a handle whose entity vanished simply describes as KindInvalid.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

#include "clip_time.h"
#include "comp_model.h"
#include "warp_curve.h"

namespace comp {

// ── Enum twins of wasm_modules/include/streams.h (values are ABI) ───────────

enum StreamKind : int32_t {
  kStreamKindInvalid = 0,      // handle resolves to nothing (stale / absent)
  kStreamKindSessionClock = 1, // wall-clock pseudo-stream (always exists)
  kStreamKindTimeline = 2,     // the arrangement root transport
  kStreamKindTimelineTrack = 3,// one arrangement track (single lane, events)
  kStreamKindSceneTrack = 4,   // scene track (ordinal axis, trigger-on-seek)
  kStreamKindVideoContent = 5, // a clip's video source
  kStreamKindSequenceContent = 6,  // RESERVED (M2): sequence-clip interior
  kStreamKindLiveInput = 7,        // RESERVED: live-only capture/feed
};

enum StreamAxis : int32_t {
  kStreamAxisSeconds = 0,
  kStreamAxisBeats = 1,
  kStreamAxisOrdinal = 2,
};

enum StreamFlags : int32_t {
  kStreamSeekInstant = 1 << 0,  // random access is cheap (stills, timelines)
  kStreamSeekSlow = 1 << 1,     // seekable but variably slow (<video> decode)
                                // neither seek bit ⇒ NOT seekable
  kStreamLiveOnly = 1 << 2,     // no timeline: position only ever advances
  kStreamHasEvents = 1 << 3,    // event list is non-empty-capable
  kStreamFinite = 1 << 4,       // duration is meaningful (else -1)
  kStreamTriggerOnSeek = 1 << 5,// transport reaching an event's time TRIGGERS
                                // that clip (literal for scene tracks,
                                // effective for timeline/sequence)
  kStreamDriven = 1 << 6,       // content currently driven by a
                                // transport-controller effect
};

// Reserved handle constants (effect-side twins in streams.h).
inline constexpr int64_t kStreamInvalid = 0;
inline constexpr int64_t kStreamSessionClock = 1;
inline constexpr int64_t kStreamTimeline = 2;

inline uint64_t fnv1a64(const std::string& s) {
  uint64_t h = 14695981039346656037ull;
  for (const char ch : s) {
    h ^= static_cast<uint64_t>(static_cast<unsigned char>(ch));
    h *= 1099511628211ull;
  }
  return h;
}

/** Identity string → handle: MSB forced 1 keeps hashes disjoint from the
 *  reserved constants (0/1/2) and from future low-range resource handles. */
inline int64_t streamHandleOf(const std::string& identity) {
  return static_cast<int64_t>(0x8000000000000000ull |
                              (fnv1a64(identity) & 0x7FFFFFFFFFFFFFFFull));
}

/** Low 48 bits of fnv1a64(clip.id) — exact in an f64 (the event record is
 *  all-doubles); pins clip identity across sessions. */
inline double clipIdHash48(const std::string& clipId) {
  return static_cast<double>(fnv1a64(clipId) & 0xFFFFFFFFFFFFull);
}

/**
 * One clip start/stop event. VERSION-GATED wire layout (NANO_ABI_VERSION):
 * effects read it as 5 doubles [time, kind, clipOrdinal, clipIdHash48,
 * channel] — see streams.h read_events.
 */
struct StreamEvent {
  /** Track streams: primary-axis units (beats / ordinal). CONTENT streams: the
   *  ELAPSED axis — units of streams_elapsed (seconds since anchor; BEATS for
   *  beat-sync clips, whose boundaries are beat-locked). */
  double time = 0;
  int32_t kind = 0;  // 0 = start, 1 = stop, 2 = looped, 3 = ended
  /** Track streams: index into the GRID-ordered clip list (pairs a start with
   *  its stop; stable regardless of bypass state). Content 'looped' events:
   *  the LOOP COUNT (1-based pass number). */
  int32_t clipOrdinal = 0;
  double idHash48 = 0;
  /** Scene trigger channel (lock-step assignment); NaN for non-scene streams. */
  double channel = std::numeric_limits<double>::quiet_NaN();
};

/** A track stream's per-clip lookup row (ordinal pairing + scene progress). */
struct StreamClipRef {
  int32_t ordinal = 0;
  double lengthBeat = 0;
  /** The STANDARD clip duration in seconds (streams.clip_duration): exactly
   *  the engine one-shot auto-stop's math — video: slice ÷ |speed|;
   *  effect-only: lengthBeat at base tempo (warp-approximate; scenes are
   *  launch-anchored while warp segments are timeline-derived). */
  double stdDurationSec = 0;
  /** Live-style follow GROUP id (streams.clip_group): maximal runs of
   *  TOUCHING launchable spans in grid order — cells that abut or overlap
   *  join; a spatial gap, a bypassed scene, or a truly-empty clip breaks the
   *  run. -1 = the clip itself is unlaunchable. */
  double groupId = -1;
};

/**
 * The standard clip duration (seconds) — LOCK-STEP with healSceneLaunches'
 * one-shot auto-stop math: keep byte-identical or Auto-follow timing diverges
 * from the auto-stop it replaces. Video: (endSec−startSec | frames/fps@30) ÷
 * max(1e-6,|speed|); effect-only: lengthBeat · 60/bpm.
 */
inline double standardClipDurationSec(const ClipM& clip, double baseBPM) {
  if (clip.hasSourceUrl) {
    double sliceSec = -1;
    if (clip.loop.endSec) {
      sliceSec = *clip.loop.endSec - clip.loop.startSec;
    } else if (clip.sourceJson.is_object() && clip.sourceJson.contains("durationFrames") &&
               clip.sourceJson["durationFrames"].is_number()) {
      const double fps = clip.sourceJson.contains("fps") &&
                                 clip.sourceJson["fps"].is_number() &&
                                 clip.sourceJson["fps"].get<double>() > 0
                             ? clip.sourceJson["fps"].get<double>()
                             : 30.0;
      sliceSec = clip.sourceJson["durationFrames"].get<double>() / fps;
    }
    if (sliceSec >= 0) return sliceSec / std::max(1e-6, std::abs(clip.loop.speed));
    return 0;
  }
  return clip.lengthBeat * 60.0 / (baseBPM > 1 ? baseBPM : 120.0);
}

// ── Resources (ABI v4): a resource is the ASSET; a stream is its TRANSPORT
// VIEW. resources.stream(res) fetches the view; future kinds (file / image /
// audio) add data/texture views on the same handle namespace by appending
// ops. Identity domain "res:clip:<clipId>" — same FNV scheme, disjoint from
// stream identities by the domain prefix. Effect-side enum twins:
// wasm_modules/include/resources.h (values are ABI).

enum ResourceKind : int32_t {
  kResKindInvalid = 0,
  kResKindClipContent = 1,  // a clip's playable media
  kResKindFile = 2,         // RESERVED: raw binary asset
  kResKindImage = 3,        // RESERVED: static image
  kResKindAudio = 4,        // RESERVED: audio asset
};

enum ResourceFlags : int32_t {
  kResHasStream = 1 << 0,   // resources.stream() answers non-zero
  kResHasData = 1 << 1,     // RESERVED: byte view
  kResHasTexture = 1 << 2,  // RESERVED: texture view
  kResForkable = 1 << 3,    // resources.fork() accepted
};

struct ResourceInfo {
  int64_t handle = 0;
  int32_t kind = kResKindInvalid;
  int32_t flags = 0;
  /** The seekable-stream view handle (0 = not stream-backed). */
  int64_t stream = 0;
  int64_t sizeBytes = -1;
  double durationSec = -1;
  int32_t width = 0;
  int32_t height = 0;
  /** clipId for ClipContent resources. */
  std::string ownerId;
};

struct StreamInfo {
  int64_t handle = kStreamInvalid;
  int32_t kind = kStreamKindInvalid;
  int32_t flags = 0;
  int32_t axis = kStreamAxisSeconds;
  int32_t frameCount = 0;
  /** Position in the enumeration, or -1 (content streams are reachable only
   *  via streams_content — not enumerated in M1). */
  int32_t index = -1;
  int32_t clipCount = 0;
  double durationPrimary = -1;  // primary-axis units; -1 = infinite/unknown
  double durationSec = -1;
  double bpm = 120;
  double fps = 0;
  std::string name;
  /** trackId for track streams; clipId for content streams; "" for clocks. */
  std::string ownerId;
  std::vector<StreamEvent> events;
  /** Track streams: clipId → {grid ordinal, lengthBeat, ...} (scene sync,
   *  clip_duration/clip_group queries, seek translation). */
  std::unordered_map<std::string, StreamClipRef> clipsById;
  /** Track streams: ordinal → clipId (the streams.seek target lookup). */
  std::vector<std::string> byOrdinalClipId;
  // ── Scene tracks only: launched-scene state, synced per frame from the
  // executor's launch map (sampleStreamsFrame). NaN ordinal = nothing playing.
  double liveOrdinal = std::numeric_limits<double>::quiet_NaN();
  double liveAnchorBeat = 0;
  double liveLengthBeat = 0;
  // ── Content streams only: everything the lazy position eval needs ──
  ClipLoopConfig loop;
  nlohmann::json loopJson;  // raw, for the web registry twin
  /** clip.startBeat; scenes re-anchor to the launch beat on launchScene. */
  double anchorBeat = 0;
  /** secondsAt(anchorBeat) CAPTURED ONCE (build / launch) and SHIPPED to the
   *  web twin — never recomputed per host. Both hosts subtract the identical
   *  double when deriving elapsed, so event-boundary floor()s can't diverge
   *  by a warp-sin ulp (the M1 clamp bug's sibling). */
  double anchorSec = 0;
  double lengthBeat = 0;
  double videoDurSec = 0;
  double seed = 0;
  // ── Content event timeline (kinds 2/3) ──
  /** Change token for THIS stream's event generator (streams_rev). Bumps on
   *  rebuild, (re)launch, stop, and declaration revision — NOT as time passes
   *  (the list is a virtual, index-stable timeline whose count may grow at a
   *  fixed rev). Values are per-host tokens; only monotonicity is contractual. */
  int32_t eventRev = 0;
  /** Controller-declared future (driven clips): predicted end on the elapsed
   *  axis (-1 = none declared) + completed-pass count. Built-in play modes
   *  never set these — their boundaries are analytic. */
  bool declared = false;
  double declNextEnd = -1;
  double declLoopCount = 0;
  /** Declared 'looped' edges observed so far (appended when declLoopCount
   *  increments; integer compares — no fp hazard). Elapsed-axis times. */
  std::vector<StreamEvent> dynEvents;
};

struct StreamsTable {
  int32_t docRev = 0;
  /** [0, enumCount) in enumeration order (session clock, timeline, tracks in
   *  doc order); content streams follow with index = -1. */
  std::vector<StreamInfo> streams;
  int32_t enumCount = 0;
  std::unordered_map<int64_t, int32_t> byHandle;
  std::unordered_map<std::string, int64_t> parentByClipId;
  std::unordered_map<std::string, int64_t> contentByClipId;
  /** trackId → track stream handle (no-alloc per-frame scene sync). */
  std::unordered_map<std::string, int64_t> trackByTrackId;
  /** Resources (the asset namespace) — one ClipContent resource per
   *  video-backed clip today. */
  std::unordered_map<int64_t, ResourceInfo> resourcesByHandle;
  std::unordered_map<std::string, int64_t> resourceByClipId;

  /** Per-frame transport sample — mutated in place by CompExecutor::update();
   *  the import handlers read it directly (no copies, no messages). */
  struct Frame {
    double posBeat = 0;
    double posSec = 0;
    int32_t playing = 0;
    int32_t loopEnabled = 0;
    double loopStartBeat = 0;
    double loopEndBeat = 0;
  } frame;

  /** Content-time overrides applied by transport-controller effects (clipId →
   *  content seconds); wins over the lazy clip-time mapping. */
  std::unordered_map<std::string, double> appliedContentSec;

  /** Queued streams.seek/stop write verbs (raw, translated at drain time by
   *  CompExecutor::drainStreamOps — the single-threaded render path). A doc
   *  reload rebuilds the table and clobbers queued ops (edit-rate; ops are
   *  one-frame — acceptable). */
  struct StreamOp {
    int32_t kind = 0;  // 0 = seek, 1 = stop, 2 = announce
    int64_t handle = 0;
    double t = 0;
    /** Launch deadline class (streams.seek's cls arg): 0 = instant, 1 = loose
     *  (the default for transport effects — Live mode may linger on the
     *  outgoing scene while the incoming video warms). */
    int32_t cls = 1;
    /** streams.announce only: declared seconds until the intended seek. */
    double eta = 0;
  };
  std::vector<StreamOp> pendingOps;

  const StreamInfo* find(int64_t h) const {
    auto it = byHandle.find(h);
    return it == byHandle.end() ? nullptr : &streams[static_cast<size_t>(it->second)];
  }
  StreamInfo* findMutable(int64_t h) {
    auto it = byHandle.find(h);
    return it == byHandle.end() ? nullptr : &streams[static_cast<size_t>(it->second)];
  }
  const ResourceInfo* findResource(int64_t h) const {
    auto it = resourcesByHandle.find(h);
    return it == resourcesByHandle.end() ? nullptr : &it->second;
  }
};

namespace streams_detail {

/** GRID order: startBeat ascending, ties by array index (the same order
 *  sceneChannelAssignments assigns auto channels in). */
inline std::vector<size_t> gridOrder(const TrackM& track) {
  std::vector<size_t> order(track.clips.size());
  for (size_t i = 0; i < order.size(); ++i) order[i] = i;
  std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
    return track.clips[a].startBeat < track.clips[b].startBeat;
  });
  return order;
}

/** Ascending time; at ties STOP sorts before START (adjacent clips read as
 *  "stop A, start B"), then clipOrdinal keeps full determinism. */
inline void sortEvents(std::vector<StreamEvent>& ev) {
  std::stable_sort(ev.begin(), ev.end(), [](const StreamEvent& a, const StreamEvent& b) {
    if (a.time != b.time) return a.time < b.time;
    if (a.kind != b.kind) return a.kind > b.kind;  // stop(1) before start(0)
    return a.clipOrdinal < b.clipOrdinal;
  });
}

/** Seek-cost classifier for a clip source. Stills/single-frame sources are
 *  random-access; everything else defaults to SLOW here — the web registry
 *  refines <video>-vs-DXV from its FrameSource profile, the native table only
 *  needs a conservative baseline. */
inline bool sourceSeekInstant(const nlohmann::json& src) {
  if (src.is_object() && src.contains("durationFrames") &&
      src["durationFrames"].is_number() && src["durationFrames"].get<double>() <= 1) {
    return true;
  }
  const std::string url = src.is_object() ? src.value("url", std::string()) : std::string();
  const size_t dot = url.find_last_of('.');
  if (dot == std::string::npos) return false;
  std::string ext = url.substr(dot + 1);
  std::transform(ext.begin(), ext.end(), ext.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return ext == "png" || ext == "jpg" || ext == "jpeg" || ext == "gif" ||
         ext == "webp" || ext == "bmp";
}

}  // namespace streams_detail

/**
 * Build the full registry from a (re)loaded document. Streams:
 *   session clock, timeline root, every Track/Scene track (doc order), and one
 *   content stream per video-backed clip (not enumerated).
 * Events (start/stop) are emitted for non-bypassed clips only — a bypassed
 * clip never triggers/plays — and for scenes additionally non-empty ones
 * (matching readTriggerSignals' matcher); clipOrdinal always indexes the FULL
 * grid-ordered list so ordinals are stable regardless of bypass state.
 */
inline StreamsTable buildStreamsTable(const CompositionM& doc, const WarpClock& clock,
                                      int32_t docRev) {
  using namespace streams_detail;
  StreamsTable t;
  t.docRev = docRev;

  auto push = [&](StreamInfo&& s) -> StreamInfo& {
    s.eventRev = docRev;  // every stream's generator token starts at the doc rev
    t.byHandle[s.handle] = static_cast<int32_t>(t.streams.size());
    t.streams.push_back(std::move(s));
    return t.streams.back();
  };

  {
    StreamInfo s;
    s.handle = kStreamSessionClock;
    s.kind = kStreamKindSessionClock;
    s.axis = kStreamAxisSeconds;
    s.flags = kStreamLiveOnly;
    s.bpm = doc.baseBPM;
    s.index = 0;
    push(std::move(s));
  }
  {
    StreamInfo s;
    s.handle = kStreamTimeline;
    s.kind = kStreamKindTimeline;
    s.axis = kStreamAxisBeats;
    s.flags = kStreamSeekInstant | kStreamFinite;
    s.durationPrimary = compositionLengthBeats(doc);
    s.durationSec = clock.secondsAt(s.durationPrimary);
    s.bpm = doc.baseBPM;
    s.index = 1;
    push(std::move(s));
  }

  int32_t nextIndex = 2;
  for (const auto& track : doc.tracks) {
    if (track.kind != TrackKind::Track && track.kind != TrackKind::Scene) continue;
    const bool scene = track.kind == TrackKind::Scene;
    StreamInfo s;
    s.handle = streamHandleOf("track:" + track.id);
    s.kind = scene ? kStreamKindSceneTrack : kStreamKindTimelineTrack;
    s.axis = scene ? kStreamAxisOrdinal : kStreamAxisBeats;
    s.flags = kStreamHasEvents | kStreamTriggerOnSeek |
              (scene ? 0 : kStreamSeekInstant | kStreamFinite);
    s.bpm = doc.baseBPM;
    s.name = track.name;
    s.ownerId = track.id;
    s.index = nextIndex++;
    s.clipCount = static_cast<int32_t>(track.clips.size());

    const std::vector<size_t> order = gridOrder(track);
    const std::vector<int> channels = scene ? sceneChannelAssignments(track)
                                            : std::vector<int>();
    double extent = 0;
    double runEnd = -1e300;  // end of the current touching-span group run
    int32_t nextGroup = -1;
    s.byOrdinalClipId.reserve(order.size());
    for (size_t ord = 0; ord < order.size(); ++ord) {
      const ClipM& clip = track.clips[order[ord]];
      t.parentByClipId[clip.id] = s.handle;
      StreamClipRef ref;
      ref.ordinal = static_cast<int32_t>(ord);
      ref.lengthBeat = clip.lengthBeat;
      ref.stdDurationSec = standardClipDurationSec(clip, doc.baseBPM);
      // Launchable = not bypassed and not a truly-empty scene. Empty scenes
      // ARE launchable when they carry a transport section: a Follow-only
      // "gap" scene is a timed blank (renders nothing, its section owns the
      // dwell + hands the track on).
      const bool launchable =
          !clip.bypassed && !(scene && !clip.hasSourceUrl && clip.sketch.devices.empty() &&
                              clip.transport.devices.empty());
      if (launchable) {
        if (clip.startBeat > runEnd + 1e-6) nextGroup++;  // gap → new group
        ref.groupId = nextGroup;
        runEnd = std::max(runEnd, clip.startBeat + clip.lengthBeat);
      } else {
        runEnd = -1e300;  // a bypassed / truly-empty cell breaks the run
      }
      s.clipsById[clip.id] = ref;
      s.byOrdinalClipId.push_back(clip.id);
      extent = std::max(extent, clip.startBeat + clip.lengthBeat);
      if (!launchable) continue;
      StreamEvent start;
      start.time = scene ? static_cast<double>(ord) : clip.startBeat;
      start.kind = 0;
      start.clipOrdinal = static_cast<int32_t>(ord);
      start.idHash48 = clipIdHash48(clip.id);
      if (scene) start.channel = static_cast<double>(channels[order[ord]]);
      s.events.push_back(start);
      if (!scene) {
        StreamEvent stop = start;
        stop.time = clip.startBeat + clip.lengthBeat;
        stop.kind = 1;
        s.events.push_back(stop);
      }
    }
    sortEvents(s.events);
    if (scene) {
      s.durationPrimary = static_cast<double>(track.clips.size());
    } else {
      s.durationPrimary = extent;
      s.durationSec = clock.secondsAt(extent);
    }
    t.trackByTrackId[track.id] = s.handle;
    push(std::move(s));
  }
  t.enumCount = nextIndex;

  for (const auto& track : doc.tracks) {
    if (track.kind != TrackKind::Track && track.kind != TrackKind::Scene) continue;
    for (const auto& clip : track.clips) {
      if (!clip.hasSourceUrl) continue;
      StreamInfo s;
      s.handle = streamHandleOf("content:" + clip.id);
      s.kind = kStreamKindVideoContent;
      s.axis = kStreamAxisSeconds;
      const auto& src = clip.sourceJson;
      s.fps = src.is_object() && src.contains("fps") && src["fps"].is_number() &&
                      src["fps"].get<double>() > 0
                  ? src["fps"].get<double>()
                  : 30.0;
      s.frameCount = src.is_object() && src.contains("durationFrames") &&
                             src["durationFrames"].is_number()
                         ? src["durationFrames"].get<int32_t>()
                         : 0;
      s.videoDurSec = s.frameCount > 0 ? s.frameCount / s.fps : 0;
      s.durationPrimary = s.durationSec = s.videoDurSec;
      s.flags = kStreamFinite | kStreamHasEvents |
                (streams_detail::sourceSeekInstant(src) ? kStreamSeekInstant
                                                        : kStreamSeekSlow);
      s.bpm = doc.baseBPM;
      s.name = clip.name;
      s.ownerId = clip.id;
      s.loop = clip.loop;
      s.loopJson = clip.loopJson.is_object() ? clip.loopJson : nlohmann::json::object();
      s.anchorBeat = clip.startBeat;
      s.anchorSec = clock.secondsAt(clip.startBeat);
      s.lengthBeat = clip.lengthBeat;
      s.seed = clipNoiseSeed(clip.id);
      s.eventRev = docRev;
      t.contentByClipId[clip.id] = s.handle;

      // The clip's ASSET, as a resource. Its rev mirrors the content stream's
      // eventRev at read time (resolved through `stream`, never copied).
      ResourceInfo r;
      r.handle = streamHandleOf("res:clip:" + clip.id);
      r.kind = kResKindClipContent;
      r.flags = kResHasStream | kResForkable;
      r.stream = s.handle;
      r.durationSec = s.videoDurSec;
      if (src.is_object()) {
        if (src.contains("width") && src["width"].is_number())
          r.width = src["width"].get<int32_t>();
        if (src.contains("height") && src["height"].is_number())
          r.height = src["height"].get<int32_t>();
      }
      r.ownerId = clip.id;
      t.resourceByClipId[clip.id] = r.handle;
      t.resourcesByHandle[r.handle] = std::move(r);

      push(std::move(s));
    }
  }
  return t;
}

// ── Content event timeline (LOCK-STEP: web/src/streams-registry.ts) ─────────
// A content stream's events are a VIRTUAL, index-stable timeline: index i maps
// analytically to the i-th boundary, so the count may grow as time passes at a
// fixed eventRev (readers paginate safely; rev bumps only when the GENERATOR
// changes: anchor, config, declaration). 'looped' = one full pass of the source
// slice completed — non-pingpong wraps at an edge, pingpong touches alternate
// edges: identical spacing (loopLen of consumed source) either way. 'ended'
// (one-shot) lands EXACTLY at standardClipDurationSec — the engine auto-stop's
// time. Random mode has no boundaries (readers fall back to clip_duration).
// Declared (controller-driven) streams replace the analytics with the observed
// looped log + one revisable predicted 'ended'.

inline constexpr int32_t kContentEventHorizon = 4;

struct ContentEventGen {
  int32_t mode = 0;    // 0 = none, 1 = single 'ended', 2 = periodic 'looped'
  double firstTime = 0;
  double period = 0;
};

inline ContentEventGen contentEventGen(const StreamInfo& s) {
  ContentEventGen g;
  const double speedAbs = std::max(1e-6, std::abs(s.loop.speed));
  if (s.loop.mode == ClipPlayMode::OneShot) {
    const double sliceSec = s.loop.endSec ? *s.loop.endSec - s.loop.startSec : s.videoDurSec;
    if (sliceSec > 0) {
      g.mode = 1;
      g.firstTime = sliceSec / speedAbs;  // == standardClipDurationSec
    }
    return g;
  }
  if (s.loop.mode == ClipPlayMode::Random) return g;
  const double loopStart = s.loop.startSec;
  const double loopEnd = s.loop.endSec.value_or(s.videoDurSec);
  const double loopLen = loopEnd - loopStart;
  if (loopLen <= 1e-9) return g;
  const double playStart = s.loop.playStartSec.value_or(loopStart);
  // First pass runs playStart → far edge (the pre-roll, clip_time.h); a
  // degenerate play-start at/past the edge degrades to whole-slice passes.
  double c1 = s.loop.direction >= 0 ? loopEnd - playStart : playStart - loopStart;
  if (c1 <= 1e-9) c1 = loopLen;
  if (s.loop.mode == ClipPlayMode::BeatSync) {
    const double videoBeats = s.loop.syncUseBpm ? loopLen * (s.loop.syncBpm.value_or(120) / 60)
                                                : s.loop.syncBeats.value_or(4);
    if (videoBeats <= 1e-9) return g;
    g.mode = 2;
    g.firstTime = (c1 / loopLen) * videoBeats;  // BEAT axis (matches elapsed)
    g.period = videoBeats;
    return g;
  }
  g.mode = 2;
  g.firstTime = c1 / speedAbs;
  g.period = loopLen / speedAbs;
  return g;
}

/** Elapsed "now" on the stream's EVENT axis (streams_elapsed): seconds since
 *  anchor — beats since anchor for beat-sync content. The anchor is the SHIPPED
 *  anchorSec/anchorBeat double, identical on both hosts by construction. */
inline double streamElapsed(const StreamInfo& s, const StreamsTable& t, double sessionSec) {
  switch (s.kind) {
    case kStreamKindSessionClock:
      return sessionSec;
    case kStreamKindTimeline:
    case kStreamKindTimelineTrack:
      return t.frame.posSec;
    case kStreamKindSceneTrack:
      return std::isnan(s.liveOrdinal) ? s.liveOrdinal : t.frame.posSec;  // see posSec
    case kStreamKindVideoContent:
    case kStreamKindSequenceContent:
      if (s.loop.mode == ClipPlayMode::BeatSync) return t.frame.posBeat - s.anchorBeat;
      return t.frame.posSec - s.anchorSec;
    default:
      return std::numeric_limits<double>::quiet_NaN();
  }
}

inline bool isContentStream(const StreamInfo& s) {
  return s.kind == kStreamKindVideoContent || s.kind == kStreamKindSequenceContent;
}

inline int32_t contentEventCount(const StreamInfo& s, double nowElapsed) {
  if (s.declared) {
    return static_cast<int32_t>(s.dynEvents.size()) + (s.declNextEnd >= 0 ? 1 : 0);
  }
  const ContentEventGen g = contentEventGen(s);
  if (g.mode == 0) return 0;
  if (g.mode == 1) return 1;
  // Boundaries with time <= now are PAST (an exactly-on-boundary now counts
  // it) + a fixed future horizon. floor() operands are shipped doubles on
  // both hosts — no per-host warp math.
  const double past = std::floor((nowElapsed - g.firstTime) / g.period) + 1;
  return static_cast<int32_t>(std::max(0.0, past)) + kContentEventHorizon;
}

inline StreamEvent contentEventAt(const StreamInfo& s, int32_t i) {
  StreamEvent e;
  e.idHash48 = clipIdHash48(s.ownerId);
  if (s.declared) {
    if (i < static_cast<int32_t>(s.dynEvents.size())) return s.dynEvents[static_cast<size_t>(i)];
    e.time = s.declNextEnd;
    e.kind = 3;
    return e;
  }
  const ContentEventGen g = contentEventGen(s);
  if (g.mode == 1) {
    e.time = g.firstTime;
    e.kind = 3;
    return e;
  }
  e.time = g.firstTime + i * g.period;
  e.kind = 2;
  e.clipOrdinal = i + 1;  // 1-based pass count
  return e;
}

/** lower_bound on the virtual timeline: first index with time >= t. */
inline int32_t contentEventLowerBound(const StreamInfo& s, double nowElapsed, double tTime) {
  const int32_t n = contentEventCount(s, nowElapsed);
  int32_t lo = 0, hi = n;
  while (lo < hi) {
    const int32_t mid = lo + (hi - lo) / 2;
    if (contentEventAt(s, mid).time < tTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A content stream's position (seconds into the source) at the table's current
 * frame — the transport-controller override when one applied, else the lazy
 * built-in clip-time mapping. NaN = transparent/undefined.
 */
inline double contentPosSec(const StreamInfo& s, const StreamsTable& t, const WarpClock& clock) {
  auto it = t.appliedContentSec.find(s.ownerId);
  if (it != t.appliedContentSec.end()) return it->second;
  ClipTimeCtx ctx;
  ctx.startBeat = s.anchorBeat;
  ctx.lengthBeat = s.lengthBeat;
  ctx.videoDurSec = s.videoDurSec;
  ctx.clock = &clock;
  ctx.seed = s.seed;
  const auto vt = clipSourceTimeAt(s.loop, ctx, t.frame.posBeat);
  return vt ? *vt : std::numeric_limits<double>::quiet_NaN();
}

// ── Import-handler evaluators (LOCK-STEP: web/src/streams-registry.ts) ──────
// Shared by the native host functions and (as TS ports) the web importObject,
// so both hosts answer identically. `sessionSec` = the calling host's frame
// clock (FrameState.elapsed_time) — the only per-host input.

/** Position on the stream's PRIMARY axis (streams.h streams_pos). */
inline double streamPos(const StreamInfo& s, const StreamsTable& t, const WarpClock& clock,
                        double sessionSec) {
  switch (s.kind) {
    case kStreamKindSessionClock:
      return sessionSec;
    case kStreamKindTimeline:
    case kStreamKindTimelineTrack:
      return t.frame.posBeat;
    case kStreamKindSceneTrack: {
      if (std::isnan(s.liveOrdinal)) return s.liveOrdinal;
      const double len = std::max(1e-9, s.liveLengthBeat);
      // Clamp STRICTLY below 1: a scene playing past its grid cell (the
      // normal long-playing state) must still floor() to ITS ordinal — the
      // documented contract (streams.h) — never the next cell's. The margin
      // must SURVIVE the addition below: 1 - 2^-52 rounds away in
      // `ordinal + frac` for ordinal >= 2 (round-to-even lands on the next
      // integer), so use a margin comfortably above one ulp at any plausible
      // ordinal magnitude.
      const double frac = std::min(1.0 - 1e-9,
                                   std::max(0.0, (t.frame.posBeat - s.liveAnchorBeat) / len));
      return s.liveOrdinal + frac;
    }
    case kStreamKindVideoContent:
      return contentPosSec(s, t, clock);
    default:
      return std::numeric_limits<double>::quiet_NaN();
  }
}

/** Position in seconds regardless of axis (streams.h streams_pos_sec). */
inline double streamPosSec(const StreamInfo& s, const StreamsTable& t, const WarpClock& clock,
                           double sessionSec) {
  switch (s.kind) {
    case kStreamKindSessionClock:
      return sessionSec;
    case kStreamKindTimeline:
    case kStreamKindTimelineTrack:
      return t.frame.posSec;
    case kStreamKindSceneTrack:
      if (std::isnan(s.liveOrdinal)) return s.liveOrdinal;
      return t.frame.posSec - clock.secondsAt(s.liveAnchorBeat);
    case kStreamKindVideoContent:
      return contentPosSec(s, t, clock);
    default:
      return std::numeric_limits<double>::quiet_NaN();
  }
}

inline int32_t streamPlaying(const StreamInfo& s, const StreamsTable& t) {
  switch (s.kind) {
    case kStreamKindSessionClock:
      return 1;
    case kStreamKindSceneTrack:
      return std::isnan(s.liveOrdinal) ? 0 : t.frame.playing;
    default:
      return t.frame.playing;
  }
}

/** Active loop region on the primary axis → 1 + out2 filled, else 0. */
inline int32_t streamLoop(const StreamInfo& s, const StreamsTable& t, double* out2) {
  switch (s.kind) {
    case kStreamKindTimeline:
    case kStreamKindTimelineTrack:
      if (!t.frame.loopEnabled) return 0;
      out2[0] = t.frame.loopStartBeat;
      out2[1] = t.frame.loopEndBeat;
      return 1;
    case kStreamKindVideoContent:
      // The looping play modes expose their source slice; one-shot/random
      // wander freely (no steady window).
      if (s.loop.mode != ClipPlayMode::Time && s.loop.mode != ClipPlayMode::BeatSync) return 0;
      out2[0] = s.loop.startSec;
      out2[1] = s.loop.endSec.value_or(s.videoDurSec);
      return 1;
    default:
      return 0;
  }
}

/**
 * Resolve the clip that owns an executing effect from its instance key
 * ("clip_<clipId>_<suffix>", sketch_build.h). Clip ids may themselves contain
 * '_', so match against the known id set (longest match wins) instead of
 * splitting. Returns nullptr for non-clip keys (track FX, standalone).
 */
inline const std::string* clipIdForInstanceKey(const StreamsTable& t, const std::string& key) {
  constexpr size_t kPrefix = 5;  // "clip_"
  if (key.compare(0, kPrefix, "clip_") != 0) return nullptr;
  const std::string* best = nullptr;
  for (const auto& kv : t.parentByClipId) {
    const std::string& clipId = kv.first;
    if (key.size() <= kPrefix + clipId.size() ||
        key[kPrefix + clipId.size()] != '_' ||
        key.compare(kPrefix, clipId.size(), clipId) != 0)
      continue;
    if (!best || clipId.size() > best->size()) best = &clipId;
  }
  return best;
}

// ── Resource evaluators (LOCK-STEP: web/src/streams-registry.ts) ────────────

/** The resource of the clip currently LIVE on a scene track (0 idle /
 *  non-scene / clip has no media). */
inline int64_t resourceForTrackLive(const StreamsTable& t, const StreamInfo& s) {
  if (s.kind != kStreamKindSceneTrack || std::isnan(s.liveOrdinal)) return 0;
  const int32_t ord = static_cast<int32_t>(s.liveOrdinal);
  if (ord < 0 || ord >= static_cast<int32_t>(s.byOrdinalClipId.size())) return 0;
  auto it = t.resourceByClipId.find(s.byOrdinalClipId[static_cast<size_t>(ord)]);
  return it == t.resourceByClipId.end() ? 0 : it->second;
}

/** The resource of the clip at grid ordinal N on a track stream (either
 *  track kind). 0 out of range / no media. */
inline int64_t resourceForTrackClipAt(const StreamsTable& t, const StreamInfo& s,
                                      int32_t ordinal) {
  if (ordinal < 0 || ordinal >= static_cast<int32_t>(s.byOrdinalClipId.size())) return 0;
  auto it = t.resourceByClipId.find(s.byOrdinalClipId[static_cast<size_t>(ordinal)]);
  return it == t.resourceByClipId.end() ? 0 : it->second;
}

/** A resource's change token: the underlying stream's eventRev for
 *  stream-backed resources, else the table's docRev. */
inline int32_t resourceRev(const StreamsTable& t, const ResourceInfo& r) {
  if (r.stream != 0) {
    if (const StreamInfo* s = t.find(r.stream)) return s->eventRev;
  }
  return t.docRev;
}

/**
 * Serialize the STATIC registry for the web engine worker's StreamsRegistry
 * twin. Fetched on doc-epoch change only — never per frame. Handles are
 * unsigned-decimal strings (they exceed 2^53); event channel NaN → null.
 */
inline std::string streamsTableJson(const StreamsTable& t) {
  auto handleStr = [](int64_t h) { return std::to_string(static_cast<uint64_t>(h)); };
  nlohmann::json out = {{"docRev", t.docRev},
                        {"enumCount", t.enumCount},
                        {"streams", nlohmann::json::array()},
                        {"parentByClipId", nlohmann::json::object()},
                        {"contentByClipId", nlohmann::json::object()}};
  for (const auto& s : t.streams) {
    nlohmann::json ev = nlohmann::json::array();
    for (const auto& e : s.events) {
      ev.push_back({e.time, e.kind, e.clipOrdinal, e.idHash48,
                    std::isnan(e.channel) ? nlohmann::json() : nlohmann::json(e.channel)});
    }
    nlohmann::json j = {{"handle", handleStr(s.handle)},
                        {"kind", s.kind},
                        {"flags", s.flags},
                        {"axis", s.axis},
                        {"frameCount", s.frameCount},
                        {"index", s.index},
                        {"clipCount", s.clipCount},
                        {"durationPrimary", s.durationPrimary},
                        {"durationSec", s.durationSec},
                        {"bpm", s.bpm},
                        {"fps", s.fps},
                        {"name", s.name},
                        {"ownerId", s.ownerId},
                        {"events", std::move(ev)}};
    if (s.kind == kStreamKindVideoContent || s.kind == kStreamKindSequenceContent) {
      j["loop"] = s.loopJson;
      j["anchorBeat"] = s.anchorBeat;
      j["anchorSec"] = s.anchorSec;
      j["lengthBeat"] = s.lengthBeat;
      j["videoDurSec"] = s.videoDurSec;
      j["seed"] = s.seed;
    }
    j["eventRev"] = s.eventRev;
    if (!s.clipsById.empty()) {
      nlohmann::json clips = nlohmann::json::object();
      for (const auto& [clipId, ref] : s.clipsById)
        clips[clipId] = {ref.ordinal, ref.lengthBeat, ref.stdDurationSec, ref.groupId};
      j["clipsById"] = std::move(clips);
    }
    out["streams"].push_back(std::move(j));
  }
  for (const auto& [clipId, h] : t.parentByClipId) out["parentByClipId"][clipId] = handleStr(h);
  for (const auto& [clipId, h] : t.contentByClipId) out["contentByClipId"][clipId] = handleStr(h);
  for (const auto& [trackId, h] : t.trackByTrackId) out["trackByTrackId"][trackId] = handleStr(h);
  // Resources, in stream (= document) order so the emission is deterministic.
  nlohmann::json resources = nlohmann::json::array();
  for (const auto& s : t.streams) {
    if (s.kind != kStreamKindVideoContent && s.kind != kStreamKindSequenceContent) continue;
    auto it = t.resourceByClipId.find(s.ownerId);
    if (it == t.resourceByClipId.end()) continue;
    const ResourceInfo& r = t.resourcesByHandle.at(it->second);
    resources.push_back({{"handle", handleStr(r.handle)},
                         {"kind", r.kind},
                         {"flags", r.flags},
                         {"stream", handleStr(r.stream)},
                         {"sizeBytes", r.sizeBytes},
                         {"durationSec", r.durationSec},
                         {"width", r.width},
                         {"height", r.height},
                         {"ownerId", r.ownerId}});
  }
  out["resources"] = std::move(resources);
  return out.dump();
}

}  // namespace comp
