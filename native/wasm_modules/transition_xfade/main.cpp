/*
 * transition.xfade — crossfade transition for scene tracks.
 *
 * A TRACK-hosted transport-section effect (lives in the scene TRACK's
 * transport section — track_<trackId>_transport_<devId>; never touches
 * pixels itself). It keeps a STANDING FORK armed on the track's live scene
 * (resources.fork, level-triggered): when the track commits a launch to a
 * different scene, the engine detaches the outgoing playback into the fork —
 * same clipId, same decoder, same effect instances — and the composite grows
 * a track xfade blend (A = outgoing fork, B = incoming). This effect is the
 * BRAIN: it publishes `xfade_mix` (0 = pure outgoing → 1 = pure incoming),
 * which the host folds onto the blend node, and releases the fork when the
 * fade completes.
 *
 * Timing: it watches streams.next_launch — when a controller has ANNOUNCED a
 * launch (a Follow inside its window), it triggers the incoming EARLY at
 * eta ≤ fade duration, so the fade COMPLETES at the outgoing clip's true end
 * (the announcer's own boundary-time fire is dropped engine-side while the
 * fork runs). Manual/unannounced launches fade too — post-boundary, starting
 * at the commit. Precise/Live readiness is invisible here: the fade can only
 * begin once the engine actually commits, which is exactly the readiness
 * policy's decision.
 */

#include <host.h>
#include <resources.h>
#include <streams.h>
#include <val.h>
#include <cmath>
#include <cstdint>

namespace transition_xfade {

struct State {
  float fadeSec = 1.0f;
  float shape = 0.0f;
  // Standing fork: the live scene's resource, re-asserted every tick.
  int64_t armedRes = 0;
  int armedOrd = -1;
  // Active fade.
  bool fading = false;
  int64_t fadeRes = 0;      // the OUTGOING clip's resource (re-assert target)
  double fadeEndClock = 0;
  // Early trigger bookkeeping.
  bool triggered = false;
  double triggerEndClock = 0;
  int triggerTarget = -1;
  // Local clock (accumulated section dt — the comp transport's motion).
  double clock = 0;
  int lastOrd = -1;
};

int32_t is_identity(void* self) {
  (void)self;
  return 1;
}

void module_init() {
  state::init("transition.xfade", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Crossfade\n"
        "A transition for scene tracks: place it on the TRACK's transport "
        "section and every scene change crossfades instead of cutting.\n\n"
        "When a Follow (or any controller) announces the next launch, the "
        "incoming scene starts **Duration** before the outgoing clip's end, "
        "so the fade completes exactly at the boundary. Manual launches fade "
        "too, starting at the switch. The outgoing clip keeps playing through "
        "the fade — its effects and clock carry on untouched.")
      .group("fade", "Fade")
      .floatField("fadeSec", 1.0f, 0.05f, 10.f, state::PrimaryInput, nullptr, 0.f, "s")
        .label("Duration", "Dur")
      .floatField("shape", 0.f, 0.f, 1.f, state::PrimaryInput)
        .label("Shape", "Shp")
      .group("output", "Output")
      .floatField("xfade_mix", 0.f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
        .label("Mix", "Mix")
      .floatField("xfade_shape", 0.f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
        .label("Shape Out", "ShO")
      .capability(state::Capability::TransportSection)
  );
}

void* create() { return new State(); }
void destroy(void* self) { delete static_cast<State*>(self); }

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) {
    const float fade = s->fadeSec;
    const float shape = s->shape;
    *s = State{};
    s->fadeSec = fade;
    s->shape = shape;
  }
}

static void publish(State* s, double mix) {
  auto m = val::number(mix);
  state::setValPath("xfade_mix", m);
  val::release(m);
  auto sh = val::number(s->shape);
  state::setValPath("xfade_shape", sh);
  val::release(sh);
}

