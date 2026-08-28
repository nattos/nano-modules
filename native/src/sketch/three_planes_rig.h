#pragma once
/*
 * three_planes_rig.h — the show logic behind `mod.rig.three_planes`.
 *
 * `source.mesh.three_planes` is deliberately dumb: it projects three stacked
 * quads and shades them, and every rhythmic decision lives outside it. This
 * header IS that outside — a MODE that paints the tower (an EV meter with peak
 * hold and per-layer flams, or Solid, which does nothing at all) plus four
 * one-shot camera moves that compose on top of either — kept host-free so the
 * wasm effect and a Catch2 golden run byte-identical code with no GPU and no
 * ABI. Same arrangement as param_smoothing.h / envelope.h / transient_shaper.h.
 *
 * On top of all of that sits the SWEEP: one bipolar knob, performed live,
 * whose POSITION dims the whole tower (with a wide deadzone through the middle
 * and a flickering fade at either end) and whose SPEED throws diagonal glints
 * across it. See SweepCore — it is the only thing here that reads the input's
 * motion rather than its value, and it works in every mode. The glints are
 * three_planes' own particles; this only publishes the rail that drives them.
 *
 * THE FOUR SIGNALS ARE GATES, NOT FADERS. They come from `beatsync`'s Art-Net
 * output (four DMX channels: heavy / regular / decor / uniform), where a hit is
 * a lit window rather than a level — so everything here quantizes at 0.5 and
 * ignores velocity. `level[c]` is what channel `c` means on the meter's axis,
 * not how hard it was struck.
 *
 * THE OUTPUTS ARE NORMALISED, not in the units three_planes shows. A wire drawn
 * by hand carries no `magnitude` key, so the executor folds it into the DEST
 * field's [min,max] (tap_mod.h applyMagnitude, Replace). Publishing the
 * destination slider's *position* is therefore what makes a naive drag land on
 * the right value; kElevationMaxDeg / kSpacingMax mirror three_planes' declared
 * ranges and must be kept in step with its schema.
 */

#include <cmath>

#include "knob_rate.h"

namespace three_planes_rig {

constexpr int kLayers = 3;
constexpr int kSignals = 4;

/// Mirrors `source.mesh.three_planes`' declared ranges. Its `elevation` field is
/// [0,89] degrees and `plane_spacing` is [0,1.5]; both are what the normalised
/// outputs below divide by. KEEP IN STEP with three_planes/main.cpp's schema.
constexpr float kElevationMaxDeg = 89.0f;
constexpr float kSpacingMax = 1.5f;

/// A frame longer than this is a transport stall, not slow motion — ageing the
/// peak hold by it in one step would blank the meter. Same clamp motion.peak_decay
/// uses for the same reason.
constexpr float kMaxDt = 0.25f;

/// The sweep knob's rest position. It is conceptually SIGNED — a bipolar knob
/// centred here — but its magnitude is 0..1 like every other MIDI mapping in
/// the rig, so the centre is 0.5 and `bp = 2*sweep - 1` is the signed reading.
/// An unwired card sits here, which is exactly full intensity and no motion,
/// so the sweep costs a sketch that ignores it nothing at all.
constexpr float kSweepCenter = 0.5f;

/// Below this much of the tower's brightness the sweep counts as MUTED, and a
/// held charge is thrown. Derived from the dimmer rather than being its own
/// threshold, so "the release happens at the ends" stays true however the
/// deadzone and the fade depth are set.
constexpr float kMuteGain = 0.06f;

/// Which one-shot is running. Monophonic: a new trigger replaces the running
/// one outright, which reads as a pop — consistent with the moves themselves.
enum Anim { AnimNone = -1, AnimShow = 0, AnimSweepUp = 1, AnimGlance = 2, AnimUnfold = 3 };
constexpr int kAnimCount = 4;

/// What drives the layers. The moves are OUTSIDE this choice — they compose on
/// top of whatever the mode is doing, because they move the camera and the mode
/// paints the tower.
///
/// `ModeSolid` is the deliberate absence of reactivity: no meter, no cap, no
/// flams, just three lit floors and whatever move is running. It exists because
/// a piece that is reacting the whole time has nothing to react FROM — Solid is
/// the pose you cut back to.
enum Mode { ModeEvMeter = 0, ModeSolid = 1 };

struct Rgb {
  float r = 0.0f, g = 0.0f, b = 0.0f;
};

inline Rgb lerpRgb(const Rgb& a, const Rgb& b, float t) {
  return Rgb{a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t};
}

/// Everything the card authors. Read fresh each tick — a wire may be moving any
/// of it, so nothing is cached across frames.
struct Params {
  int mode = ModeEvMeter;

