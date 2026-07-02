// comp_model.h — the composition-executor's document model (Phase A subset).
//
// LOCK-STEP: web/src/views/arrangement/model/composition.ts. These structs are
// the C++ twins of the arrangement document types; keep field names, defaults,
// and optionality byte-for-byte in sync (shared goldens:
// native/tests/test_comp_time.cpp ↔ web/.../engine/comp-goldens.test.ts).
//
// Phase A carries only what the pure timing/gate ports need (WarpSegment,
// ClipLoopConfig). The full Composition mirror lands with comp_model.cpp.

#pragma once

#include <cstdint>
#include <optional>
#include <string>

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

}  // namespace comp
