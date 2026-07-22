/*
 * core.transport.* — the built-in play modes as transport-controller effects.
 *
 * Each effect is the plugin form of one ClipLoopConfig arm (clip_time.h /
 * clip-time.ts clipSourceTimeAt): hosted in a clip's transport SECTION it
 * reads the parent timeline through streams.h and publishes the transport_*
 * output contract that drives the clip's content time. State field names are
 * EXACTLY the ClipLoopConfig field names, so `{...clip.loop}` (minus `mode` —
 * the mode is which effect you insert) is a complete migration, and
 * loopViewOf (composition.ts) is its inverse.
 *
 *   core.transport.time      — loops the slice at `speed` in real seconds
 *   core.transport.beat_sync — one loop per `syncBeats` beats (BPM-locked)
 *   core.transport.one_shot  — plays once; latches transport_ended off the end
 *   core.transport.random    — deterministic seeded dwell-jump walk (the
 *                              engine-side, export-stable successor of the
 *                              pump's Math.random walk)
 *
 * Sentinels (schema floats can't be optional): endSec <= 0 ⇒ the source end;
 * playStartSec < 0 ⇒ the loop start. Identity on pixels, always.
 */

#include <host.h>
#include <streams.h>
#include <val.h>
#include <cmath>

namespace transport_core {

constexpr double kEps = 1e-9;

inline double jsmod(double x, double m) { return std::fmod(std::fmod(x, m) + m, m); }

inline double tri(double x, double period) {
  const double m = jsmod(x, 2 * period);
  return period - std::abs(m - period);
}

/** clip_time.h loopedSourceTime — byte-identical port. */
inline double loopedSourceTime(double playStart, double consumed, double loopStart,
                               double loopEnd, bool pingpong, int dirSign) {
  const double loopLen = loopEnd - loopStart;
  if (loopLen <= kEps) return loopStart;
  if (dirSign >= 0) {
    const double p = playStart + consumed;
    if (p < loopEnd) return p;
    const double over = p - loopEnd;
    return pingpong ? loopEnd - tri(over, loopLen) : loopStart + jsmod(over, loopLen);
  }
  const double p = playStart - consumed;
  if (p > loopStart) return p;
  const double over = loopStart - p;
  return pingpong ? loopStart + tri(over, loopLen) : loopEnd - jsmod(over, loopLen);
}

enum Mode : int { ModeTime = 0, ModeBeatSync = 1, ModeOneShot = 2, ModeRandom = 3 };

struct State {
  // ── ClipLoopConfig-named params (see the sentinel notes above) ──
  float startSec = 0;
  float endSec = 0;        // <= 0 ⇒ source end
  float playStartSec = -1; // < 0 ⇒ loop start
  float speed = 1;
  int   direction = 0;     // 0 forward, 1 reverse (select stores the index)
  bool  pingpong = false;
  float syncBeats = 4;
  float syncBpm = 120;
  bool  syncUseBpm = false;
  float dwell = 1;
  int   dwellUnit = 0;     // 0 beat, 1 sec
  float dwellJitter = 0;
  float jumpDistanceMin = 0.1f;
  float jumpDistanceMax = 0.5f;
  int   jumpDistanceUnit = 0;  // 0 fraction, 1 sec
  float seed = 0;
  // ── one_shot latch ──
  bool  ended = false;
  double lastElapsed = -1e30;
  // ── random walk (deterministic; advanced by parent-time deltas) ──
  bool  randInit = false;
  double srcSec = 0;
  double phase = 0;
  double jitterFactor = 1;
  double lastParentSec = 0;
  double nextTarget = 0;
  uint32_t rng = 0;
};

/** Tiny deterministic LCG in [0,1) — export-stable across hosts. */
inline double nextRand(State* s) {
  s->rng = s->rng * 1664525u + 1013904223u;
  return s->rng / 4294967296.0;
}

struct Frame {
  double timeSec = 0;
  bool active = true;
  double rate = std::nan("");
  double loopStart = std::nan("");
  double loopEnd = std::nan("");
  double nextJumpSec = std::nan("");
  double jumpTargetSec = std::nan("");
  bool ended = false;
  /** Declared future (streams content events): remaining seconds until the
   *  content ends (-1 = never / unknown) + completed passes of the slice. */
  double nextEndSec = -1;
  double loopCount = 0;
};

/** The pure mapping at parent time (`elapsedSec`, `parentBeat`) — the
 *  clipSourceTimeAt arm for this mode. Returns active=false for "transparent"
 *  (the nullopt twin). `random` is handled statefully in evalFrame. */
inline void mapAt(const State* s, int mode, double elapsedSec, double localBeat,
                  double videoDurSec, Frame& out) {
  const double startSec = s->startSec;
  const double speed = s->speed;
  const int dir = s->direction == 1 ? -1 : 1;
  if (mode == ModeOneShot) {
    const double vt = startSec + dir * speed * elapsedSec;
    if (vt < -kEps || vt >= videoDurSec - kEps) {
      out.active = false;
      return;
    }
    out.timeSec = vt;
    return;
  }
  const double loopStart = startSec;
  const double loopEnd = s->endSec > 0 ? s->endSec : videoDurSec;
  const double loopLen = loopEnd - loopStart;
  if (loopLen <= kEps) {
    out.timeSec = loopStart;
    return;
  }
  const double playStart = s->playStartSec >= 0 ? s->playStartSec : loopStart;
  double consumed;
  if (mode == ModeBeatSync) {
    const double videoBeats = s->syncUseBpm ? loopLen * (s->syncBpm / 60.0)
                                            : (double)s->syncBeats;
    if (videoBeats <= kEps) {
      out.timeSec = loopStart;
      return;
    }
    consumed = (localBeat / videoBeats) * loopLen;
  } else {
    consumed = speed * elapsedSec;
  }
  const double vt = loopedSourceTime(playStart, consumed, loopStart, loopEnd,
                                     s->pingpong, dir);
  if (vt < -kEps || vt >= videoDurSec - kEps) {
    out.active = false;
    return;
  }
  out.timeSec = vt;
  out.loopStart = loopStart;
  out.loopEnd = loopEnd;
}

inline void evalFrame(State* s, int mode, Frame& out) {
  const streams::Stream parent = streams::parent();
  const streams::Stream content = streams::content();
  const double parentSec = streams::posSec(parent);
  const double parentBeat = streams::pos(parent);
  const double anchorSec = content ? streams::anchorSec(content) : 0.0;
  const double anchorBeat = content ? streams::anchor(content) : 0.0;
  double videoDurSec = content ? streams::durationSec(content) : -1;
  if (!(videoDurSec > 0)) videoDurSec = 1e9;  // no/unknown content: unbounded
  const double elapsedSec =
      (std::isnan(parentSec) ? 0.0 : parentSec) - (std::isnan(anchorSec) ? 0.0 : anchorSec);
  const double localBeat =
      (std::isnan(parentBeat) ? 0.0 : parentBeat) - (std::isnan(anchorBeat) ? 0.0 : anchorBeat);

  if (mode == ModeRandom) {
    const double lo = s->startSec;
    const double hi = s->endSec > 0 ? s->endSec : videoDurSec;
    const double range = hi - lo;
    if (range <= kEps) {
      out.timeSec = lo;
      return;
    }
    const double bpm = streams::bpm(parent);
    const double secPerBeat = 60.0 / (bpm > 1 ? bpm : 120.0);
    const double dwellSec =
        std::fmax(0.05, (s->dwellUnit == 1 ? (double)s->dwell
                                           : s->dwell * secPerBeat)) * s->jitterFactor;
    if (!s->randInit) {
      s->randInit = true;
      s->rng = (uint32_t)(s->seed * 4294967295.0) ^ 0x9e3779b9u;
      s->srcSec = lo + range * nextRand(s);
      s->nextTarget = lo + range * nextRand(s);
      s->jitterFactor = 1;
      s->lastParentSec = parentSec;
      s->phase = 0;
    }
    const double delta = parentSec - s->lastParentSec;
    s->lastParentSec = parentSec;
    s->phase += delta / std::fmax(0.05, dwellSec);
    // Drift at `speed` between jumps, looping inside the slice.
    s->srcSec = lo + jsmod(s->srcSec - lo + delta * s->speed, range);
    if (s->phase >= 1.0 || s->phase < 0.0) {
      s->phase = jsmod(s->phase, 1.0);
      const double jMin = std::fmax(0.0, (double)s->jumpDistanceMin);
      const double jMax = std::fmax(jMin, (double)s->jumpDistanceMax);
      const double distU = jMin + (jMax - jMin) * nextRand(s);
      const double dist = s->jumpDistanceUnit == 0 ? distU * range : distU;
      const double sign = nextRand(s) < 0.5 ? -1.0 : 1.0;
      double t = s->srcSec + sign * dist;
      if (t > hi) t = hi - (t - hi);  // reflect at the slice edges
      if (t < lo) t = lo + (lo - t);
      s->srcSec = std::fmin(hi, std::fmax(lo, t));
      s->jitterFactor = 1.0 + (nextRand(s) * 2.0 - 1.0) * s->dwellJitter;
      s->nextTarget = lo + range * nextRand(s);
    }
    out.timeSec = s->srcSec;
    out.rate = s->speed;
    out.nextJumpSec = std::fmax(0.0, (1.0 - s->phase) * dwellSec);
    out.jumpTargetSec = s->nextTarget;
    return;
  }

  mapAt(s, mode, elapsedSec, localBeat, videoDurSec, out);

  // Analytic-by-differencing rate (handles pingpong/reverse/beat-sync in one
  // place; eps in parent seconds). Wraps inside eps are rare; the cursor's
  // seek handling absorbs the odd sample.
  {
    constexpr double eps = 0.05;
    Frame b;
    mapAt(s, mode, elapsedSec + eps,
          localBeat + (mode == ModeBeatSync ? eps / (60.0 / 120.0) : 0.0), videoDurSec, b);
    if (out.active && b.active) {
      const double r = (b.timeSec - out.timeSec) / eps;
      if (std::isfinite(r)) out.rate = r;
    }
  }

  if (mode == ModeOneShot) {
    // Re-arm on retrigger/scrub-back (elapsed regressed), latch off the end.
    if (elapsedSec < s->lastElapsed - 1e-6) s->ended = false;
    s->lastElapsed = elapsedSec;
    if (!out.active && elapsedSec > 0) s->ended = true;
    out.ended = s->ended;
  }

  // Declared future — the host folds these into the content stream's event
  // timeline (streams events; same boundary math as contentEventGen).
  const double speedAbs = std::fmax(1e-6, std::fabs(s->speed));
  if (mode == ModeOneShot) {
    const double sliceSec = s->endSec > 0 ? s->endSec - s->startSec : videoDurSec;
    const double T = sliceSec / speedAbs;
    out.nextEndSec = out.ended ? -1 : std::fmax(0.0, T - elapsedSec);
  } else {
    const double loopStart = s->startSec;
    const double loopEnd = s->endSec > 0 ? s->endSec : videoDurSec;
    const double loopLen = loopEnd - loopStart;
    if (loopLen > kEps) {
      const double playStart = s->playStartSec >= 0 ? s->playStartSec : loopStart;
      double c1 = (s->direction == 1 ? -1 : 1) >= 0 ? loopEnd - playStart
                                                    : playStart - loopStart;
      if (c1 <= kEps) c1 = loopLen;
      double consumed;
      if (mode == ModeBeatSync) {
        const double videoBeats = s->syncUseBpm ? loopLen * (s->syncBpm / 60.0)
                                                : (double)s->syncBeats;
        consumed = videoBeats > kEps ? (localBeat / videoBeats) * loopLen : 0;
      } else {
        consumed = s->speed * elapsedSec;
      }
      out.loopCount = std::fmax(0.0, std::floor((consumed - c1) / loopLen) + 1);
    }
  }
}

inline void publishFrame(const Frame& f) {
  const auto pub = [](const char* path, double v) {
    auto h = val::number(v);
    state::setValPath(path, h);
    val::release(h);
  };
  pub("transport_time_sec", f.timeSec);
  pub("transport_active", f.active ? 1.0 : 0.0);
  pub("transport_rate", f.rate);
  pub("transport_next_jump_sec", f.nextJumpSec);
  pub("transport_jump_target_sec", f.jumpTargetSec);
  pub("transport_loop_start_sec", f.loopStart);
  pub("transport_loop_end_sec", f.loopEnd);
  pub("transport_ended", f.ended ? 1.0 : 0.0);
  pub("transport_next_end_sec", f.nextEndSec);
  pub("transport_loop_count", f.loopCount);
}

int32_t is_identity(void* self) {
  (void)self;
  return 1;
}

inline void patchShared(State* s, int n, const char* pb, const int* off,
                        const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];
    if (state::pathIs(p, l, "startSec")) s->startSec = state::patchFloat(i);
    else if (state::pathIs(p, l, "endSec")) s->endSec = state::patchFloat(i);
    else if (state::pathIs(p, l, "playStartSec")) s->playStartSec = state::patchFloat(i);
    else if (state::pathIs(p, l, "speed")) s->speed = state::patchFloat(i);
    else if (state::pathIs(p, l, "direction")) s->direction = state::patchInt(i);
    else if (state::pathIs(p, l, "pingpong")) s->pingpong = state::patchBool(i);
    else if (state::pathIs(p, l, "syncBeats")) s->syncBeats = state::patchFloat(i);
    else if (state::pathIs(p, l, "syncBpm")) s->syncBpm = state::patchFloat(i);
    else if (state::pathIs(p, l, "syncUseBpm")) s->syncUseBpm = state::patchBool(i);
    else if (state::pathIs(p, l, "dwell")) s->dwell = state::patchFloat(i);
    else if (state::pathIs(p, l, "dwellUnit")) s->dwellUnit = state::patchInt(i);
    else if (state::pathIs(p, l, "dwellJitter")) s->dwellJitter = state::patchFloat(i);
    else if (state::pathIs(p, l, "jumpDistanceMin")) s->jumpDistanceMin = state::patchFloat(i);
    else if (state::pathIs(p, l, "jumpDistanceMax")) s->jumpDistanceMax = state::patchFloat(i);
    else if (state::pathIs(p, l, "jumpDistanceUnit")) s->jumpDistanceUnit = state::patchInt(i);
    else if (state::pathIs(p, l, "seed")) {
      s->seed = state::patchFloat(i);
      s->randInit = false;  // re-seed the walk
    }
  }
}