  // What each signal means on the meter axis. ch3 and ch4 both name the top.
  float level[kSignals] = {1.0f, 2.0f, 3.0f, 3.0f};

  // Ballistics, all in SECONDS. `*_fall` is seconds to travel ONE level, so the
  // fall reads the same whether it starts from 1 or from 3.
  float meter_fall = 0.35f;
  float peak_hold = 1.2f;
  float peak_fall = 0.9f;

  /// false — every layer under the meter is lit (a solid tower).
  /// true  — a layer is lit only while its own flam runs, so the tower has
  ///         holes. The peak cap still always shows.
  bool allow_holes = false;
  float emission_on = 1.0f;
  float emission_off = 0.12f;

  float flam_time = 0.18f;      ///< seconds
  float flam_color = 1.0f;      ///< how far the flam pushes toward the alternate colour
  float flam_emission = 0.35f;  ///< additive brightness blip, clamped at 1

  Rgb primary{1.00f, 0.22f, 0.62f};    ///< magenta — the flam colour of a plain layer
  Rgb secondary{0.72f, 0.35f, 1.00f};  ///< violet — where a plain layer settles
  Rgb highlight{0.30f, 0.85f, 1.00f};  ///< cyan — where the PEAK CAP settles

  float azimuth_base = 0.125f;                  ///< [0,1] turn, 0.125 = 45 deg
  float elevation_base = 35.264389682754654f;   ///< degrees, true isometric
  float spacing_base = 0.42f;

  float show_time = 1.2f, sweep_time = 1.5f, glance_time = 0.8f, unfold_time = 1.6f;
  /// Seconds a move SITS on its end pose before popping back. Shared by all
  /// four, because it is about how the landing reads, not about the move.
  /// Defaults to 0 — the original gesture is travel-then-pop, and a hold is
  /// something you dial in.
  float move_hold = 0.0f;
  float show_azimuth = 30.0f;      ///< total swing, degrees (+half .. −half)
  float glance_azimuth = 30.0f;
  float glance_elevation = 15.0f;  ///< total swing, degrees, travelling UP
  float sweep_target = 0.0f;       ///< absolute elevation the sweep ends at, degrees
  /// Where the sweep STARTS, in degrees either side of the baseline. Negative
  /// dips the deck before it climbs — the wind-up that makes the rise read as
  /// a rise. 0 starts flat on the baseline, which is the one move with no
  /// entry pop.
  float sweep_start = 0.0f;
  /// Shape of the travel between the two poses. 0 linear, 0.5 smoothstep
  /// (the default, and what the moves had before this was a knob), 1
  /// smootherstep. The ends still pop — this only decides how the middle feels.
  float move_ease = 0.5f;