// Clears the FADE fields only — a chained early trigger (fired mid-fade for
// the NEXT hop) keeps its bookkeeping so the coming commit still fades on the
// declared window.
static void resetFade(State* s) {
  s->fading = false;
  s->fadeRes = 0;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->clock += (dt > 0 ? dt : 0);

  const streams::Stream parent = streams::parent();
  streams::StreamDesc pd;
  if (!streams::describe(parent, pd) || pd.kind != streams::KindSceneTrack) {
    resetFade(s);
    s->triggered = false;
    s->armedRes = 0;
    publish(s, 0);
    return;
  }
  const double posP = streams::pos(parent);
  const int ord = std::isnan(posP) ? -1 : (int)std::floor(posP);

  // Commit detection FIRST — on any tick, mid-fade included. A flip while we
  // hold a standing arm means the engine detached the outgoing into our fork:
  // start the fade (or restart it — a chained commit snap-finishes the old
  // fork engine-side, and the incoming of the OLD fade keeps its instance
  // keys either way). A flip with no arm is a cut we didn't broker: drop any
  // stale fade state.
  if (ord != s->lastOrd) {
    if (ord >= 0 && s->lastOrd >= 0 && s->armedRes != 0) {
      s->fading = true;
      s->fadeRes = s->armedRes;
      s->fadeEndClock = (s->triggered && s->triggerTarget == ord)
                            ? s->triggerEndClock
                            : s->clock + s->fadeSec;
      s->armedRes = 0;
      resources::fork(s->fadeRes);
    } else {
      resetFade(s);
    }
    s->triggered = false;
    s->lastOrd = ord;
  }

  if (s->fading) {
    // Keep the DETACHED fork alive (level-triggered — silence releases it),
    // and ramp the fade to complete at fadeEndClock.
    resources::fork(s->fadeRes);
    const double remaining = s->fadeEndClock - s->clock;
    const double mix = 1.0 - std::fmax(0.0, remaining) / std::fmax(0.05, (double)s->fadeSec);
    publish(s, std::fmin(1.0, std::fmax(0.0, mix)));
    if (remaining <= 0) {
      resources::release(s->fadeRes);  // fade done — release the fork
      resetFade(s);                    // bookkeeping only; the blend leaves the build
    }
  } else {
    publish(s, 0);
  }

  if (ord < 0) {  // idle track: nothing to arm
    s->armedRes = 0;
    s->armedOrd = -1;
    return;
  }

  // Stale trigger hygiene: a triggered launch that never commits (announce
  // withdrawn, target stopped) must not block future triggers forever.
  if (s->triggered && s->clock > s->triggerEndClock + 2.0) s->triggered = false;

  // Standing successor: keep the live scene's fork armed EVERY tick — during
  // a fade too. Continuous arming is what makes back-to-back transitions
  // (a scene shorter than fade + trigger window) fork instead of cut: the
  // arm is always standing long before any commit evaluates.
  const int64_t res = resources::live(parent);
  s->armedRes = res;
  s->armedOrd = ord;
  if (res != 0) resources::fork(res);

  // Early trigger: an ANNOUNCED launch within the fade window starts the
  // incoming now, so the fade completes at the declared boundary — chained
  // mid-fade triggers included. Pending commits (state 2) are already in
  // flight — nothing to trigger.
  streams::NextLaunchRec nl;
  if (!s->triggered && res != 0 && streams::nextLaunch(parent, nl) && nl.state == 1 &&
      nl.ordinal != ord && nl.eta_sec <= (double)s->fadeSec) {
    s->triggered = true;
    s->triggerTarget = nl.ordinal;
    s->triggerEndClock = s->clock + nl.eta_sec;
    streams::seek(parent, (double)nl.ordinal, streams::LaunchLoose);
  }
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];
    if (state::pathIs(p, l, "fadeSec")) s->fadeSec = state::patchFloat(i);
    else if (state::pathIs(p, l, "shape")) s->shape = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // Identity — the brain never touches pixels; the host wires the blend.
}

}  // namespace transition_xfade
