#pragma once
/*
 * transient_shaper.h — Adaptive beat-grid transient sharpener core.
 *
 * Sharpens the attack of a heavily pre-smoothed 0..1 band level (Resolume's
 * FFT bass), using the host beat grid to LEARN where onsets repeat within the
 * bar and enhance exactly those. Detection-first: a boost only ever fires on
 * a real detected rise in the live signal — history never invents one. The
 * learned per-slot confidence (a) scales the boost strength, easing in over
 * bars of confirmed hits and back out on misses (the false-positive guard),
 * and (b) lowers the detection threshold inside confident prediction windows
 * so an expected kick triggers on the first hint of a rise — that early
 * trigger plus a fast synthetic attack toward the learned peak is where the
 * "faster rise" comes from.
 *
 *   Detector — fast (15 ms) vs slow (120 ms) one-pole followers; their
 *     difference `d` is the rise metric. A valley tracker remembers the last
 *     local minimum: its bar-grid position is the backtracked ONSET time
 *     (attributed to the grid instead of the late fire time, so detection
 *     latency doesn't skew learning) and `fast - floor` gates out slow swells
 *     that have slope but no amplitude. Refractory + re-arm hysteresis stop
 *     double-triggers on one kick.
 *   Grid — S slots per bar (8ths/16ths). Per slot: hit/miss confidence EMA,
 *     learned peak, learned sub-slot onset offset (recenters the prediction
 *     window). Windows score at their END, so a breakdown starts decaying
 *     confidence mid-bar. Learn rate = `adapt_bars` (misses fade 1.5x faster
 *     than hits build).
 *   Enhancement — on a fire in a slot with confidence c, a synthetic envelope
 *     attacks (12 ms) from the live level toward level + (peak - level) * c,
 *     then relaxes onto the live signal (90 ms) and hands off seamlessly via
 *     max(). An UNLEARNED slot has c = 0: an unpredicted rise learns and
 *     plucks but gets no primary boost. `amount` is a plain static dry/wet —
 *     confidence is the only adaptive easing (no double-smoothing).
 *   Pluck — second output: the same trigger driving a 12 ms attack to 1 and a
 *     parameterized exponential release — the transient as a percussive AD,
 *     without the bass tail. Fires on unpredicted onsets too.
 *
 * Transport: a normal bar wrap continues seamlessly; any other bar-phase jump
 * (seek/scrub) reseeds the runtime layer (followers, envelopes, window flags)
 * but PERSISTS the learned slots — transport moved, the music didn't. A
 * paused transport just freezes the grid (no decay, no window scoring); live
 * detection still works. All poles are exp(-dt/tau) forms, robust to frame
 * jitter; dt is clamped to 50 ms so a stall can't step the filters.
 *
 * Header-only and dependency-light (pure C++, no host imports — the caller
 * passes input/barPhase/bpm/dt) so it compiles in the native runtime and any
 * wasm effect bundle. Backs mod.shaper.transient_shaper; behavior is pinned
 * by native/tests/test_transient_shaper.cpp with a synthetic kick generator.
 */

#include <cmath>