  // --- Sweep: one bipolar knob, performed ---------------------------------
  // Read fresh each tick like everything else here. `sweep` is the knob
  // itself; the rest shape what it does. See SweepCore for the reasoning.
  float sweep = kSweepCenter;
  float sweep_sense = 2.0f;      ///< full-scale drag speed, knob ranges / second
  float sweep_window = 0.09f;    ///< boxcar span the speed is measured over, s
  float sweep_decay = 0.18f;     ///< motion envelope release, s
  float sweep_deadzone = 0.45f;  ///< fraction of each half that stays FULLY lit
  float sweep_depth = 1.0f;      ///< how far the extremes fade; 1 = to black
  float sweep_flicker = 0.6f;    ///< how hard the tubes stutter through the fade
  float latch_drive = 2.0f;      ///< how readily a pass through the middle charges
  float ring_time = 1.4f;        ///< seconds the thrown release takes to ring out
};

/// One frame of rails. Floats are already normalised for publication.
struct Out {
  float meter = 0.0f;       ///< level/3
  float peak = 0.0f;        ///< level/3
  float anim_phase = 0.0f;  ///< eased 0..1 while a move runs, 0 idle
  float emission[kLayers] = {};
  Rgb color[kLayers] = {};
  float azimuth = 0.0f;    ///< [0,1] turn
  float elevation = 0.0f;  ///< deg / kElevationMaxDeg
  float spacing = 0.0f;    ///< units / kSpacingMax
  int peak_layer = -1;     ///< which layer wears the cap, −1 when the meter is dead

  // --- Sweep rails --------------------------------------------------------
  float sweep_speed = 0.0f;  ///< 0..1 motion envelope — how hard the knob is moving
  float sweep_out = 0.5f;    ///< the knob, passed through for three_planes' glints
  float release = 0.0f;      ///< 1 at the throw, falling to 0 across the ring-out
};

namespace detail {

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline float clamp01(float v) { return clampf(v, 0.0f, 1.0f); }
inline float lerpf(float a, float b, float t) { return a + (b - a) * t; }

/// Ease in AND out, at a chosen strength. The moves pop at their ends on
/// purpose; this is only about how the travel between those poses feels.
///
/// Two halves of one knob: 0..0.5 fades linear into smoothstep, 0.5..1 fades
/// smoothstep into smootherstep. Straight-line travel at one end, a long float
/// out of the start and into the landing at the other, and the old fixed
/// smoothstep exactly in the middle.
inline float easeCurve(float t, float ease) {
  t = clamp01(t);
  const float s1 = t * t * (3.0f - 2.0f * t);                       // smoothstep
  const float s2 = t * t * t * (t * (t * 6.0f - 15.0f) + 10.0f);    // smootherstep
  const float e = clamp01(ease);
  return e <= 0.5f ? lerpf(t, s1, e * 2.0f) : lerpf(s1, s2, (e - 0.5f) * 2.0f);
}

/// [0,1) turn, so a sweep past 360 deg wraps instead of clamping at the top.
inline float wrap01(float v) {
  v -= (float)(int)v;
  return v < 0.0f ? v + 1.0f : v;
}

/// Which layer a meter level names. 1.0 → bottom, 2.0 → middle, 3.0 → top; a
/// fractional level rounds UP, so a decaying peak steps down at the integers.
inline int layerOf(float level) {
  int i = (int)level;
  if ((float)i < level) ++i;   // ceil, without pulling in <cmath>
  i -= 1;
  return i < 0 ? 0 : (i >= kLayers ? kLayers - 1 : i);
}

/// xorshift32, so the flicker is deterministic given the same dt sequence —
/// which is what lets the Catch2 goldens pin it at all. Returns [0,1).
inline float rand01(unsigned& state) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return (float)(state & 0xFFFFFFu) * (1.0f / 16777216.0f);
}

}  // namespace detail

