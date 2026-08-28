/*
 * mod.rig.three_planes — the show controller for `source.mesh.three_planes`.
 *
 * three_planes renders the stack and decides nothing: "Everything rhythmic is
 * driven from OUTSIDE", says its header, and that turned out to be twelve
 * hand-drawn envelopes. This card is that outside, in one place — a peak-holding
 * EV meter that lights the layers, and four one-shot camera moves — publishing
 * the rails to wire straight back into it.
 *
 * The SWEEP is the exception to "reads four gates": one bipolar knob you
 * perform on, whose POSITION dims the tower and whose SPEED throws glints.
 * It is the only input here read for its motion rather than its value, and the
 * only one whose effect three_planes cannot take as a level at all: the
 * glints it throws are particles thrown by the GESTURE, so what crosses the
 * wire is the knob itself. All of this lives in the header's SweepCore.
 *
 * The four signal inputs are `beatsync`'s Art-Net feed, reached through
 * control.artnet's `ch_0..ch_3`: four DMX channels (heavy / regular / decor /
 * uniform) that are GATES, not faders. Everything quantizes at 0.5; velocity is
 * deliberately thrown away.
 *
 * WHY THE OUTPUTS LOOK NORMALISED RATHER THAN LIKE DEGREES. A wire you draw by
 * hand carries no `magnitude`, so the executor folds its value into the
 * DESTINATION field's [min,max] (tap_mod.h's applyMagnitude, combine Replace).
 * Publishing the destination slider's POSITION is therefore what makes a plain
 * drag land on the right value — `elevation` goes out as deg/89, `plane_spacing`
 * as units/1.5. The divisors live in three_planes_rig.h next to the note saying
 * they mirror three_planes' schema.
 *
 * All the math is in <sketch/three_planes_rig.h>, host-free, so the Catch2
 * goldens in native/tests/test_three_planes_rig.cpp run it with no wasm and no
 * GPU. This file is the schema, the patch decode and the publish — nothing else.
 *
 * Pure data module — no GPU, no texture I/O, everything in tick().
 */

#include <host.h>
#include <val.h>
#include <sketch/three_planes_rig.h>

#include <cstdio>
#include <cstring>

namespace three_planes_rig_effect {

namespace rig = three_planes_rig;

struct State {
  rig::Params p;
  rig::Core core;

  float sig[rig::kSignals] = {};
  /// Rising-edge memory for the four move triggers. The executor replays every
  /// stored value as a PatchReplace EVERY frame, so an event that fired on patch
  /// arrival would re-arm forever (style guide §8.2) — only 0→1 counts.
  bool anim_prev[rig::kAnimCount] = {};
  /// Patches only ARM a move; tick() starts it. That way a trigger and the
  /// duration knob arriving in the same transaction resolve the same way
  /// whatever order they land in (mod_latch's discipline).
  int pending_anim = rig::AnimNone;
};

// --- publish helpers ------------------------------------------------------

static inline void pubFloat(const char* name, float v) {
  auto h = val::number(v);
  state::setValPath(name, h);
  val::release(h);
}

/// A colour rail is a flat array of components — the same shape mod.shaper.switch
/// publishes for a vec case. Vec rails carry components whole (no magnitude, no
/// fold), so what goes out here is what the destination reads.
static inline void pubRgb(const char* name, const rig::Rgb& c) {
  auto arr = val::Value(val::array());
  const float comps[3] = {c.r, c.g, c.b};
  for (int i = 0; i < 3; ++i) {
    auto n = val::Value(val::number(comps[i]));
    val::push(arr.h, n.h);
  }
  state::setValPath(name, arr.h);
}

// --- per-instance field visibility -----------------------------------------

/// Solid reads NO signals and runs no ballistics, so every field that only the
/// meter consumes comes off the card. That leaves the mode select, the three
/// colours, the lit level, the camera baselines and the moves — which is exactly
/// the set Solid actually uses.
static void applyModeVisibility(int mode) {
  const bool solid = (mode == rig::ModeSolid);
  for (int i = 0; i < rig::kSignals; ++i) {
    char name[16];
    std::snprintf(name, sizeof(name), "sig_%d", i + 1);
    state::setFieldHidden(name, solid);
    std::snprintf(name, sizeof(name), "sig%d_level", i + 1);
    state::setFieldHidden(name, solid);
  }
  state::setFieldHidden("meter_fall", solid);
  state::setFieldHidden("peak_hold", solid);
  state::setFieldHidden("peak_fall", solid);
  state::setFieldHidden("allow_holes", solid);
  // `emission_on` stays — it is what Solid lights the floors AT. `emission_off`
  // is the unlit level, and in Solid nothing is unlit.
  state::setFieldHidden("emission_off", solid);
  state::setFieldHidden("flam_time", solid);
  state::setFieldHidden("flam_color", solid);
  state::setFieldHidden("flam_emission", solid);
}

/// Static (self-less) evaluator — pure over state, so the editor can resolve the
/// field set for a card that is not currently executing.
void eval_visibility(int n, const char* pb, const int* off, const int* len,
                     const int* ops) {
  int mode = rig::ModeEvMeter;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "mode")) mode = (int)state::patchFloat(i);
  }
  applyModeVisibility(mode);
}