namespace transient_shaper {

constexpr int kMaxSlots = 16;

// Detector poles (seconds).
constexpr float kTauFast = 0.015f;
constexpr float kTauSlow = 0.120f;
constexpr float kTauFloor = 0.400f;   // valley drift-up: re-arms after each tail
// Synthetic envelope. The attack is the product: at a 60 fps render a 6 ms
// tau is a one-frame snap, at 240 fps it's still a smooth (if fierce) rise.
constexpr float kTauAttack = 0.006f;
constexpr float kTauRelease = 0.090f;  // relax onto the live signal
constexpr float kAttackMaxSec = 0.040f;
// Threshold shape: T0 spans loose..tight over `sensitivity`; confidence lowers
// it by up to kConfLower, never below the absolute noise guard.
constexpr float kThreshLoose = 0.10f;
constexpr float kThreshTight = 0.015f;
constexpr float kThreshAbsFloor = 0.008f;
constexpr float kConfLower = 0.7f;
constexpr float kRearmFrac = 0.3f;    // d must dip below kRearmFrac*T0 to re-arm
constexpr float kRiseAmpFrac = 1.5f;  // rise amplitude must exceed this * T
// Prediction window around the learned onset, slot units.
constexpr float kWinBefore = 0.35f;
constexpr float kWinAfter = 0.50f;
constexpr float kConfWindowMin = 0.1f;  // below this a slot casts no window

struct Params {
  float sensitivity = 0.5f;
  float amount = 0.75f;
  float adapt_bars = 4.0f;
  float pluck_release = 0.18f;
  int slots = 16;   // 8ths or 16ths per bar
};

struct Slot {
  float conf = 0.0f;   // hit/miss EMA, 0..1
  float peak = 0.0f;   // learned onset peak level
  float off = 0.0f;    // learned sub-slot onset offset, (-0.5, 0.5]
  bool hit = false;    // fired inside the current window cycle
  bool closed = false; // window already scored this cycle
};

struct Result {
  float output = 0.0f;      // enhanced primary
  float pluck = 0.0f;       // percussive AD of the detected transient
  float confidence = 0.0f;  // live conf of the most recently FIRED slot —
                            // steady between kicks, climbs as the pattern
                            // locks in, decays through a breakdown
  bool fired = false;       // an onset fired THIS tick (test hook)
  int fired_slot = -1;      // attributed slot of that fire (test hook)
};

struct Shaper {
  // Learned layer — persists across seeks.
  Slot slots[kMaxSlots];
  int cur_slots = 16;

  // Detector runtime.
  float fast = 0.0f, slow = 0.0f;
  float floor_v = 0.0f;
  float valley_pos = 0.0f;      // slot units at the last floor decrease
  bool armed = true;
  float since_fire = 1e6f;      // seconds

  // Synthetic enhancement envelope.
  bool env_active = false, env_attack = false;
  float env = 0.0f, env_target = 0.0f, env_elapsed = 0.0f;

  // Pluck AD.
  bool pluck_attack = false;
  float pluck = 0.0f, pluck_elapsed = 0.0f;

  // Peak capture (fire -> re-arm).
  bool capturing = false;
  int capture_slot = 0;
  float capture_peak = 0.0f, capture_elapsed = 0.0f;

  // Grid tracking. prev_phase < 0 = first-tick sentinel (forces a reseed).
  double prev_phase = -1.0;
  float prev_u = 0.0f;
  int last_fired = -1;   // slot of the most recent fire (telemetry anchor)

  void reset() { *this = Shaper{}; }

  // Seek/scrub: reseed everything transient, PERSIST the learned slots. All
  // windows go CLOSED (they sit out until their next start crossing re-opens
  // them) so a half-elapsed window can't score a bogus miss.
  void reseedRuntime(float x, float u) {
    fast = slow = floor_v = x;
    valley_pos = u;
    armed = true;
    since_fire = 1e6f;
    env_active = env_attack = false;
    env = env_target = env_elapsed = 0.0f;
    pluck_attack = false;
    pluck = pluck_elapsed = 0.0f;
    capturing = false;
    prev_u = u;
    for (int i = 0; i < kMaxSlots; i++) {
      slots[i].hit = false;
      slots[i].closed = true;
    }
  }

