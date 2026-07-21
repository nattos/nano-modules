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
  /** Stream primary-axis units (beats for tracks, ordinal for scene tracks). */
  double time = 0;
  int32_t kind = 0;  // 0 = start, 1 = stop
  /** Index into the stream's GRID-ordered clip list (startBeat, then array
   *  index — the sceneChannelAssignments order); pairs a start with its stop
   *  and stays meaningful for clips that emit no events (bypassed). */
  int32_t clipOrdinal = 0;
  double idHash48 = 0;
  /** Scene trigger channel (lock-step assignment); NaN for non-scene streams. */
  double channel = std::numeric_limits<double>::quiet_NaN();
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
  // ── Content streams only: everything the lazy position eval needs ──
  ClipLoopConfig loop;
  nlohmann::json loopJson;  // raw, for the web registry twin
  /** clip.startBeat; scenes re-anchor to the launch beat on launchScene. */
  double anchorBeat = 0;
  double lengthBeat = 0;
  double videoDurSec = 0;
  double seed = 0;
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

  const StreamInfo* find(int64_t h) const {
    auto it = byHandle.find(h);
    return it == byHandle.end() ? nullptr : &streams[static_cast<size_t>(it->second)];
  }
  StreamInfo* findMutable(int64_t h) {
    auto it = byHandle.find(h);
    return it == byHandle.end() ? nullptr : &streams[static_cast<size_t>(it->second)];
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
    for (size_t ord = 0; ord < order.size(); ++ord) {
      const ClipM& clip = track.clips[order[ord]];
      t.parentByClipId[clip.id] = s.handle;
      extent = std::max(extent, clip.startBeat + clip.lengthBeat);
      if (clip.bypassed) continue;
      if (scene && !clip.hasSourceUrl && clip.sketch.devices.empty()) continue;  // empty
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
      s.flags = kStreamFinite |
                (streams_detail::sourceSeekInstant(src) ? kStreamSeekInstant
                                                        : kStreamSeekSlow);
      s.bpm = doc.baseBPM;
      s.name = clip.name;
      s.ownerId = clip.id;
      s.loop = clip.loop;
      s.loopJson = clip.loopJson.is_object() ? clip.loopJson : nlohmann::json::object();
      s.anchorBeat = clip.startBeat;
      s.lengthBeat = clip.lengthBeat;
      s.seed = clipNoiseSeed(clip.id);
      t.contentByClipId[clip.id] = s.handle;
      push(std::move(s));
    }
  }
  return t;
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
      j["lengthBeat"] = s.lengthBeat;
      j["videoDurSec"] = s.videoDurSec;
      j["seed"] = s.seed;
    }
    out["streams"].push_back(std::move(j));
  }
  for (const auto& [clipId, h] : t.parentByClipId) out["parentByClipId"][clipId] = handleStr(h);
  for (const auto& [clipId, h] : t.contentByClipId) out["contentByClipId"][clipId] = handleStr(h);
  return out.dump();
}

}  // namespace comp