/** Shared schema pieces: the transport_* outputs + the capability. */
inline state::Schema& outputFields(state::Schema& sch) {
  return sch
      .group("output", "Output")
      .floatField("transport_time_sec", 0.f, -1e6f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("Time", "T")
      .floatField("transport_active", 1.f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
        .label("Active", "Act")
      .floatField("transport_rate", 1.f, -8.f, 8.f, state::SecondaryOutput, "signed")
        .label("Rate", "Rt")
      .floatField("transport_next_jump_sec", -1.f, -1.f, 600.f, state::SecondaryOutput, "unsigned")
        .label("Next Jump", "Jmp")
      .floatField("transport_jump_target_sec", -1.f, -1.f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("Jump Target", "JTo")
      .floatField("transport_loop_start_sec", 0.f, 0.f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("Loop Start", "L0")
      .floatField("transport_loop_end_sec", 0.f, 0.f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("Loop End", "L1")
      .floatField("transport_ended", 0.f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
        .label("Ended", "End")
      .floatField("transport_next_end_sec", -1.f, -1.f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("Next End", "NEd")
      .floatField("transport_loop_count", 0.f, 0.f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("Loops", "Lps")
      .capability(state::Capability::TransportController);
}

}  // namespace transport_core

// ── The four effects: thin mode wrappers over the shared core ───────────────

#define TRANSPORT_EFFECT(ns, MODE)                                              \
  namespace ns {                                                                \
  void* create() { return new transport_core::State(); }                        \
  void destroy(void* self) { delete static_cast<transport_core::State*>(self); }\
  void init(void* self) {                                                       \
    auto* s = static_cast<transport_core::State*>(self);                        \
    if (s) *s = transport_core::State{};                                        \
  }                                                                             \
  void tick(void* self, double dt) {                                            \
    (void)dt;                                                                   \
    auto* s = static_cast<transport_core::State*>(self);                        \
    if (!s) return;                                                             \
    transport_core::Frame f;                                                    \
    transport_core::evalFrame(s, transport_core::MODE, f);                      \
    transport_core::publishFrame(f);                                            \
  }                                                                             \
  void render(void* self, int w, int h) { (void)self; (void)w; (void)h; }       \
  void on_state_patched(void* self, int n, const char* pb, const int* off,      \
                        const int* len, const int* ops) {                       \
    transport_core::patchShared(static_cast<transport_core::State*>(self),      \
                                n, pb, off, len, ops);                          \
  }                                                                             \
  int32_t is_identity(void* self) { return transport_core::is_identity(self); } \
  }

TRANSPORT_EFFECT(transport_time, ModeTime)
TRANSPORT_EFFECT(transport_beat_sync, ModeBeatSync)
TRANSPORT_EFFECT(transport_one_shot, ModeOneShot)
TRANSPORT_EFFECT(transport_random, ModeRandom)

#undef TRANSPORT_EFFECT

namespace transport_time {
void module_init() {
  auto sch = state::Schema()
      .group("slice", "Slice")
      .floatField("startSec", 0.f, 0.f, 3600.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("Start", "In")
      .floatField("endSec", 0.f, 0.f, 3600.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("End (0=source end)", "Out")
      .floatField("playStartSec", -1.f, -1.f, 3600.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("Play Start (-1=loop start)", "PS")
      .group("motion", "Motion")
      .floatField("speed", 1.f, 0.01f, 8.f, state::PrimaryInput).label("Speed", "Spd")
      .selectField("direction", 0, state::PrimaryInput,
                   {{"Forward", 0}, {"Reverse", 1}}).label("Direction", "Dir")
      .boolField("pingpong", false, state::PrimaryInput).label("Ping-pong", "PP");
  state::init("core.transport.time", {1, 0, 0}, transport_core::outputFields(sch));
}
}  // namespace transport_time

namespace transport_beat_sync {
void module_init() {
  auto sch = state::Schema()
      .group("slice", "Slice")
      .floatField("startSec", 0.f, 0.f, 3600.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("Start", "In")
      .floatField("endSec", 0.f, 0.f, 3600.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("End (0=source end)", "Out")
      .floatField("playStartSec", -1.f, -1.f, 3600.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("Play Start (-1=loop start)", "PS")
      .group("sync", "Sync")
      .floatField("syncBeats", 4.f, 0.25f, 256.f, state::PrimaryInput, nullptr, 0.f, "beats")
        .label("Loop Beats", "Bts")
      .boolField("syncUseBpm", false, state::PrimaryInput).label("Lock To BPM", "BPM?")
      .floatField("syncBpm", 120.f, 20.f, 300.f, state::PrimaryInput).label("Source BPM", "BPM")
      .selectField("direction", 0, state::PrimaryInput,
                   {{"Forward", 0}, {"Reverse", 1}}).label("Direction", "Dir")
      .boolField("pingpong", false, state::PrimaryInput).label("Ping-pong", "PP");
  state::init("core.transport.beat_sync", {1, 0, 0}, transport_core::outputFields(sch));
}
}  // namespace transport_beat_sync

namespace transport_one_shot {
void module_init() {
  auto sch = state::Schema()
      .group("slice", "Slice")
      .floatField("startSec", 0.f, 0.f, 3600.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("Start", "In")
      .group("motion", "Motion")
      .floatField("speed", 1.f, 0.01f, 8.f, state::PrimaryInput).label("Speed", "Spd")
      .selectField("direction", 0, state::PrimaryInput,
                   {{"Forward", 0}, {"Reverse", 1}}).label("Direction", "Dir");
  state::init("core.transport.one_shot", {1, 0, 0}, transport_core::outputFields(sch));
}
}  // namespace transport_one_shot

namespace transport_random {
void module_init() {
  auto sch = state::Schema()
      .group("slice", "Slice")
      .floatField("startSec", 0.f, 0.f, 3600.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("Start", "In")
      .floatField("endSec", 0.f, 0.f, 3600.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("End (0=source end)", "Out")
      .group("walk", "Walk")
      .floatField("speed", 1.f, 0.f, 8.f, state::PrimaryInput).label("Drift Speed", "Spd")
      .floatField("dwell", 1.f, 0.05f, 32.f, state::PrimaryInput).label("Dwell", "Dw")
      .selectField("dwellUnit", 0, state::PrimaryInput,
                   {{"Beats", 0}, {"Seconds", 1}}).label("Dwell Unit", "DwU")
      .floatField("dwellJitter", 0.f, 0.f, 1.f, state::PrimaryInput).label("Jitter", "Jit")
      .floatField("jumpDistanceMin", 0.1f, 0.f, 60.f, state::PrimaryInput)
        .label("Jump Min", "JMin")
      .floatField("jumpDistanceMax", 0.5f, 0.f, 60.f, state::PrimaryInput)
        .label("Jump Max", "JMax")
      .selectField("jumpDistanceUnit", 0, state::PrimaryInput,
                   {{"Fraction", 0}, {"Seconds", 1}}).label("Jump Unit", "JU")
      .floatField("seed", 0.f, 0.f, 1.f, state::PrimaryInput).label("Seed", "Sd");
  state::init("core.transport.random", {1, 0, 0}, transport_core::outputFields(sch));
}
}  // namespace transport_random