/// The sweep knob's dynamics: a motion estimator, a position law, and the
/// flicker that hangs off both.
///
/// ONE knob, performed live — swept to the beat — doing two unrelated jobs at
/// once, which is the point of it:
///
///   WHERE it is  → overall emission. Bipolar and strongly squashed: most of
///                  the middle is a deadzone at full brightness, and only out
///                  near either extreme does the tower fade toward black. So
///                  you can ride the knob around centre without touching the
///                  look, and reaching for an end is a deliberate blackout.
///   REACHING AN END  → the throw. The mute at either extreme is not just
///                  darkness: passing through the middle charges by how HARD
///                  you went through it, and arriving at a mute spends that
///                  charge as a `release` ringing out on its own clock.
///                  three_planes turns it into rings flying off the stack, so
///                  a short vigorous sweep lands as an impulse.
///   HOW FAST it moves → glints, over in three_planes. Those are thrown by
///                  the GESTURE rather than by a level, so what goes out is
///                  the knob itself; the particles live over there and read
///                  its motion themselves. See three_planes_glints.h.
///
/// The rate estimate is knob_rate.h's boxcar, shared with the glints — see
/// there for why a MIDI knob cannot simply be differenced per frame.
///
/// The flicker is deliberately loudest in the MIDDLE of the fade — a tower at
/// full brightness has nothing to stutter about, and one already black has
/// nothing to show. It peaks where the light is halfway out, which is where a
/// tired tube actually struggles, and only ever touches ONE floor at a time.
struct SweepCore {
  /// The speed measurement itself, shared with source.mesh.three_planes'
  /// glints. See knob_rate.h for why it is a boxcar and not a difference.
  knob_rate::KnobRate rate;

  float speed = 0.0f;   ///< 0..1 motion envelope: instant attack, timed release

  /// The throw. `charge` takes the vigour of a pass through the middle and is
  /// spent the moment the tower mutes; `release` is what was thrown, ringing
  /// out on its own clock afterwards. `armed` stops one mute firing twice.
  float charge = 0.0f;
  float release = 0.0f;
  bool armed = false;
  /// The knob as of the previous tick. The vigorous case is exactly the one
  /// that can clear the whole band between two samples — which would otherwise
  /// charge nothing at all, and lose the best gesture on the card.
  float last = kSweepCenter;

  int flick_layer = -1;   ///< the floor currently mid-blip, −1 between blips
  float flick_t = 0.0f;   ///< seconds left in the current blip (or gap)
  unsigned rng = 0x9e3779b9u;

  /// How far from home the knob is, 0 at the centre and 1 at either end. The
  /// sweep is bipolar in concept and unsigned in magnitude, and this is where
  /// that conversion lives.
  static float magnitudeOf(float sweep) {
    using namespace detail;
    const float d = sweep - kSweepCenter;
    return clamp01((d < 0.0f ? -d : d) / kSweepCenter);
  }

  /// The position law. 1 across the deadzone, easing to `1 - depth` at either
  /// extreme. Smoothstep rather than a straight line so the shoulder where the
  /// fade begins has no corner in it — a corner is exactly what you would see
  /// riding the knob past it.
  static float positionGain(const Params& p, float sweep) {
    using namespace detail;
    const float mag = magnitudeOf(sweep);
    const float dz = clamp01(p.sweep_deadzone);
    const float t = clamp01((mag - dz) / (1.0f - dz > 1e-4f ? 1.0f - dz : 1e-4f));
    const float fade = t * t * (3.0f - 2.0f * t);
    return clamp01(1.0f - fade * clamp01(p.sweep_depth));
  }

