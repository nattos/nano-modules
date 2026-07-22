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
 * of CONTIGUOUS grid cells (streams.clip_grid slots) containing the current
 * scene — Live-style groups, so Next wraps within the group and an empty
 * grid cell (or a bypassed scene) breaks the run.
 *
 * Deterministic: Random/Other use a seeded LCG (export-stable). Re-arms when
 * the launch-relative clock regresses (relaunch/scrub) or the active scene
 * changes.
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
        "of scenes in contiguous grid cells around this one (an empty cell ends "
        "the group). **Follow After** overrides the standard clip duration.\n\n"
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
  // (relaunch / Again / scrub-back).
  if (ord != s->lastOrdinal || elapsed < s->lastElapsed - 1e-6) s->fired = false;
  s->lastOrdinal = ord;
  s->lastElapsed = elapsed;

  double D;
  switch (s->followAfter) {
    case AfterBeats: {
      const double bpm = streams::bpm(parent);
      D = s->followBeats * 60.0 / (bpm > 1 ? bpm : 120.0);
      break;
    }
    case AfterSeconds:
      D = s->followSec;
      break;
    default:
      D = streams::clipDuration(parent, ord);
      break;
  }
  if (std::isnan(D) || !(D > 0)) {
    publishRemaining(-1);  // unbounded: never fires (a looping clip runs on)
    return;
  }
  publishRemaining(std::fmax(0.0, D - elapsed),
                   std::fmin(1.0, std::fmax(0.0, elapsed / D)));
  if (s->fired || elapsed < D) return;
  s->fired = true;

  if (s->mode == ModeStop) {
    streams::stop(parent);
    return;
  }
  if (s->mode == ModeAgain) {
    streams::seek(parent, (double)ord);  // relaunch re-anchors (retrigger)
    return;
  }

  // Candidates = launchable scenes (start events), in ordinal order.
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
  if (nCand == 0) return;

  // Scope Group: keep the maximal run of CONTIGUOUS grid slots containing the
  // current scene. Candidates arrive ordinal-ascending == grid-ascending
  // (grid order IS the ordinal order), so walk outward from self.
  int lo = 0, hi = nCand - 1;
  if (s->scope == ScopeGroup) {
    int selfIdx = -1;
    for (int i = 0; i < nCand; i++) {
      if (cand[i] == ord) { selfIdx = i; break; }
    }
    if (selfIdx >= 0) {
      lo = hi = selfIdx;
      while (lo > 0 && std::abs(streams::clipGrid(parent, cand[lo - 1]) + 1.0 -
                                streams::clipGrid(parent, cand[lo])) < 1e-9)
        lo--;
      while (hi < nCand - 1 && std::abs(streams::clipGrid(parent, cand[hi + 1]) - 1.0 -
                                        streams::clipGrid(parent, cand[hi])) < 1e-9)
        hi++;
    }
  }
  const int count = hi - lo + 1;

  int target = ord;
  switch (s->mode) {
    case ModeNext: {
      target = cand[lo];  // wrap default
      for (int i = lo; i <= hi; i++) {
        if (cand[i] > ord) { target = cand[i]; break; }
      }
      break;
    }
    case ModePrevious: {
      target = cand[hi];  // wrap default
      for (int i = hi; i >= lo; i--) {
        if (cand[i] < ord) { target = cand[i]; break; }
      }
      break;
    }
    case ModeFirst:
      target = cand[lo];
      break;
    case ModeLast:
      target = cand[hi];
      break;
    case ModeRandom:
      target = cand[lo + (int)(lcg(s) * count) % count];
      break;
    case ModeOther: {
      if (count <= 1) {
        target = ord;
        break;
      }
      do {
        target = cand[lo + (int)(lcg(s) * count) % count];
      } while (target == ord);
      break;
    }
    default:
      break;
  }
  streams::seek(parent, (double)target);
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