  Result tick(float x, double barPhase, double bpm, double dt_in, const Params& p) {
    // A slot-count change invalidates the learned grid wholesale.
    int S = p.slots < 1 ? 1 : (p.slots > kMaxSlots ? kMaxSlots : p.slots);
    if (S != cur_slots) {
      for (int i = 0; i < kMaxSlots; i++) slots[i] = Slot{};
      cur_slots = S;
      capturing = false;
    }

    if (!std::isfinite(x)) x = slow;                       // NaN patch guard
    x = x < 0.0f ? 0.0f : (x > 1.0f ? 1.0f : x);
    float dt = (float)dt_in;
    if (!std::isfinite(dt) || dt < 0.0f) dt = 0.0f;
    if (dt > 0.050f) dt = 0.050f;                          // stall clamp

    const double phase = barPhase - std::floor(barPhase);  // frac
    const float u = (float)(phase * S);                    // slot-unit position
    const double bar_seconds = 240.0 / (bpm > 1.0 ? bpm : 1.0);
    const float slot_seconds = (float)(bar_seconds / S);
    const float adapt = p.adapt_bars < 1.0f ? 1.0f : p.adapt_bars;
    const float a_up = 1.0f / adapt;
    const float a_dn = 1.5f / adapt > 1.0f ? 1.0f : 1.5f / adapt;

    Result r;

    // --- Transport discontinuities: wrap continues, a jump reseeds runtime.
    if (prev_phase < 0.0) {
      reseedRuntime(x, u);
    } else {
      const double dphase = phase - prev_phase;
      const double jump = std::fmax(0.05, 8.0 * dt / bar_seconds);
      if (dphase < -0.5) { /* normal bar wrap */ }
      else if (std::fabs(dphase) > jump) reseedRuntime(x, u);
    }
    prev_phase = phase;

    if (dt > 0.0f) {
      // --- Detector followers + valley tracker.
      fast += (x - fast) * (1.0f - std::exp(-dt / kTauFast));
      slow += (x - slow) * (1.0f - std::exp(-dt / kTauSlow));
      if (x <= floor_v) {
        floor_v = x;
        valley_pos = u;   // the rise, when it comes, started HERE
      } else {
        floor_v += (x - floor_v) * (1.0f - std::exp(-dt / kTauFloor));
      }
      const float d = fast - slow;
      const float rise_amp = fast - floor_v;
      since_fire += dt;

      // --- Threshold: sensitivity sets the base, the strongest prediction
      // window containing `u` lowers it (floored — noise can't sneak under).
      const float t0 = kThreshLoose + (kThreshTight - kThreshLoose) * p.sensitivity;
      float c_win = 0.0f;
      for (int s = 0; s < S; s++) {
        if (slots[s].conf <= kConfWindowMin) continue;
        float rel = u - ((float)s + slots[s].off);
        rel -= S * std::floor(rel / S + 0.5f);   // wrap to [-S/2, S/2)
        if (rel >= -kWinBefore && rel <= kWinAfter)
          c_win = std::fmax(c_win, slots[s].conf);
      }
      const float thresh = std::fmax(t0 * (1.0f - kConfLower * c_win), kThreshAbsFloor);

      if (!armed && d < kRearmFrac * t0) armed = true;

      // --- Peak capture ends at re-arm (post-peak) or a 1.5-slot timeout.
      if (capturing) {
        capture_peak = std::fmax(capture_peak, x);
        capture_elapsed += dt;
        if (armed || capture_elapsed > 1.5f * slot_seconds) {
          Slot& cs = slots[capture_slot];
          if (cs.peak <= 0.0f) cs.peak = capture_peak;     // first sighting: snap
          else cs.peak += (capture_peak - cs.peak) * a_up;
          capturing = false;
        }
      }

      // --- Fire: a real rise, with amplitude, past refractory, re-armed.
      const float refractory =
          std::fmax(0.050f, std::fmin(0.5f * slot_seconds, 0.200f));
      if (armed && d > thresh && rise_amp > kRiseAmpFrac * thresh &&
          since_fire > refractory) {
        armed = false;
        since_fire = 0.0f;

        // Attribute to the NEAREST slot line of the backtracked onset (the
        // valley) — a kick starting just before the line lands on the line.
        const long nearest = std::lround(valley_pos);
        const int s_idx = (int)(nearest % S);
        const float off_meas = valley_pos - (float)nearest;
        Slot& sl = slots[s_idx];
        const float c = sl.conf;   // confidence BEFORE this hit

        if (c > 0.2f) sl.off += (off_meas - sl.off) * a_up;
        else sl.off = off_meas;
        if (sl.closed) sl.conf += (1.0f - sl.conf) * a_up;  // late fire: score now
        else sl.hit = true;

        capturing = true;
        capture_slot = s_idx;
        capture_peak = x;
        capture_elapsed = 0.0f;

        if (c > 0.0f) {
          if (!env_active) env = x;   // retrigger keeps the running level
          env_active = true;
          env_attack = true;
          env_elapsed = 0.0f;
          env_target = x + (std::fmax(sl.peak, x) - x) * c;
        }

        pluck_attack = true;
        pluck_elapsed = 0.0f;

        r.fired = true;
        r.fired_slot = s_idx;
        last_fired = s_idx;
      }

      // --- Window bookkeeping: opening clears the cycle, closing scores it.
      // Crossing test over the (prev_u, u] path, wrap-aware. A frozen
      // transport crosses nothing: no decay while paused.
      const float pu = prev_u;
      auto crossed = [&](float target) {
        if (u == pu) return false;
        if (u > pu) return target > pu && target <= u;
        return target > pu || target <= u;   // wrapped
      };
      auto wrapS = [&](float v) {
        v = v - S * std::floor(v / S);
        return v;
      };
      for (int s = 0; s < S; s++) {
        Slot& sl = slots[s];
        if (crossed(wrapS((float)s + sl.off - kWinBefore))) {
          sl.closed = false;
          sl.hit = false;
        }
        if (!sl.closed && crossed(wrapS((float)s + sl.off + kWinAfter))) {
          sl.conf += ((sl.hit ? 1.0f : 0.0f) - sl.conf) * (sl.hit ? a_up : a_dn);
          sl.hit = false;
          sl.closed = true;
        }
      }
      prev_u = u;

      // --- Synthetic envelope: fast attack toward the learned peak, then
      // relax onto the live signal; max() below makes the handoff seamless.
      if (env_active) {
        if (env_attack) {
          env += (env_target - env) * (1.0f - std::exp(-dt / kTauAttack));
          env_elapsed += dt;
          // End on the REMAINING gap, not the absolute level — the signal
          // rides an elevated floor, so a fraction-of-target test would hand
          // off partway up the rise and let the slow release finish the climb.
          if (env_target - env < 0.01f || env_elapsed >= kAttackMaxSec)
            env_attack = false;
        } else {
          env += (x - env) * (1.0f - std::exp(-dt / kTauRelease));
          if (std::fabs(env - x) < 0.005f) env_active = false;
        }
      }

      // --- Pluck AD.
      if (pluck_attack) {
        pluck += (1.0f - pluck) * (1.0f - std::exp(-dt / kTauAttack));
        pluck_elapsed += dt;
        if (pluck >= 0.98f || pluck_elapsed >= kAttackMaxSec) pluck_attack = false;
      } else if (pluck > 0.0f) {
        pluck *= std::exp(-dt / std::fmax(p.pluck_release, 1e-3f));
        if (pluck < 1e-3f) pluck = 0.0f;   // flush to exact rest
      }
    }

    // --- Compose. `amount` is a static dry/wet; with no active envelope the
    // output IS the input (bit-exact passthrough at rest / zero history).
    const float amt = p.amount < 0.0f ? 0.0f : (p.amount > 1.0f ? 1.0f : p.amount);
    const float boosted = env_active ? std::fmax(x, env) : x;
    float out = x + (boosted - x) * amt;
    out = out < 0.0f ? 0.0f : (out > 1.0f ? 1.0f : out);
    r.output = out;
    r.pluck = pluck;
    r.confidence = last_fired >= 0 ? slots[last_fired % S].conf : 0.0f;
    return r;
  }
};

}  // namespace transient_shaper