  /// Advance one frame and fold the result into `o` — the rails, and the
  /// emission the mode branch has already written.
  void apply(const Params& p, float dt, Out& o) {
    using namespace detail;

    // --- 1. Speed. The estimator seeds itself from wherever the knob already
    //        is, so a sketch's stored `sweep` cannot read as a full-throw drag
    //        on frame one (knob_rate.h).
    const float r = rate.sample(p.sweep, dt, p.sweep_window);
    if (dt > 0.0f) {
      const float v = clamp01((r < 0.0f ? -r : r) /
                              (p.sweep_sense > 1e-4f ? p.sweep_sense : 1e-4f));
      // Instant attack, timed release — the meter IS the speed, so it reaches
      // the full range at any decay. A flick reads immediately and then trails.
      const float rel = std::exp(-dt / (p.sweep_decay > 1e-3f ? p.sweep_decay : 1e-3f));
      speed = v > speed * rel ? v : speed * rel;
      if (speed < 1e-4f) speed = 0.0f;
    }
    o.sweep_speed = speed;
    // The knob itself goes out too: three_planes' glints are thrown by the
    // GESTURE, not by a level, so what they need is the position and its
    // motion — not this envelope. See three_planes_glints.h.
    o.sweep_out = clamp01(p.sweep);

    // --- 2. Position, and the flicker that lives inside the fade.
    const float gain = positionGain(p, o.sweep_out);

    // --- 2b. CATCH AND THROW. The mute at either end is the point of the
    //         sweep, but a mute that is only "dark" has no gesture in it — the
    //         brightness just tracks where your hand is, and reversing undoes
    //         it exactly. So passing through the middle CHARGES, by how hard
    //         you went through it. Reaching a mute spends the whole charge at
    //         once — that is the throw — and what was thrown then rings out on
    //         ITS OWN clock.
    //
    //         Which is the whole point: nothing about where the knob goes next
    //         can cancel it. Come straight back to the middle and the tower
    //         relights over a tail that is still ringing. That is what makes
    //         the tail causal rather than positional.
    //
    //         The decay is LINEAR, not exponential. three_planes spends this
    //         on rings flying outward, and a linear fall is a constant
    //         outward speed — a shockwave with a definite end, rather than
    //         something that leaps out and then creeps for ever.
    const float mag = magnitudeOf(o.sweep_out);
    // In the band, or clean through it between two samples — which shows up as
    // the knob changing sides without ever being seen inside. Same rule, and
    // the same reason, as the glint launcher's over in three_planes_glints.h.
    const bool crossed = ((last - kSweepCenter) < 0.0f) !=
                         ((o.sweep_out - kSweepCenter) < 0.0f);
    last = o.sweep_out;
    if (mag <= clamp01(p.sweep_deadzone) || crossed) {
      // The charge takes the VIGOUR of the pass, peak-held — not the time
      // spent loitering. Filling it by the second had the gesture exactly
      // backwards: a short sharp flick through the middle, which is the most
      // emphatic thing you can do with the knob, spent almost no time in the
      // band and so earned the weakest throw available. Now it earns the
      // hardest one, and dawdling earns nothing at all.
      //
      // `speed` has an instant attack, so at the moment of a quick pass it IS
      // the vigour of that pass. `latch_drive` is there because the raw
      // reading is squashed for a meter and too polite for an impulse: above
      // 1 an ordinary firm sweep already pegs it.
      const float vigour = clamp01(speed * (p.latch_drive > 0.0f ? p.latch_drive : 0.0f));
      if (vigour > charge) charge = vigour;
      armed = true;
    }
    if (armed && gain <= kMuteGain && charge > 0.0f) {
      // A bigger throw wins outright rather than summing: two mutes in a row
      // are two gestures, not a level to pile up.
      if (charge > release) release = charge;
      charge = 0.0f;
      armed = false;
    }
    if (release > 0.0f) {
      release -= dt / (p.ring_time > 1e-3f ? p.ring_time : 1e-3f);
      if (release < 0.0f) release = 0.0f;
    }
    o.release = release;
    // Peaks where the light is halfway out and vanishes at both ends: nothing
    // to stutter about at full brightness, nothing to see once it is black.
    const float drive = clamp01(4.0f * gain * (1.0f - gain)) * clamp01(p.sweep_flicker);

    if (drive <= 1e-3f) {
      flick_layer = -1;
      flick_t = 0.0f;
    } else if (dt > 0.0f) {
      flick_t -= dt;
      if (flick_t <= 0.0f) {
        if (flick_layer >= 0) {
          // End the blip and wait. The gap shortens as the drive rises, which
          // is what turns an occasional stutter into a struggling tube.
          flick_layer = -1;
          const float gap = lerpf(0.55f, 0.05f, drive);
          flick_t = gap * (0.4f + 1.2f * rand01(rng));
        } else {
          // ONE floor at a time — the whole reason this is a scheduler and not
          // three independent noises. Coordinated stutter reads as one failing
          // installation; independent stutter reads as static.
          flick_layer = (int)(rand01(rng) * (float)kLayers);
          if (flick_layer >= kLayers) flick_layer = kLayers - 1;
          flick_t = 0.02f + 0.07f * rand01(rng);
        }
      }
    }

    // The chosen floor TOGGLES rather than dimming: lit goes dark, dark comes
    // up. That is what an old tube does, and it keeps the stutter legible in
    // the meter mode where half the tower may already be unlit.
    if (flick_layer >= 0 && flick_layer < kLayers) {
      const float lit = o.emission[flick_layer];
      const float target = lit >= 0.5f * clamp01(p.emission_on)
                               ? 0.0f
                               : clamp01(p.emission_on);
      o.emission[flick_layer] = lerpf(lit, target, drive);
    }

    // Position last, so the whole bank — flicker included — fades together.
    for (int i = 0; i < kLayers; ++i) o.emission[i] = clamp01(o.emission[i] * gain);
  }
};

