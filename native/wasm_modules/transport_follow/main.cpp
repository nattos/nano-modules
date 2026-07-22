/*
 * core.transport.follow — follow actions / autopilot for scene tracks.
 *
 * A NON-driving transport-section effect (Capability::TransportSection): it
 * never touches its clip's content time. It watches the parent SCENE TRACK
 * stream, waits for the clip's duration to elapse — the STANDARD duration
 * (streams.clip_duration: the engine auto-stop's math) or its own Follow
 * After override — then launches the next scene via streams.seek (Live's
 * follow actions; Resolume's autopilot). A section holding this effect OWNS
 * the clip's end-of-life: the engine's config auto-stop defers to it.
 *
 * Scope: Track = all launchable scenes on the track; Group = the maximal run
 * of TOUCHING scene cells containing the current scene (streams.clip_group:
 * abutting or overlapping spans join, no bar alignment required) — Live-style
 * groups, so Next wraps within the group and a spatial gap (or a bypassed /
 * truly-empty scene) breaks the run.
 *
 * Deterministic: Random/Other use a seeded LCG (export-stable). Re-arms when
 * the launch-relative clock regresses (relaunch/scrub) or the active scene
 * changes.
 *
 * Gapless: inside the last ~4 s the effect ANNOUNCES its intended target
 * (streams.announce) so the host precaches/primes exactly that scene —
 * Random/Other pre-draw once per cycle so the fire honors the announcement.
 */

#include <host.h>
#include <streams.h>
#include <val.h>
#include <cmath>
#include <cstdint>

namespace transport_follow {

enum Mode : int {
  ModeNext = 0, ModePrevious = 1, ModeFirst = 2, ModeLast = 3,
  ModeRandom = 4, ModeOther = 5, ModeAgain = 6, ModeStop = 7,
};

enum Scope : int { ScopeGroup = 0, ScopeTrack = 1 };

enum FollowAfter : int { AfterAuto = 0, AfterBeats = 1, AfterSeconds = 2 };

struct State {
  int mode = ModeNext;
  int scope = ScopeTrack;
  int followAfter = AfterAuto;
  float followBeats = 4.0f;
  float followSec = 2.0f;
  float seed = 0.0f;
  // Firing state.
  bool fired = false;
  int lastOrdinal = -1;
  double lastElapsed = -1e30;
  bool rngInit = false;
  uint32_t rng = 0;
  /** Random/Other pre-draw (streams.announce must name the REAL target, and
   *  the fire must honor what it announced): one draw per armed cycle,
   *  cleared exactly where `fired` clears (the re-arm edge). */
  bool planned = false;
  int plannedTarget = -1;
};

inline double lcg(State* s) {
  if (!s->rngInit) {
    s->rngInit = true;
    s->rng = (uint32_t)(s->seed * 4294967295.0) ^ 0x6c078965u;
  }
  s->rng = s->rng * 1664525u + 1013904223u;
  return s->rng / 4294967296.0;
}

int32_t is_identity(void* self) {
  (void)self;
  return 1;
}

static void apply_after_visibility(int after) {
  state::setFieldHidden("followBeats", after != AfterBeats);
  state::setFieldHidden("followSec", after != AfterSeconds);
}

void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops) {
  int after = AfterAuto;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "followAfter")) after = (int)state::patchFloat(i);
  }
  apply_after_visibility(after);
}

static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) apply_after_visibility(s->followAfter);
}

void module_init() {
  state::init("core.transport.follow", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Follow\n"
        "Autopilot for scene tracks: when this scene's duration elapses, launch "
        "another scene on the same track — Live's follow actions.\n\n"
        "**Scope** picks the pool: the whole *Track* (default), or the *Group* "
        "of scenes whose cells touch this one (a gap between cells ends the "
        "group). **Follow After** overrides the standard clip duration.\n\n"
        "While a Follow sits on a scene, the engine's automatic one-shot stop "
        "defers to it — the scene ends when Follow says so.")
      .group("action", "Action")
      .selectField("mode", ModeNext, state::PrimaryInput,
                   {{"Next", ModeNext}, {"Previous", ModePrevious},
                    {"First", ModeFirst}, {"Last", ModeLast},
                    {"Random", ModeRandom}, {"Other", ModeOther},
                    {"Again", ModeAgain}, {"Stop", ModeStop}})
        .label("Action", "Act")
      .selectField("scope", ScopeTrack, state::PrimaryInput,
                   {{"Group", ScopeGroup}, {"Track", ScopeTrack}})
        .label("Scope", "Scp")
      .group("timing", "Timing")
      .selectField("followAfter", AfterAuto, state::PrimaryInput,
                   {{"Auto", AfterAuto}, {"Beats", AfterBeats}, {"Seconds", AfterSeconds}})
        .label("Follow After", "Aft")
      .floatField("followBeats", 4.0f, 0.25f, 256.f, state::PrimaryInput, nullptr, 0.f, "beats")
        .label("Beats", "Bts")
      .floatField("followSec", 2.0f, 0.05f, 600.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("Seconds", "Sec")
      .floatField("seed", 0.f, 0.f, 1.f, state::PrimaryInput).label("Seed", "Sd")
      .group("output", "Output")
      // Seconds until the follow fires; -1 while idle / unbounded. NOTE: the
      // declared range must cover followSec's max, so on a trace a short
      // countdown is a near-flat line — watch follow_phase for motion.
      .floatField("follow_remaining_sec", -1.f, -1.f, 600.f, state::SecondaryOutput, "unsigned")
        .label("Remaining", "Rem")
      // elapsed/duration as a 0→1 ramp toward the fire (0 while idle): trace-
      // visible at any duration, and wireable as a pre-transition envelope.
      .floatField("follow_phase", 0.f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
        .label("Phase", "Ph")
      .capability(state::Capability::TransportSection)
  );
  state::setOnStateReady(&on_state_ready);
}

void* create() { return new State(); }
void destroy(void* self) { delete static_cast<State*>(self); }

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) *s = State{};
}