void module_init() {
  state::Schema schema;
  schema.helpField("intro",
    "## Three Planes Rig\n"
    "The show logic for **Three Planes**, in one card. It reads four on/off "
    "signals — a drum feed over Art-Net, a sequencer, four buttons — and drives "
    "the whole stack: which floors are lit, what colour they are, and where the "
    "camera is.\n\n"
    "**EV Meter** is the reactive mode. Each signal names a height; a hit throws "
    "the meter up to it instantly and the meter falls back on its own time. The "
    "highest point it reached stays behind as a **cap**, held for a moment "
    "before it sinks — and the cap wears the *Highlight* colour, so you can "
    "always see how loud it just got.\n\n"
    "**Solid** is the opposite: no signals, no meter, no cap. Three lit floors "
    "in the three colours and nothing moving. It is the pose to cut back to — a "
    "piece that reacts the whole way through has nothing left to react from.\n\n"
    "The four **moves** work in either mode. They fly the camera, not the tower, "
    "so Solid plus a move is a clean gesture on a still image.\n\n"
    "**Sweep** is the knob you perform on. Where it sits dims the whole tower — "
    "wide deadzone through the middle, fading to black at either end with the "
    "tubes stuttering on the way out — and how fast you move it throws slanted "
    "glints across the quads. It works in every mode too.\n\n"
    "**Try:** wire `Sig 1..4` from an *Art-Net In* card and the nine outputs into "
    "Three Planes' emission and colour, then fire **Show** from the trigger row "
    "while it runs. Turn on *Allow Holes* for a sparser, more percussive tower — "
    "floors then light only on their own hit instead of filling in underneath.");

  // ---------------- Signals ----------------
  schema.group("signals", "Signals")
        .groupHelp(
          "The four gates driving the meter. They are read as **on/off at 0.5** — "
          "how hard a hit was is thrown away on purpose, because the source is a "
          "lighting feed where a hit is a lit window rather than a level.\n\n"
          "From `beatsync` over Art-Net these are, in order, *heavy*, *regular*, "
          "*decor* and *uniform*. *Level* is what each one MEANS on the meter: 1 "
          "is the ground floor, 3 the top. Two signals sharing a level share a "
          "floor and retrigger each other, which is why 3 and 4 both name the top "
          "by default.");
  for (int i = 0; i < rig::kSignals; ++i) {
    char name[16], disp[16], shortl[8];
    std::snprintf(name, sizeof(name), "sig_%d", i + 1);
    std::snprintf(disp, sizeof(disp), "Sig %d", i + 1);
    std::snprintf(shortl, sizeof(shortl), "%d", i + 1);
    // sig_1 is the PRIMARY, magnitude-marked input: what the executor's shaper
    // auto-connect binds from a preceding modulation source.
    schema.floatField(name, 0.0f, 0.f, 1.f,
                      i == 0 ? state::PrimaryInput : state::SecondaryInput,
                      "unsigned")
          .label(disp, shortl);
  }
  {
    const float defaults[rig::kSignals] = {1.0f, 2.0f, 3.0f, 3.0f};
    for (int i = 0; i < rig::kSignals; ++i) {
      char name[16], disp[16], shortl[8];
      std::snprintf(name, sizeof(name), "sig%d_level", i + 1);
      std::snprintf(disp, sizeof(disp), "Level %d", i + 1);
      std::snprintf(shortl, sizeof(shortl), "L%d", i + 1);
      // RAW: a literal position on the meter's axis compared against another
      // value, not a modulation amount — the case Schema::raw() exists for.
      schema.floatField(name, defaults[i], 0.f, (float)rig::kLayers,
                        state::SecondaryInput)
            .raw().label(disp, shortl);
    }
  }

  // ---------------- Meter ----------------
  schema.group("meter", "Meter")
        .groupHelp(
          "What paints the tower. **EV Meter** reads the signals; **Solid** "
          "ignores them entirely and just lights all three floors at *Lit "
          "Level*, one per colour, leaving the moves as the only thing "
          "happening. The rest of this group is the meter's, and disappears in "
          "Solid.\n\n"
          "A hit is a **step**, not a ramp — the meter jumps "
          "to the height it was given and then falls, which is the whole point of "
          "a meter: you see the transient.\n\n"
          "*Fall* and *Peak Fall* are seconds to travel **one floor**, so a drop "
          "from the top reads the same speed as a drop from the bottom. *Peak "
          "Hold* is how long the cap sits before it starts sinking.\n\n"
          "*Allow Holes* changes what \"lit\" means. Off, everything under the "
          "meter is lit and the tower reads solid. On, a floor lights only while "
          "its own hit is ringing, so the tower is full of gaps and reads much "
          "more percussive. The cap shows either way.");
  // Options APPEND, never renumber — a stored `mode` is an index.
  schema.selectField("mode", 0, state::SecondaryInput,
                     {{"EV Meter", rig::ModeEvMeter}, {"Solid", rig::ModeSolid}})
        .label("Mode", "Mode");
  schema.floatField("meter_fall", 0.35f, 0.05f, 3.f, state::PrimaryInput,
                    nullptr, 0.f, "s", "Seconds for the meter to fall one floor.")
        .label("Fall", "Fall");
  schema.floatField("peak_hold", 1.2f, 0.f, 4.f, state::PrimaryInput,
                    nullptr, 0.f, "s", "How long the cap holds before it sinks.")
        .label("Peak Hold", "Hold");
  schema.floatField("peak_fall", 0.9f, 0.05f, 4.f, state::PrimaryInput,
                    nullptr, 0.f, "s", "Seconds for the cap to sink one floor.")
        .label("Peak Fall", "PkFall");
  schema.boolField("allow_holes", false, state::SecondaryInput,
                   "Light a floor only while its own hit rings, instead of "
                   "filling in everything below the meter.")
        .label("Allow Holes", "Holes");
  schema.floatField("emission_on", 1.0f, 0.f, 1.f, state::SecondaryInput)
        .label("Lit Level", "On");
  schema.floatField("emission_off", 0.12f, 0.f, 1.f, state::SecondaryInput)
        .label("Unlit Level", "Off");

  // ---------------- Flam ----------------
  schema.group("flam", "Flam")
        .groupHelp(
          "The blip a floor gives when its own signal fires. It is short and it "
          "eases out — a flick, not a fade — and it does two things at once: "
          "pushes the floor brighter, and swings its colour to the other end.\n\n"
          "*Colour* is how far that swing goes. At 0 the flam is purely a "
          "brightness accent; at 1 the floor fully changes colour on every hit.");
  schema.floatField("flam_time", 0.18f, 0.02f, 1.f, state::PrimaryInput,
                    nullptr, 0.f, "s")
        .label("Flam Time", "Time");
  schema.floatField("flam_color", 1.0f, 0.f, 1.f, state::PrimaryInput)
        .label("Flam Colour", "Col");
  schema.floatField("flam_emission", 0.35f, 0.f, 1.f, state::PrimaryInput)
        .label("Flam Brightness", "Bright");

  // ---------------- Colours ----------------
  schema.group("colors", "Colours")
        .groupHelp(
          "Three roles, not three floors — except in **Solid**, where they are "
          "exactly three floors: bottom takes *Primary*, middle *Highlight*, "
          "top *Secondary*, which is the colouring Three Planes already ships "
          "with.\n\n"
          "In the meter mode a plain floor **rests** on *Secondary* "
          "and **flams** to *Primary*. The peak cap runs the other way round: it "
          "rests on *Highlight* and flams to *Secondary* — so the top of the "
          "tower never reads like the rest of it, even mid-hit.\n\n"
          "The defaults are Three Planes' own three colours, so an unwired rig "
          "reproduces the look it already has.");
  schema.rgbField("primary_color", 1.00f, 0.22f, 0.62f, state::PrimaryInput)
        .label("Primary", "Prim");
  schema.rgbField("secondary_color", 0.72f, 0.35f, 1.00f, state::PrimaryInput)
        .label("Secondary", "Sec");
  schema.rgbField("highlight_color", 0.30f, 0.85f, 1.00f, state::PrimaryInput)
        .label("Highlight", "Hi");

  // ---------------- Camera ----------------
  schema.group("camera", "Camera")
        .groupHelp(
          "Where the camera rests. Every move below is measured from here and "
          "returns here, so this is the pose the piece sits in between cues.\n\n"
          "These match Three Planes' own controls: *Orbit* is a full turn over "
          "0..1, *Elevation* is the deck tilt in degrees (35.26 is true "
          "isometric), *Spacing* is how far apart the floors sit.");
  schema.floatField("azimuth_base", 0.125f, 0.f, 1.f, state::PrimaryInput,
                    "unsigned", 0.f, nullptr,
                    "Turntable angle. 0..1 maps to a full 360 deg turn.")
        .label("Orbit Base", "Orbit");
  schema.floatField("elevation_base", 35.264389682754654f, 0.f, 89.f,
                    state::PrimaryInput, nullptr, 0.f, "deg",
                    "Deck tilt. 35.26 deg is true isometric.")
        .label("Elevation Base", "Elev");
  schema.floatField("spacing_base", 0.42f, 0.f, 1.5f, state::PrimaryInput)
        .label("Spacing Base", "Space");

  // ---------------- Animations ----------------
  schema.group("animations", "Moves")
        .groupHelp(
          "Four one-shot camera moves, available in every mode — they fly the "
          "camera, not the tower. Only one runs at a time; firing another drops "
          "whatever was going, where it stood.\n\n"
          "They are deliberately **half a cycle**: a move pops into its start "
          "pose, eases across, and pops back to the baseline when its timer runs "
          "out. Those two pops are the gesture, not an artefact — it lands like a "
          "cut rather than a drift. *Unfold* is the exception, because it ends on "
          "the baseline already.\n\n"
          "*Hold* keeps a move parked on its end pose before that last pop, so "
          "the arrival is something you get to look at rather than a place it "
          "passes through. It applies to all four. (On *Unfold* it holds at the "
          "baseline, which looks like nothing happening — that one is already "
          "home.) *Ease* shapes the travel in between: straight-line at 0, a "
          "long float out of the start and into the landing at 1.\n\n"
          "*Sweep Start* gives **Sweep Up** a wind-up — set it negative and the "
          "deck dips before it climbs, which is what makes the rise read as a "
          "rise. At 0 the sweep begins on the baseline and is the one move "
          "without an entry pop.\n\n"
          "**Show** swings the orbit through its whole arc. **Glance** does the "
          "same but drops the deck as it goes, like a look away. **Sweep Up** "
          "tips the deck to side-on. **Unfold** collapses the floors together and "
          "grows them back out.");
  schema.eventField("show", state::PrimaryInput).label("Show", "Show");
  schema.eventField("sweep_up", state::PrimaryInput).label("Sweep Up", "Sweep");
  schema.eventField("glance", state::PrimaryInput).label("Glance", "Glance");
  schema.eventField("unfold", state::PrimaryInput).label("Unfold", "Unfold");
  // Shared by all four: it is about how the LANDING reads, not about the move.
  schema.floatField("hold_time", 0.f, 0.f, 6.f, state::PrimaryInput,
                    nullptr, 0.f, "s",
                    "Seconds a move sits on its end pose before popping back.")
        .label("Hold", "Hold");
  schema.floatField("move_ease", 0.5f, 0.f, 1.f, state::PrimaryInput,
                    nullptr, 0.f, nullptr,
                    "Travel shape: 0 straight-line, 0.5 eased, 1 heavily eased.")
        .label("Ease", "Ease");
  schema.floatField("show_time", 1.2f, 0.1f, 6.f, state::SecondaryInput,
                    nullptr, 0.f, "s")
        .label("Show Time", "ShowT");
  schema.floatField("show_azimuth", 30.f, 0.f, 180.f, state::SecondaryInput,
                    nullptr, 0.f, "deg", "Total orbit swing, centred on the baseline.")
        .label("Show Swing", "ShowA");
  schema.floatField("sweep_time", 1.5f, 0.1f, 6.f, state::SecondaryInput,
                    nullptr, 0.f, "s")
        .label("Sweep Time", "SwpT");
  schema.floatField("sweep_start", 0.f, -89.f, 89.f, state::SecondaryInput,
                    "signed", 0.f, "deg",
                    "Where the sweep starts, either side of the baseline. "
                    "Negative dips the deck before it climbs.")
        .label("Sweep Start", "SwpFr");
  schema.floatField("sweep_target", 0.f, 0.f, 89.f, state::SecondaryInput,
                    nullptr, 0.f, "deg", "Elevation the sweep ends on before it pops back.")
        .label("Sweep Target", "SwpTo");
  schema.floatField("glance_time", 0.8f, 0.1f, 6.f, state::SecondaryInput,
                    nullptr, 0.f, "s")
        .label("Glance Time", "GlnT");
  schema.floatField("glance_azimuth", 30.f, 0.f, 180.f, state::SecondaryInput,
                    nullptr, 0.f, "deg", "Total orbit swing, centred on the baseline.")
        .label("Glance Swing", "GlnA");
  schema.floatField("glance_elevation", 15.f, 0.f, 60.f, state::SecondaryInput,
                    nullptr, 0.f, "deg", "Total deck drop, centred on the baseline.")
        .label("Glance Drop", "GlnE");
  schema.floatField("unfold_time", 1.6f, 0.1f, 6.f, state::SecondaryInput,
                    nullptr, 0.f, "s")
        .label("Unfold Time", "UnfT");

  // ---------------- Sweep ----------------
  schema.group("sweep", "Sweep")
        .groupHelp(
          "One knob you PERFORM — map it to a MIDI encoder and ride it. It is "
          "bipolar: the centre (0.5) is home, and the two ends are the same "
          "gesture in opposite directions.\n\n"
          "**Where it sits** dims the whole tower. Most of the middle is a "
          "*Deadzone* at full brightness, so you can work around centre "
          "without touching the look — only out near an end does the light "
          "fade, and *Fade Depth* says how far (1 = all the way to black). "
          "Sweeping to an extreme is a deliberate blackout, not a dimmer.\n\n"
          "**How fast you move it** throws glints — over in Three Planes, "
          "which reads *Sweep Out* and does the rest. Speed is measured as "
          "displacement over *Window*, so a stepping MIDI encoder reads as the "
          "true drag speed instead of a string of spikes, and it returns to a "
          "real zero when you stop. *Full Scale* is the speed that pegs it; "
          "*Glint Decay* is how long that reading coasts after you let go.\n\n"
          "**Reaching an end is a throw, not just a mute.** Passing through "
          "the middle *charges* — by how hard you go through it, not by how "
          "long you linger, so a short vigorous flick charges hardest. Arrive "
          "at either "
          "extreme and the whole charge is spent at once, and *Release* rings "
          "out over *Ring Out* on its own clock — nothing you do with the knob "
          "afterwards cancels it, so you can come straight back to the middle "
          "and relight the tower over a tail that is still running. Wire it "
          "into Three Planes and the throw flings the stack outward as "
          "expanding rings.\n\n"
          "*Flicker* is the stutter that arrives mid-fade — one floor at a "
          "time, going dark or coming up, loudest exactly where the light is "
          "halfway out and gone again at both ends. Old tubes struggle; they "
          "do not dim politely.\n\n"
          "**Try:** wire *Sweep* to a knob and *Sweep Out* into Three Planes' "
          "*Glint Sweep*, then sweep across the beat — every pass through the "
          "middle throws one slanted highlight, travelling at exactly the "
          "speed you moved.");
  schema.floatField("sweep", rig::kSweepCenter, 0.f, 1.f, state::PrimaryInput,
                    "unsigned", 0.f, nullptr,
                    "The performance knob. 0.5 is home — full brightness and "
                    "no glints; both ends fade to black.")
        .label("Sweep", "Swp");
  schema.floatField("sweep_deadzone", 0.45f, 0.f, 0.95f, state::PrimaryInput,
                    nullptr, 0.f, nullptr,
                    "How much of each half stays fully lit before the fade "
                    "starts, as a fraction of the throw.")
        .label("Deadzone", "Dead");
  schema.floatField("sweep_depth", 1.0f, 0.f, 1.f, state::PrimaryInput,
                    nullptr, 0.f, nullptr,
                    "How dark the extremes go. 1 is black.")
        .label("Fade Depth", "Depth");
  schema.floatField("sweep_flicker", 0.6f, 0.f, 1.f, state::PrimaryInput,
                    nullptr, 0.f, nullptr,
                    "Tube stutter through the fade — one floor at a time, "
                    "loudest where the light is halfway out.")
        .label("Flicker", "Flick");
  schema.floatField("sweep_decay", 0.18f, 0.01f, 2.f, state::SecondaryInput,
                    nullptr, 0.f, "s",
                    "How long the Sweep Speed reading coasts after you stop moving.")
        .label("Glint Decay", "Dec");
  schema.floatField("sweep_sense", 2.0f, 0.1f, 8.f, state::SecondaryInput,
                    nullptr, 0.f, "/s",
                    "The sweep speed that pegs the Sweep Speed rail, in full "
                    "throws per second.")
        .label("Full Scale", "Scale");
  schema.floatField("latch_drive", 2.0f, 0.f, 6.f, state::PrimaryInput,
                    nullptr, 0.f, nullptr,
                    "How readily a pass through the middle charges the throw. "
                    "The charge takes the SPEED of the pass and holds the "
                    "best of it — so a short vigorous flick charges hard and "
                    "dawdling in the middle charges nothing. Above 1 an "
                    "ordinary firm sweep already pegs it.")
        .label("Latch Drive", "Latch");
  schema.floatField("ring_time", 1.4f, 0.05f, 6.f, state::PrimaryInput,
                    nullptr, 0.f, "s",
                    "How long a throw takes to ring out. Nothing you do with "
                    "the knob cancels it — come straight back to the middle "
                    "and the tower relights over a tail still running.")
        .label("Ring Out", "Ring");
  schema.floatField("sweep_window", 0.09f, 0.f, 0.4f, state::SecondaryInput,
                    nullptr, 0.f, "s",
                    "Span the sweep speed is measured over. Longer steadies a "
                    "stepping encoder; 0 differences per frame.")
        .label("Window", "Win");

  // ---------------- Outputs ----------------
  // Declared min/max IS the modulation contract; every rail here is the
  // DESTINATION slider's position, so a plain drag lands on the right value.
  schema.group("output", "Output")
        .groupHelp(
          "Wire these into Three Planes. The three *Emission* rails and the three "
          "*Colour* rails go to the matching plane; *Orbit*, *Elevation* and "
          "*Spacing* go to the camera.\n\n"
          "*Meter* and *Peak* are the raw levels over 0..1 — useful for driving "
          "anything else in the sketch off the same pulse, and for watching what "
          "the card thinks is happening. Both read 0 in **Solid**, because "
          "nothing is being measured.");
  schema.floatField("meter", 0.f, 0.f, 1.f, state::PrimaryOutput, "unsigned",
                    0.f, nullptr, "Meter height over the three floors.")
        .label("Meter", "Meter");
  schema.floatField("peak", 0.f, 0.f, 1.f, state::SecondaryOutput, "unsigned",
                    0.f, nullptr, "Held cap height over the three floors.")
        .label("Peak", "Peak");
  schema.floatField("anim_phase", 0.f, 0.f, 1.f, state::SecondaryOutput, "unsigned",
                    0.f, nullptr, "Eased 0..1 while a move runs, 0 when idle.")
        .label("Move Phase", "Move");
  for (int i = 0; i < rig::kLayers; ++i) {
    char name[24], disp[24], shortl[8];
    std::snprintf(name, sizeof(name), "plane%d_emission", i + 1);
    std::snprintf(disp, sizeof(disp), "Plane %d Emission", i + 1);
    std::snprintf(shortl, sizeof(shortl), "P%d Em", i + 1);
    schema.floatField(name, 0.f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
          .label(disp, shortl);
  }
  for (int i = 0; i < rig::kLayers; ++i) {
    char name[24], disp[24], shortl[8];
    std::snprintf(name, sizeof(name), "plane%d_color", i + 1);
    std::snprintf(disp, sizeof(disp), "Plane %d Colour", i + 1);
    std::snprintf(shortl, sizeof(shortl), "P%d Col", i + 1);
    schema.rgbField(name, 0.72f, 0.35f, 1.00f, state::SecondaryOutput)
          .label(disp, shortl);
  }
  schema.floatField("orbit_azimuth", 0.125f, 0.f, 1.f, state::SecondaryOutput,
                    "unsigned", 0.f, nullptr,
                    "Turntable angle. 0..1 maps to a full 360 deg turn.")
        .label("Orbit Azimuth", "Orbit");
  schema.floatField("elevation", 0.396f, 0.f, 1.f, state::SecondaryOutput,
                    "unsigned", 0.f, nullptr,
                    "Deck tilt as a fraction of Three Planes' 0..89 deg range.")
        .label("Elevation", "Elev");
  schema.floatField("plane_spacing", 0.28f, 0.f, 1.f, state::SecondaryOutput,
                    "unsigned", 0.f, nullptr,
                    "Floor spacing as a fraction of Three Planes' 0..1.5 range.")
        .label("Plane Spacing", "Space");
  // The sweep rails. The position half of the sweep needs no rail — it is
  // already folded into the three Emission outputs above, because a global
  // dimmer with a stutter in it IS the emission. What DOES go out is the knob
  // itself: three_planes' glints are objects thrown by the gesture, and a
  // gesture is a position over time, not a level.
  schema.floatField("sweep_speed", 0.f, 0.f, 1.f, state::SecondaryOutput,
                    "unsigned", 0.f, nullptr,
                    "How hard the sweep knob is moving, 0..1. Coasts down "
                    "over Glint Decay when you stop.")
        .label("Sweep Speed", "Speed");
  schema.floatField("sweep_out", rig::kSweepCenter, 0.f, 1.f,
                    state::SecondaryOutput, "unsigned", 0.f, nullptr,
                    "The Sweep knob, passed straight through. Wire to Three "
                    "Planes' Glint Sweep — its glints are thrown by the "
                    "GESTURE, so they read the knob's motion themselves "
                    "rather than taking a level from here.")
        .label("Sweep Out", "SwpOut");
  schema.floatField("release", 0.f, 0.f, 1.f, state::SecondaryOutput,
                    "unsigned", 0.f, nullptr,
                    "The throw, ringing out. 1 the instant a mute spends the "
                    "charge, falling to 0 over Ring Out — on its own clock, so "
                    "nothing the knob does afterwards can cancel it. Wire to "
                    "Three Planes' Release.")
        .label("Release", "Rel");

  // 4 gates in, twelve rails out. NO temporal tag: the meter, the peak hold, the
  // flams and the moves are all accumulators, so this cannot be seeked.
  schema.capability(state::Capability::ModulationShaper)
        .capability(state::Capability::ModulationShaperFanout);

  state::init("mod.rig.three_planes", {1, 0, 0}, schema);
}

void* create() { return new State(); }

void destroy(void* self) { delete static_cast<State*>(self); }

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  *s = State();
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  // Read taps landed before doTick, so this frame's signals and knobs are
  // already in State. A move armed by a patch starts HERE, so it always sees
  // the durations that arrived with it.
  if (s->pending_anim != rig::AnimNone) {
    s->core.trigger(s->pending_anim, s->p);
    s->pending_anim = rig::AnimNone;
  }

  const rig::Out o = s->core.tick(s->p, s->sig, static_cast<float>(dt));

  pubFloat("meter", o.meter);
  pubFloat("peak", o.peak);
  pubFloat("anim_phase", o.anim_phase);
  for (int i = 0; i < rig::kLayers; ++i) {
    char name[24];
    std::snprintf(name, sizeof(name), "plane%d_emission", i + 1);
    pubFloat(name, o.emission[i]);
    std::snprintf(name, sizeof(name), "plane%d_color", i + 1);
    pubRgb(name, o.color[i]);
  }
  pubFloat("sweep_speed", o.sweep_speed);
  pubFloat("sweep_out", o.sweep_out);
  pubFloat("release", o.release);
  pubFloat("orbit_azimuth", o.azimuth);
  pubFloat("elevation", o.elevation);
  pubFloat("plane_spacing", o.spacing);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  static const char* const kAnimField[rig::kAnimCount] = {
      "show", "sweep_up", "glance", "unfold"};

  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];

    // "sig_<k>" / "sig<k>_level" — matched by shape rather than formatting
    // eight candidate names per patch entry (mod_math's rule).
    if (l == 5 && std::memcmp(p, "sig_", 4) == 0) {
      const int k = p[4] - '1';
      if (k >= 0 && k < rig::kSignals) s->sig[k] = state::patchFloat(i);
      continue;
    }
    if (l == 10 && std::memcmp(p, "sig", 3) == 0 &&
        std::memcmp(p + 4, "_level", 6) == 0) {
      const int k = p[3] - '1';
      if (k >= 0 && k < rig::kSignals) s->p.level[k] = state::patchFloat(i);
      continue;
    }

    // The four move triggers. RISING EDGE ONLY — the executor replays every
    // stored value as a PatchReplace each frame, so firing on arrival would
    // re-arm forever (style guide §8.2). A phase guard is not a fix.
    {
      bool matched = false;
      for (int a = 0; a < rig::kAnimCount; ++a) {
        if (!state::pathIs(p, l, kAnimField[a])) continue;
        const bool t = state::patchEvent(i);
        if (t && !s->anim_prev[a]) s->pending_anim = a;
        s->anim_prev[a] = t;
        matched = true;
        break;
      }
      if (matched) continue;
    }

    if (state::pathIs(p, l, "mode")) {
      s->p.mode = state::patchInt(i);
      applyModeVisibility(s->p.mode);
      continue;
    }
    if      (state::pathIs(p, l, "meter_fall"))    s->p.meter_fall = state::patchFloat(i);
    else if (state::pathIs(p, l, "peak_hold"))     s->p.peak_hold = state::patchFloat(i);
    else if (state::pathIs(p, l, "peak_fall"))     s->p.peak_fall = state::patchFloat(i);
    else if (state::pathIs(p, l, "allow_holes"))   s->p.allow_holes = state::patchBool(i);
    else if (state::pathIs(p, l, "emission_on"))   s->p.emission_on = state::patchFloat(i);
    else if (state::pathIs(p, l, "emission_off"))  s->p.emission_off = state::patchFloat(i);
    else if (state::pathIs(p, l, "flam_time"))     s->p.flam_time = state::patchFloat(i);
    else if (state::pathIs(p, l, "flam_color"))    s->p.flam_color = state::patchFloat(i);
    else if (state::pathIs(p, l, "flam_emission")) s->p.flam_emission = state::patchFloat(i);
    else if (state::pathIs(p, l, "primary_color")) {
      auto v = state::patchVec3(i);
      s->p.primary = rig::Rgb{v.x, v.y, v.z};
    } else if (state::pathIs(p, l, "secondary_color")) {
      auto v = state::patchVec3(i);
      s->p.secondary = rig::Rgb{v.x, v.y, v.z};
    } else if (state::pathIs(p, l, "highlight_color")) {
      auto v = state::patchVec3(i);
      s->p.highlight = rig::Rgb{v.x, v.y, v.z};
    }
    else if (state::pathIs(p, l, "azimuth_base"))     s->p.azimuth_base = state::patchFloat(i);
    else if (state::pathIs(p, l, "elevation_base"))   s->p.elevation_base = state::patchFloat(i);
    else if (state::pathIs(p, l, "spacing_base"))     s->p.spacing_base = state::patchFloat(i);
    else if (state::pathIs(p, l, "show_time"))        s->p.show_time = state::patchFloat(i);
    else if (state::pathIs(p, l, "show_azimuth"))     s->p.show_azimuth = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep_time"))       s->p.sweep_time = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep_target"))     s->p.sweep_target = state::patchFloat(i);
    else if (state::pathIs(p, l, "glance_time"))      s->p.glance_time = state::patchFloat(i);
    else if (state::pathIs(p, l, "glance_azimuth"))   s->p.glance_azimuth = state::patchFloat(i);
    else if (state::pathIs(p, l, "glance_elevation")) s->p.glance_elevation = state::patchFloat(i);
    else if (state::pathIs(p, l, "unfold_time"))      s->p.unfold_time = state::patchFloat(i);
    else if (state::pathIs(p, l, "hold_time"))       s->p.move_hold = state::patchFloat(i);
    else if (state::pathIs(p, l, "move_ease"))      s->p.move_ease = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep_start"))    s->p.sweep_start = state::patchFloat(i);
    // The sweep. `sweep_start` above is a MOVE parameter and unrelated — it is
    // matched first so the shorter "sweep" test below cannot shadow it.
    else if (state::pathIs(p, l, "sweep"))          s->p.sweep = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep_deadzone")) s->p.sweep_deadzone = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep_depth"))    s->p.sweep_depth = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep_flicker"))  s->p.sweep_flicker = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep_decay"))    s->p.sweep_decay = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep_sense"))    s->p.sweep_sense = state::patchFloat(i);
    else if (state::pathIs(p, l, "sweep_window"))   s->p.sweep_window = state::patchFloat(i);
    else if (state::pathIs(p, l, "latch_drive"))    s->p.latch_drive = state::patchFloat(i);
    else if (state::pathIs(p, l, "ring_time"))      s->p.ring_time = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;   // No rendering — pure data module.
}

}  // namespace three_planes_rig_effect

// Registration is centralized: native via the core bundle's manifest, web via
// the core bundle's nano_module_main (core/main.cpp). Like every other core
// effect, this file defines only the namespace.