/// The per-instance state. Everything here is an accumulator, which is why the
/// effect declares no temporal capability — it cannot be seeked.
struct Core {
  float meter = 0.0f;
  float peak = 0.0f;
  float hold_t = 0.0f;

  bool prev_on[kSignals] = {};

  float flam_t[kLayers] = {};
  bool flam_live[kLayers] = {};

  /// The sweep knob's own dynamics. Held here, not in the mode branch, because
  /// it composes on TOP of whatever paints the tower — same relationship the
  /// camera moves have.
  SweepCore sweep;

  int anim = AnimNone;
  float anim_t = 0.0f;
  float anim_dur = 1.0f;   ///< travel time, captured at trigger
  float anim_hold = 0.0f;  ///< end-pose hold, likewise

  void reset() { *this = Core(); }

  /// Duration of one move, from the params. Captured at trigger time so a knob
  /// moving mid-move doesn't stretch what is already running.
  static float animDuration(int a, const Params& p) {
    switch (a) {
      case AnimShow:    return p.show_time;
      case AnimSweepUp: return p.sweep_time;
      case AnimGlance:  return p.glance_time;
      case AnimUnfold:  return p.unfold_time;
      default:          return 1.0f;
    }
  }

  /// Start a move. Monophonic — whatever was running is dropped where it stood.
  void trigger(int a, const Params& p) {
    if (a < 0 || a >= kAnimCount) return;
    anim = a;
    anim_t = 0.0f;
    // Both timings are captured HERE so a knob moving mid-move cannot stretch
    // or truncate what is already running.
    anim_dur = animDuration(a, p);
    if (anim_dur < 1e-4f) anim_dur = 1e-4f;
    anim_hold = p.move_hold > 0.0f ? p.move_hold : 0.0f;
  }