static void publishRemaining(double v, double phase = 0.0) {
  auto h = val::number(v);
  state::setValPath("follow_remaining_sec", h);
  val::release(h);
  auto p = val::number(phase);
  state::setValPath("follow_phase", p);
  val::release(p);
}

/** The follow's pick: candidates = launchable scenes (start events) in
 *  ordinal order; Scope Group keeps the run of TOUCHING cells
 *  (streams.clip_group) around self. Returns the target ordinal or -1.
 *  Stable within an armed cycle — deterministic modes recompute identically
 *  and Random/Other PRE-DRAW once (s->planned) — so the announce and the
 *  fire name the same scene. */
static int pickTarget(State* s, streams::Stream parent, int ord) {
  int cand[64];
  int nCand = 0;
  const int total = streams::eventCount(parent);
  streams::Event ev[16];
  for (int first = 0; first < total && nCand < 64;) {
    const int n = streams::readEvents(parent, first, ev, 16);
    if (n <= 0) break;
    for (int k = 0; k < n && nCand < 64; k++) {
      if (ev[k].isStart()) cand[nCand++] = (int)ev[k].clipOrdinal;
    }
    first += n;
  }
  if (nCand == 0) return -1;

  // Scope Group: keep the candidates sharing this scene's follow-group id —
  // the host groups maximal runs of TOUCHING spans (streams.clip_group), so
  // freeform placement groups by visual adjacency, no bar alignment needed.
  // Candidates arrive ordinal-ascending == grid-ascending, so walk outward
  // from self while the id holds (ids are small integers; == is exact).
  int lo = 0, hi = nCand - 1;
  if (s->scope == ScopeGroup) {
    int selfIdx = -1;
    for (int i = 0; i < nCand; i++) {
      if (cand[i] == ord) { selfIdx = i; break; }
    }
    const double group = streams::clipGroup(parent, ord);
    if (selfIdx >= 0 && group >= 0) {
      lo = hi = selfIdx;
      while (lo > 0 && streams::clipGroup(parent, cand[lo - 1]) == group) lo--;
      while (hi < nCand - 1 && streams::clipGroup(parent, cand[hi + 1]) == group) hi++;
    }
  }
  const int count = hi - lo + 1;
  const auto inPool = [&](int t) {
    for (int i = lo; i <= hi; i++) {
      if (cand[i] == t) return true;
    }
    return false;
  };

  switch (s->mode) {
    case ModeNext: {
      for (int i = lo; i <= hi; i++) {
        if (cand[i] > ord) return cand[i];
      }
      return cand[lo];  // wrap
    }
    case ModePrevious: {
      for (int i = hi; i >= lo; i--) {
        if (cand[i] < ord) return cand[i];
      }
      return cand[hi];  // wrap
    }
    case ModeFirst:
      return cand[lo];
    case ModeLast:
      return cand[hi];
    case ModeRandom: {
      // Re-draw only when the planned target left the pool (doc edit).
      if (!s->planned || !inPool(s->plannedTarget)) {
        s->planned = true;
        s->plannedTarget = cand[lo + (int)(lcg(s) * count) % count];
      }
      return s->plannedTarget;
    }
    case ModeOther: {
      if (count <= 1) return ord;
      if (!s->planned || !inPool(s->plannedTarget) || s->plannedTarget == ord) {
        s->planned = true;
        do {
          s->plannedTarget = cand[lo + (int)(lcg(s) * count) % count];
        } while (s->plannedTarget == ord);
      }
      return s->plannedTarget;
    }
    default:
      return ord;
  }
}

