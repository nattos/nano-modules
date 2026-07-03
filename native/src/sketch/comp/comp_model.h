// comp_model.h — the composition-executor's document model.
//
// LOCK-STEP: web/src/views/arrangement/model/composition.ts. These structs are
// the C++ twins of the arrangement document types; keep field names, defaults,
// and optionality byte-for-byte in sync (shared goldens:
// native/tests/test_comp_time.cpp + test_comp_build.cpp ↔
// web/.../engine/comp-goldens.test.ts).
//
// Opaque payloads the sketch build spreads verbatim (device `state`, sketch
// `wires`) are kept as RAW nlohmann::json — modeling them structurally would
// only risk drift; the build copies them into the emitted sketch exactly like
// the TS object spreads do.

#pragma once

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace comp {

// -------------------------------------------------------------------------
// Warp segments (composition.ts WarpSegment / WarpBinding.waveform)
// -------------------------------------------------------------------------

enum class Waveform : uint8_t { Sine, Square, Triangle, Saw };

inline Waveform waveformFromString(const std::string& s) {
  if (s == "square") return Waveform::Square;
  if (s == "triangle") return Waveform::Triangle;
  if (s == "saw") return Waveform::Saw;
  return Waveform::Sine;
}

/** One clip warp binding resolved onto the timeline (composition.ts WarpSegment). */
struct WarpSegment {
  double startBeat = 0;
  double endBeat = 0;
  Waveform waveform = Waveform::Sine;
  double amplitude = 0;
  double periodBeats = 1;
  double phase = 0;

  static WarpSegment fromJson(const nlohmann::json& j) {
    WarpSegment s;
    if (!j.is_object()) return s;
    s.startBeat = j.value("startBeat", 0.0);
    s.endBeat = j.value("endBeat", 0.0);
    s.waveform = waveformFromString(j.value("waveform", std::string("sine")));
    s.amplitude = j.value("amplitude", 0.0);
    s.periodBeats = j.value("periodBeats", 1.0);
    s.phase = j.value("phase", 0.0);
    return s;
  }
};

// -------------------------------------------------------------------------
// Clip playback timing (composition.ts ClipLoopConfig / ClipPlayMode)
// -------------------------------------------------------------------------

enum class ClipPlayMode : uint8_t { OneShot, Time, BeatSync, Random };

inline ClipPlayMode playModeFromString(const std::string& s) {
  if (s == "one-shot") return ClipPlayMode::OneShot;
  if (s == "beat-sync") return ClipPlayMode::BeatSync;
  if (s == "random") return ClipPlayMode::Random;
  return ClipPlayMode::Time;
}

enum class DwellUnit : uint8_t { Beat, Sec };

/** Fallback random params (composition.ts RANDOM_DEFAULTS). */
struct RandomDefaults {
  static constexpr double dwell = 1.0;
};

/**
 * A video clip's playback timing: the source SLICE [startSec, endSec] in
 * neutral-speed seconds + how it maps onto the clip's beat span. Optionality
 * mirrors the TS type exactly (`??` reads happen at the use sites, clip_time.h).
 */
struct ClipLoopConfig {
  ClipPlayMode mode = ClipPlayMode::Time;
  double startSec = 0;
  std::optional<double> endSec;
  std::optional<double> playStartSec;
  double speed = 1;
  /** +1 forward, -1 reverse (TS: direction === 'reverse' ? -1 : 1). */
  int direction = 1;
  bool pingpong = false;
  std::optional<double> syncBeats;
  std::optional<double> syncBpm;
  bool syncUseBpm = false;
  std::optional<double> dwell;
  DwellUnit dwellUnit = DwellUnit::Beat;

  static ClipLoopConfig fromJson(const nlohmann::json& j) {
    ClipLoopConfig c;
    if (!j.is_object()) return c;
    c.mode = playModeFromString(j.value("mode", std::string("time")));
    c.startSec = j.value("startSec", 0.0);
    if (j.contains("endSec") && j["endSec"].is_number()) c.endSec = j["endSec"].get<double>();
    if (j.contains("playStartSec") && j["playStartSec"].is_number())
      c.playStartSec = j["playStartSec"].get<double>();
    c.speed = j.value("speed", 1.0);
    c.direction = j.value("direction", std::string("forward")) == "reverse" ? -1 : 1;
    c.pingpong = j.value("pingpong", false);
    if (j.contains("syncBeats") && j["syncBeats"].is_number())
      c.syncBeats = j["syncBeats"].get<double>();
    if (j.contains("syncBpm") && j["syncBpm"].is_number()) c.syncBpm = j["syncBpm"].get<double>();
    c.syncUseBpm = j.value("syncUseBpm", false);
    if (j.contains("dwell") && j["dwell"].is_number()) c.dwell = j["dwell"].get<double>();
    c.dwellUnit = j.value("dwellUnit", std::string("beat")) == "sec" ? DwellUnit::Sec
                                                                     : DwellUnit::Beat;
    return c;
  }
};

// -------------------------------------------------------------------------
// Full composition document (composition.ts Composition / Track / Clip / ...)
// -------------------------------------------------------------------------

/** Stable id of the master/main-bus group (composition.ts MAIN_BUS_ID). */
inline constexpr const char* kMainBusId = "main-bus";

/** One effect in a clip/track sketch. `state` stays raw JSON (opaque payload). */
struct DeviceM {
  std::string id;
  std::string moduleType;
  nlohmann::json state = nlohmann::json::object();
};

/** Clip/track sketch: device list + raw modulation wires (spread verbatim). */
struct SketchSpecM {
  std::vector<DeviceM> devices;
  nlohmann::json wires = nlohmann::json::array();
};

/** An automation/envelope point ({x, y, bend}). */
struct EnvPointM {
  double x = 0;
  double y = 0;
  double bend = 0;
};

/** Track- or clip-level automation of one field (composition.ts AutomationLane). */
struct LaneM {
  std::string id;
  std::string targetDeviceId;
  std::string targetField;
  std::vector<EnvPointM> points;
  std::optional<std::string> combine;    // ?? 'replace' at the use site
  std::optional<std::string> magnitude;  // ?? 'unsigned' at the use site
};

/** A modulation a clip writes onto a rail (composition.ts RailExport). */
struct RailExportM {
  std::string railId;
  std::string sourceDeviceId;
  std::string sourceField;
  std::string combine = "replace";
  std::optional<double> scale;
};

/** A modulation a clip reads FROM a rail (composition.ts RailRead). */
struct RailReadM {
  std::string railId;
  std::string targetDeviceId;
  std::string targetField;
  std::string combine = "replace";
  std::optional<double> scale;
};

/** A trigger-source device wired to write onto a rail (composition.ts TriggerExport). */
struct TriggerExportM {
  std::string railId;
  std::string sourceDeviceId;
};

/**
 * Trigger routing sentinel (lock-step: composition.ts GLOBAL_TRIGGER_RAIL_ID).
 * The hidden global trigger bus: trigger sources with no explicit export write
 * here, and scenes/scene-tracks with no explicit listen read from here. It is
 * purely a matcher address — never a Rail entity, a track, or an executor rail
 * node (trigger events never enter the scalar wire fold).
 */
inline constexpr const char* kGlobalTriggerRailId = "__triggers__";

/**
 * Composition-param target sentinel (lock-step: composition.ts kLayerTargetId).
 * A lane/read/wire whose targetDeviceId / dest.instanceKey is `__layer__`
 * addresses the OWNER's composition-level layer params instead of a device
 * field. targetField vocabulary: "opacity" (render-level — resolved at build
 * time to the layer's blend `opacity` param or the top layer's `__opacity__`),
 * "bypass" (eval-level — a structural drop consumed by the tree builder).
 * Future out-of-sketch params (clip timing, loop params, ...) extend this
 * vocabulary; each new field declares which of the two fold classes it is.
 */
inline constexpr const char* kLayerTargetId = "__layer__";

/** A clip device that warps the beat grid (composition.ts WarpBinding). */
struct WarpBindingM {
  Waveform waveform = Waveform::Sine;
  double amplitude = 0;
  double periodBeats = 1;
  double phase = 0;
};

struct ClipM {
  std::string id;
  double startBeat = 0;
  double lengthBeat = 0;
  bool bypassed = false;
  std::optional<int> blendMode;
  /** clip.source?.url presence (the video/media path). */
  bool hasSourceUrl = false;
  /** Raw clip.source object (url/sourceKey/durationFrames/fps/scaleMode/
   *  transform...) — consumed by the video-desc build (videoDescFor twin). */
  nlohmann::json sourceJson;
  /** Raw clip.loop object — shipped verbatim on VideoClipDesc.loop. */
  nlohmann::json loopJson;
  SketchSpecM sketch;
  std::vector<LaneM> automation;
  std::vector<RailExportM> exports;
  std::vector<RailReadM> reads;
  std::vector<WarpBindingM> warps;
  ClipLoopConfig loop;
  // ── Scene fields (meaningful only on kind:'scene' tracks) ──
  /** Explicit trigger channel; absent ⇒ 'auto' (position-assigned). */
  std::optional<int> triggerChannel;
  /** Scene-level listen rail override (composition.ts Clip.triggerRead.railId). */
  std::string triggerReadRailId;
  /** Trigger-source devices wired out to rails (composition.ts Clip.triggerExports). */
  std::vector<TriggerExportM> triggerExports;
};

enum class TrackKind : uint8_t { Track, Group, Rail, Scene };

/** A group's compositing input (composition.ts GroupInput). */
struct GroupInputM {
  std::string mode = "transparent";
  std::optional<std::string> color;
  bool present = false;  // track.groupInput ?? {mode:'transparent'}
};

struct TrackM {
  std::string id;
  TrackKind kind = TrackKind::Track;
  /** Empty string = null (root). */
  std::string parentId;
  bool bypassed = false;
  bool soloed = false;
  std::optional<double> level;
  std::optional<int> blendMode;
  GroupInputM groupInput;
  std::string railId;
  bool railSigned = false;
  std::vector<EnvPointM> baseCurve;
  bool hasBaseCurve = false;
  SketchSpecM sketch;
  std::vector<LaneM> automation;
  std::vector<ClipM> clips;
  /** Track-level rail reads (composition.ts Track.reads) — a return track
   *  driving this track's own params (targetDeviceId `__layer__` for layer
   *  opacity/bypass, or a track-FX device id). */
  std::vector<RailReadM> reads;
  /** Scene tracks: default listen rail for all scenes (composition.ts
   *  Track.triggerRead.railId). Empty ⇒ the global trigger rail. */
  std::string triggerReadRailId;
};

/**
 * Transient launched-scene state for one scene track. Lives on CompExecutor
 * (NOT in the document — launches are runtime state like the playhead: not
 * undoable, healed across document reloads, reset on document open).
 */
struct SceneLaunch {
  std::string sceneId;
  double launchBeat = 0;
  /** clock.secondsAt(launchBeat) at launch time (one-shot auto-stop). */
  double launchSec = 0;
};

/** Composite backdrop (composition.ts BackgroundConfig; absent ⇒ mode 'black'). */
struct BackgroundM {
  std::string mode = "black";
  std::optional<std::string> color;
};

struct CompositionM {
  double baseBPM = 120;
  BackgroundM background;
  std::vector<TrackM> tracks;
};

// ── JSON parsing (defensive: bad/missing fields fall back to defaults) ──────

namespace model_detail {

inline std::optional<double> optNum(const nlohmann::json& j, const char* key) {
  if (j.contains(key) && j[key].is_number()) return j[key].get<double>();
  return std::nullopt;
}

inline std::vector<EnvPointM> parsePoints(const nlohmann::json& arr) {
  std::vector<EnvPointM> out;
  if (!arr.is_array()) return out;
  for (const auto& p : arr) {
    if (!p.is_object()) continue;
    EnvPointM e;
    e.x = p.value("x", 0.0);
    e.y = p.value("y", 0.0);
    e.bend = p.contains("bend") && p["bend"].is_number() ? p["bend"].get<double>() : 0.0;
    out.push_back(e);
  }
  return out;
}

inline SketchSpecM parseSketchSpec(const nlohmann::json& j) {
  SketchSpecM s;
  if (!j.is_object()) return s;
  if (j.contains("devices") && j["devices"].is_array()) {
    for (const auto& d : j["devices"]) {
      if (!d.is_object()) continue;
      DeviceM dev;
      dev.id = d.value("id", std::string());
      dev.moduleType = d.value("moduleType", std::string());
      dev.state = d.contains("state") && d["state"].is_object() ? d["state"]
                                                                : nlohmann::json::object();
      s.devices.push_back(std::move(dev));
    }
  }
  if (j.contains("wires") && j["wires"].is_array()) s.wires = j["wires"];
  return s;
}

inline std::vector<LaneM> parseLanes(const nlohmann::json& arr) {
  std::vector<LaneM> out;
  if (!arr.is_array()) return out;
  for (const auto& l : arr) {
    if (!l.is_object()) continue;
    LaneM lane;
    lane.id = l.value("id", std::string());
    lane.targetDeviceId = l.value("targetDeviceId", std::string());
    lane.targetField = l.value("targetField", std::string());
    lane.points = parsePoints(l.contains("points") ? l["points"] : nlohmann::json());
    if (l.contains("combine") && l["combine"].is_string())
      lane.combine = l["combine"].get<std::string>();
    if (l.contains("magnitude") && l["magnitude"].is_string())
      lane.magnitude = l["magnitude"].get<std::string>();
    out.push_back(std::move(lane));
  }
  return out;
}

}  // namespace model_detail

inline std::vector<RailReadM> parseReads(const nlohmann::json& arr) {
  using namespace model_detail;
  std::vector<RailReadM> out;
  if (!arr.is_array()) return out;
  for (const auto& r : arr) {
    if (!r.is_object()) continue;
    RailReadM x;
    x.railId = r.value("railId", std::string());
    x.targetDeviceId = r.value("targetDeviceId", std::string());
    x.targetField = r.value("targetField", std::string());
    x.combine = r.value("combine", std::string("replace"));
    x.scale = optNum(r, "scale");
    out.push_back(std::move(x));
  }
  return out;
}

inline ClipM parseClip(const nlohmann::json& j) {
  using namespace model_detail;
  ClipM c;
  if (!j.is_object()) return c;
  c.id = j.value("id", std::string());
  c.startBeat = j.value("startBeat", 0.0);
  c.lengthBeat = j.value("lengthBeat", 0.0);
  c.bypassed = j.value("bypassed", false);
  if (j.contains("blendMode") && j["blendMode"].is_number())
    c.blendMode = j["blendMode"].get<int>();
  if (j.contains("source") && j["source"].is_object()) {
    const auto& src = j["source"];
    c.sourceJson = src;
    c.hasSourceUrl = src.contains("url") && src["url"].is_string() &&
                     !src["url"].get<std::string>().empty();
  }
  if (j.contains("loop") && j["loop"].is_object()) c.loopJson = j["loop"];
  c.sketch = parseSketchSpec(j.contains("sketch") ? j["sketch"] : nlohmann::json());
  c.automation = parseLanes(j.contains("automation") ? j["automation"] : nlohmann::json());
  if (j.contains("exports") && j["exports"].is_array()) {
    for (const auto& e : j["exports"]) {
      if (!e.is_object()) continue;
      RailExportM x;
      x.railId = e.value("railId", std::string());
      x.sourceDeviceId = e.value("sourceDeviceId", std::string());
      x.sourceField = e.value("sourceField", std::string());
      x.combine = e.value("combine", std::string("replace"));
      x.scale = optNum(e, "scale");
      c.exports.push_back(std::move(x));
    }
  }
  c.reads = parseReads(j.contains("reads") ? j["reads"] : nlohmann::json());
  if (j.contains("warps") && j["warps"].is_array()) {
    for (const auto& w : j["warps"]) {
      if (!w.is_object()) continue;
      WarpBindingM b;
      b.waveform = waveformFromString(w.value("waveform", std::string("sine")));
      b.amplitude = w.value("amplitude", 0.0);
      b.periodBeats = w.value("periodBeats", 1.0);
      b.phase = w.value("phase", 0.0);
      c.warps.push_back(b);
    }
  }
  c.loop = ClipLoopConfig::fromJson(j.contains("loop") ? j["loop"] : nlohmann::json());
  if (j.contains("triggerChannel") && j["triggerChannel"].is_number())
    c.triggerChannel = j["triggerChannel"].get<int>();
  if (j.contains("triggerRead") && j["triggerRead"].is_object())
    c.triggerReadRailId = j["triggerRead"].value("railId", std::string());
  if (j.contains("triggerExports") && j["triggerExports"].is_array()) {
    for (const auto& e : j["triggerExports"]) {
      if (!e.is_object()) continue;
      TriggerExportM x;
      x.railId = e.value("railId", std::string());
      x.sourceDeviceId = e.value("sourceDeviceId", std::string());
      c.triggerExports.push_back(std::move(x));
    }
  }
  return c;
}

inline TrackM parseTrack(const nlohmann::json& j) {
  using namespace model_detail;
  TrackM t;
  if (!j.is_object()) return t;
  t.id = j.value("id", std::string());
  const std::string kind = j.value("kind", std::string("track"));
  t.kind = kind == "group"   ? TrackKind::Group
           : kind == "rail"  ? TrackKind::Rail
           : kind == "scene" ? TrackKind::Scene
                             : TrackKind::Track;
  if (j.contains("parentId") && j["parentId"].is_string())
    t.parentId = j["parentId"].get<std::string>();
  t.bypassed = j.value("bypassed", false);
  t.soloed = j.value("soloed", false);
  t.level = optNum(j, "level");
  if (j.contains("blendMode") && j["blendMode"].is_number())
    t.blendMode = j["blendMode"].get<int>();
  if (j.contains("groupInput") && j["groupInput"].is_object()) {
    t.groupInput.present = true;
    t.groupInput.mode = j["groupInput"].value("mode", std::string("transparent"));
    if (j["groupInput"].contains("color") && j["groupInput"]["color"].is_string())
      t.groupInput.color = j["groupInput"]["color"].get<std::string>();
  }
  t.railId = j.value("railId", std::string());
  t.railSigned = j.value("railSigned", false);
  if (j.contains("baseCurve") && j["baseCurve"].is_array()) {
    t.hasBaseCurve = true;
    t.baseCurve = parsePoints(j["baseCurve"]);
  }
  t.sketch = parseSketchSpec(j.contains("sketch") ? j["sketch"] : nlohmann::json());
  t.automation = parseLanes(j.contains("automation") ? j["automation"] : nlohmann::json());
  t.reads = parseReads(j.contains("reads") ? j["reads"] : nlohmann::json());
  if (j.contains("triggerRead") && j["triggerRead"].is_object())
    t.triggerReadRailId = j["triggerRead"].value("railId", std::string());
  if (j.contains("clips") && j["clips"].is_array()) {
    for (const auto& c : j["clips"]) t.clips.push_back(parseClip(c));
  }
  return t;
}

inline CompositionM parseComposition(const nlohmann::json& j) {
  CompositionM comp;
  if (!j.is_object()) return comp;
  if (j.contains("meta") && j["meta"].is_object()) {
    const auto& meta = j["meta"];
    comp.baseBPM = meta.value("baseBPM", 120.0);
    if (meta.contains("background") && meta["background"].is_object()) {
      comp.background.mode = meta["background"].value("mode", std::string("black"));
      if (meta["background"].contains("color") && meta["background"]["color"].is_string())
        comp.background.color = meta["background"]["color"].get<std::string>();
    }
  }
  if (j.contains("tracks") && j["tracks"].is_array()) {
    for (const auto& t : j["tracks"]) comp.tracks.push_back(parseTrack(t));
  }
  return comp;
}

// ── Document derivations (composition.ts helpers) ───────────────────────────

/** track.kind === 'group' && track.id === MAIN_BUS_ID. */
inline bool isMainBus(const TrackM& t) {
  return t.kind == TrackKind::Group && t.id == kMainBusId;
}

inline const TrackM* mainBusTrack(const CompositionM& comp) {
  for (const auto& t : comp.tracks) {
    if (isMainBus(t)) return &t;
  }
  return nullptr;
}

inline const TrackM* railTrackFor(const CompositionM& comp, const std::string& railId) {
  for (const auto& t : comp.tracks) {
    if (t.kind == TrackKind::Rail && t.railId == railId) return &t;
  }
  return nullptr;
}

/** Effective warp segments from every clip's warp bindings. */
inline std::vector<WarpSegment> derivedWarpSegments(const CompositionM& comp) {
  std::vector<WarpSegment> segs;
  for (const auto& track : comp.tracks) {
    if (track.kind == TrackKind::Scene) continue;  // scene extents are not timeline spans
    for (const auto& clip : track.clips) {
      for (const auto& w : clip.warps) {
        WarpSegment s;
        s.startBeat = clip.startBeat;
        s.endBeat = clip.startBeat + clip.lengthBeat;
        s.waveform = w.waveform;
        s.amplitude = w.amplitude;
        s.periodBeats = w.periodBeats;
        s.phase = w.phase;
        segs.push_back(s);
      }
    }
  }
  return segs;
}

/** Total beats spanned by the composition (ruler extent), min 64. */
inline double compositionLengthBeats(const CompositionM& comp) {
  double end = 64;
  for (const auto& t : comp.tracks) {
    if (t.kind == TrackKind::Scene) continue;  // scenes don't occupy timeline extent
    for (const auto& c : t.clips) {
      end = std::max(end, c.startBeat + c.lengthBeat);
    }
  }
  return end;
}

/**
 * Effective trigger channel per scene on a scene track (composition.ts
 * sceneChannelAssignments — LOCK-STEP). Pass 1: explicit triggerChannel values
 * claim their number. Pass 2: in array order, explicit scenes keep their
 * number; 'auto' scenes take the lowest positive integer not yet claimed
 * (then claim it). Returned in track-clip order (index-aligned with clips).
 */
inline std::vector<int> sceneChannelAssignments(const TrackM& track) {
  std::vector<int> out(track.clips.size(), 0);
  std::vector<bool> claimed;  // 1-indexed by channel number
  auto isClaimed = [&](int ch) {
    return ch > 0 && ch <= (int)claimed.size() && claimed[ch - 1];
  };
  auto claim = [&](int ch) {
    if (ch <= 0) return;
    if ((int)claimed.size() < ch) claimed.resize(ch, false);
    claimed[ch - 1] = true;
  };
  for (const auto& c : track.clips) {
    if (c.triggerChannel) claim(*c.triggerChannel);
  }
  int next = 1;
  for (size_t i = 0; i < track.clips.size(); ++i) {
    const auto& c = track.clips[i];
    if (c.triggerChannel) {
      out[i] = *c.triggerChannel;
      continue;
    }
    while (isClaimed(next)) ++next;
    out[i] = next;
    claim(next);
  }
  return out;
}

}  // namespace comp