  /// Advance one frame. `sig` is the raw four-channel feed; it is quantized here.
  Out tick(const Params& p, const float* sig, float dt) {
    using namespace detail;
    if (dt < 0.0f) dt = 0.0f;
    if (dt > kMaxDt) dt = kMaxDt;

    // --- 1. Quantize. The rising edges are what the meter mode fires flams
    //        from; they are found here either way so `prev_on` stays honest
    //        across a mode change. ---
    float target = 0.0f;
    bool fired[kSignals] = {};
    for (int c = 0; c < kSignals; ++c) {
      const bool on = sig[c] >= 0.5f;
      fired[c] = on && !prev_on[c];
      prev_on[c] = on;
      if (on && p.level[c] > target) target = p.level[c];
    }

    Out o;
    if (p.mode == ModeSolid) tickSolid(p, o);
    else                     tickMeter(p, fired, target, dt, o);

    // --- 2. The sweep. It runs in every mode and folds INTO the emission the
    //        mode just wrote — a global dimmer with a stutter in it — while
    //        passing the knob itself out separately, because the glints it
    //        throws are objects three_planes owns rather than a level. ---
    sweep.apply(p, dt, o);

    // --- 3. The camera move, which every mode gets. It sits OUTSIDE the mode
    //        branch on purpose: the mode paints the tower, the move flies the
    //        camera, and Solid exists precisely so a move can be the only
    //        thing happening.
    //        Half a cycle, no return: it pops into its start pose, eases
    //        across, optionally SITS there for `move_hold`, and pops back to
    //        baseline. Both pops are the effect, not an artefact. ---
    float az_deg = 0.0f;
    float elev_deg = 0.0f;
    float spacing = p.spacing_base;
    if (anim != AnimNone) {
      anim_t += dt;
      if (anim_t >= anim_dur + anim_hold) {
        anim = AnimNone;   // POP back to baseline
      } else {
        // Past the travel time the phase SATURATES at 1 rather than ending, so
        // the move sits on its end pose for `move_hold` seconds. The pop is
        // still the exit — the hold only decides how long you look at the pose
        // before it happens.
        const float u = easeCurve(anim_t / anim_dur, p.move_ease);
        o.anim_phase = u;
        switch (anim) {
          case AnimShow:
            az_deg = lerpf(p.show_azimuth * 0.5f, -p.show_azimuth * 0.5f, u);
            break;
          case AnimGlance:
            az_deg = lerpf(p.glance_azimuth * 0.5f, -p.glance_azimuth * 0.5f, u);
            // Travels UP across the move, hence the low-to-high order.
            elev_deg = lerpf(-p.glance_elevation * 0.5f, p.glance_elevation * 0.5f, u);
            break;
          case AnimSweepUp:
            // A wind-up and an absolute endpoint, not a swing: `sweep_start`
            // degrees off the baseline (dip down with a negative), then up to
            // `sweep_target` (0 deg by default, the side-on pose), then a pop
            // back. With sweep_start 0 there is no entry pop.
            elev_deg = lerpf(p.sweep_start, p.sweep_target - p.elevation_base, u);
            break;
          case AnimUnfold:
            // The one move that LANDS on baseline, so it has no end-pop.
            spacing = lerpf(0.0f, p.spacing_base, u);
            break;
          default:
            break;
        }
      }
    }

    // --- 4. Normalise for publication (see the header note). ---
    o.azimuth = wrap01(p.azimuth_base + az_deg / 360.0f);
    o.elevation = clamp01((p.elevation_base + elev_deg) / kElevationMaxDeg);
    o.spacing = clamp01(spacing / kSpacingMax);
    return o;
  }

 private:
  /// SOLID — the mode with no reactivity at all. Every floor sits lit in its own
  /// colour and only the camera moves.
  ///
  /// The colour assignment is not arbitrary: it reproduces three_planes' OWN
  /// plane defaults (magenta / cyan / violet, which is exactly what the three
  /// roles default to), so a rig in this mode with untouched colours looks like
  /// the effect does with nothing wired to it.
  void tickSolid(const Params& p, Out& o) {
    using namespace detail;
    // Hold the ballistics at rest rather than letting them drift while unread,
    // so switching back to the meter starts from silence instead of from
    // whatever it happened to be showing a minute ago. `prev_on` is still
    // tracked by the caller, so a signal that was already high when the mode
    // changed does not read as a fresh hit on the way back.
    meter = 0.0f;
    peak = 0.0f;
    hold_t = 0.0f;
    for (int i = 0; i < kLayers; ++i) { flam_t[i] = 0.0f; flam_live[i] = false; }

    // The meter rails report the METER, and in this mode there isn't one. They
    // read 0 rather than "full" because nothing is being measured.
    o.meter = 0.0f;
    o.peak = 0.0f;
    o.peak_layer = -1;

    const Rgb solid[kLayers] = {p.primary, p.highlight, p.secondary};
    for (int i = 0; i < kLayers; ++i) {
      o.emission[i] = clamp01(p.emission_on);
      o.color[i] = solid[i];
    }
  }