void tick(void* self, double dt) {
  (void)dt;
  auto* s = static_cast<State*>(self);
  if (!s) return;

  const streams::Stream parent = streams::parent();
  streams::StreamDesc pd;
  if (!streams::describe(parent, pd) || pd.kind != streams::KindSceneTrack) {
    publishRemaining(-1);
    s->fired = false;
    s->lastOrdinal = -1;
    return;
  }
  const double posP = streams::pos(parent);
  if (std::isnan(posP)) {  // nothing launched on the track
    publishRemaining(-1);
    s->fired = false;
    s->lastOrdinal = -1;
    return;
  }
  const int ord = (int)std::floor(posP);
  const double elapsed = streams::posSec(parent);
  // Re-arm on a scene change or a launch-relative clock regression
  // (relaunch / Again / scrub-back). The Random/Other pre-draw re-arms on
  // the SAME edge (an ordinal marker alone would reuse a stale draw across
  // an Again/self-relaunch cycle).
  if (ord != s->lastOrdinal || elapsed < s->lastElapsed - 1e-6) {
    s->fired = false;
    s->planned = false;
  }
  s->lastOrdinal = ord;
  s->lastElapsed = elapsed;

  // The fire condition lives on ONE clock: `now` vs `fireAt` in `unit`s, with
  // unitScale converting a unit to display seconds. Auto reads the content
  // stream's SEMANTIC timeline — the first event is 'ended' (one-shot: the
  // auto-stop time) or the first 'looped' (played through once), and a driven
  // clip's controller-declared future rides the same surface. Fallbacks (no
  // content stream = effect-only scene; no boundaries = random mode) and the
  // Beats/Seconds overrides use the standard clip duration clock as before.
  const double bpm = streams::bpm(parent);
  const double spb = 60.0 / (bpm > 1 ? bpm : 120.0);
  double now = elapsed;  // scene seconds
  double fireAt;
  double unitScale = 1.0;
  bool haveFire = false;
  switch (s->followAfter) {
    case AfterBeats:
      fireAt = s->followBeats * spb;
      haveFire = fireAt > 0;
      break;
    case AfterSeconds:
      fireAt = s->followSec;
      haveFire = fireAt > 0;
      break;
    default: {
      const streams::Stream ev = streams::content();
      streams::Event e0;
      if (ev && streams::eventCount(ev) > 0 && streams::readEvents(ev, 0, &e0, 1) == 1 &&
          e0.time > 0) {
        now = streams::elapsed(ev);
        fireAt = e0.time;
        haveFire = !std::isnan(now);
        // The event axis is seconds — beats for beat-sync clips. Scenes anchor
        // content at the launch instant, so whichever reading of `now` matches
        // the scene's elapsed SECONDS reveals the unit (identical at 60 BPM,
        // where the conversion is 1 anyway).
        unitScale = std::fabs(now * spb - elapsed) <= std::fabs(now - elapsed) ? spb : 1.0;
      } else {
        fireAt = streams::clipDuration(parent, ord);
        haveFire = !std::isnan(fireAt) && fireAt > 0;
      }
      break;
    }
  }
  if (!haveFire) {
    publishRemaining(-1);  // unbounded: never fires (a looping clip runs on)
    return;
  }
  const double remainingSec = std::fmax(0.0, (fireAt - now) * unitScale);
  publishRemaining(remainingSec, std::fmin(1.0, std::fmax(0.0, now / fireAt)));

  // ANNOUNCE inside the host's precache horizon: declare the intended target
  // so the host warms/primes it EXACTLY (its proximity heuristic can miss a
  // Last/Random pick). Level-triggered — re-asserted each tick; the host
  // expires a silent announce, so a mode/param edit self-corrects. Bounded to
  // ~2x the host's 2 s warm window: keeps the per-tick candidate enumeration
  // off the steady-state path. Again/Stop never announce (self is already
  // decoded; a stop has nothing to warm).
  if (!s->fired && remainingSec <= 4.0 && s->mode != ModeStop && s->mode != ModeAgain) {
    const int target = pickTarget(s, parent, ord);
    if (target >= 0) streams::announce(parent, (double)target, remainingSec);
  }

  if (s->fired || now < fireAt) return;
  s->fired = true;

  if (s->mode == ModeStop) {
    streams::stop(parent);
    return;
  }
  if (s->mode == ModeAgain) {
    streams::seek(parent, (double)ord);  // relaunch re-anchors (retrigger)
    return;
  }
  // The fire honors what the announce declared (pickTarget is stable within
  // a cycle: deterministic modes recompute identically; Random/Other reuse
  // the pre-draw unless the pool changed under it).
  const int target = pickTarget(s, parent, ord);
  if (target >= 0) streams::seek(parent, (double)target);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];
    if (state::pathIs(p, l, "mode")) s->mode = state::patchInt(i);
    else if (state::pathIs(p, l, "scope")) s->scope = state::patchInt(i);
    else if (state::pathIs(p, l, "followAfter")) {
      s->followAfter = state::patchInt(i);
      apply_after_visibility(s->followAfter);
    }
    else if (state::pathIs(p, l, "followBeats")) s->followBeats = state::patchFloat(i);
    else if (state::pathIs(p, l, "followSec")) s->followSec = state::patchFloat(i);
    else if (state::pathIs(p, l, "seed")) {
      s->seed = state::patchFloat(i);
      s->rngInit = false;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // Identity — never touches pixels.
}

}  // namespace transport_follow