  /// EV METER — the reactive mode. Everything below is driven by the four gates.
  void tickMeter(const Params& p, const bool* fired, float target, float dt, Out& o) {
    using namespace detail;
    // --- 1. Meter: instant attack, timed fall. A hit is a step, not a ramp —
    //        the whole point of a meter is that you see the transient. ---
    if (target > meter) {
      meter = target;
    } else {
      const float fall = p.meter_fall > 1e-4f ? p.meter_fall : 1e-4f;
      meter -= dt / fall;
      if (meter < 0.0f) meter = 0.0f;
    }

    // --- 2. Peak hold. Rearms whenever the meter reaches it, then sits for
    //        `peak_hold` seconds before falling. Never below the meter. ---
    if (meter >= peak) {
      peak = meter;
      hold_t = 0.0f;
    } else {
      hold_t += dt;
      if (hold_t > p.peak_hold) {
        const float fall = p.peak_fall > 1e-4f ? p.peak_fall : 1e-4f;
        peak -= dt / fall;
        if (peak < meter) peak = meter;
      }
    }

    // --- 3. Flams. A fire lands on the layer its LEVEL names, so ch3 and ch4
    //        share the top layer and retrigger each other. ---
    for (int c = 0; c < kSignals; ++c) {
      if (!fired[c]) continue;
      const int i = layerOf(p.level[c]);
      flam_t[i] = 0.0f;
      flam_live[i] = true;
    }
    const float ft = p.flam_time > 1e-4f ? p.flam_time : 1e-4f;
    float flam[kLayers] = {};
    for (int i = 0; i < kLayers; ++i) {
      if (!flam_live[i]) continue;
      const float k = 1.0f - flam_t[i] / ft;   // 1 at the hit, 0 at retirement
      flam[i] = k > 0.0f ? k * k : 0.0f;       // ease out — a blip, not a fade
      flam_t[i] += dt;
      if (flam_t[i] >= ft) flam_live[i] = false;
    }

    o.meter = clamp01(meter / (float)kLayers);
    o.peak = clamp01(peak / (float)kLayers);

    // --- 4. Which layers are lit. `allow_holes` swaps "everything under the
    //        meter" for "only what is currently flamming"; the cap is exempt
    //        either way, because a cap you cannot see is not a cap. ---
    o.peak_layer = peak >= 0.05f ? layerOf(peak) : -1;
    bool lit[kLayers] = {};
    for (int i = 0; i < kLayers; ++i)
      lit[i] = p.allow_holes ? (flam[i] > 0.0f) : (meter >= (float)(i + 1) - 1e-4f);
    if (o.peak_layer >= 0) lit[o.peak_layer] = true;

    // --- 5. Emission and colour. The cap's flam runs the OTHER WAY: a plain
    //        layer rests dark-violet and flashes magenta, the cap rests cyan and
    //        flashes violet, so the top of the tower never reads like the rest
    //        of it even mid-hit. ---
    for (int i = 0; i < kLayers; ++i) {
      const float base = lit[i] ? p.emission_on : p.emission_off;
      o.emission[i] = clamp01(base + flam[i] * p.flam_emission);
      const float mix = clamp01(flam[i] * p.flam_color);
      o.color[i] = (i == o.peak_layer) ? lerpRgb(p.highlight, p.secondary, mix)
                                       : lerpRgb(p.secondary, p.primary, mix);
    }
  }
};

}  // namespace three_planes_rig
