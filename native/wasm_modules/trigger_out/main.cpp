/*
 * util.trigger_out — "Trigger Send": convert a wired scalar into TRIGGER
 * EVENTS on the global trigger rail.
 *
 * The event-shaped sibling of util.sidechannel_out. Where Sidechannel Send
 * publishes this chain's IMAGE onto a named texture channel, Trigger Send
 * watches a wired scalar (`trigger_in`) and fires an on/off trigger event when
 * it crosses a threshold — the sketch-side way to launch scenes (Resolume
 * clips) on the shared server. Wire anything that swings 0↔1 (an LFO gate, a
 * looper channel out, a beat trigger's pulse) into the Trigger input.
 *
 * The wired value arrives every frame as an ordinary modulated param (the
 * executor's read-tap fold → on_state_patched), so this module just edge-
 * detects it and publishes a bounded "triggers" ring — {seq, on, channel,
 * velocity} — exactly like mod.trigger.beat. The sketch executor drains any
 * TriggerSource ring post-tick onto the process-global trigger_bus, and the
 * shared server launches matching clips. The payload is key-value extensible;
 * consumers ignore unknown keys.
 *
 * Pure data module — no GPU, no texture I/O — so it passes the image chain
 * through untouched (modulation-source passthrough).
 */

#include <host.h>
#include <val.h>

namespace trigger_out {

constexpr int kRingCap = 16;

struct Ev {
  long long seq = 0;
  bool on = false;
  int channel = 1;
  float velocity = 1.0f;
};

struct State {
  bool initialized = false;
  float trigger_in = 0.0f;  // the wired gate (0..1), delivered as a modulated param
  float threshold = 0.5f;
  float channel = 1.0f;
  float velocity = 1.0f;

  bool gateOpen = false;   // last edge state (trigger_in >= threshold)
  long long seq = 0;
  Ev ring[kRingCap];
  int ringLen = 0;
};

static void pushEv(State* s, bool on, int channel, float velocity) {
  Ev e;
  e.seq = ++s->seq;
  e.on = on;
  e.channel = channel;
  e.velocity = velocity;
  if (s->ringLen == kRingCap) {
    for (int i = 1; i < kRingCap; i++) s->ring[i - 1] = s->ring[i];
    s->ringLen--;
  }
  s->ring[s->ringLen++] = e;
}

static void publish(State* s) {
  // Echo the gate as a scalar output so the card has a visible trace and the
  // trigger can also be wired onward like an ordinary modulation output.
  auto out = val::number(s->gateOpen ? 1.0 : 0.0);
  state::setValPath("output", out);
  val::release(out);
  auto arr = val::array();
  for (int i = 0; i < s->ringLen; i++) {
    auto e = val::object();
    val::set(e, "seq", val::number(static_cast<double>(s->ring[i].seq)));
    val::set(e, "on", val::boolean(s->ring[i].on));
    val::set(e, "channel", val::number(s->ring[i].channel));
    val::set(e, "velocity", val::number(s->ring[i].velocity));
    val::push(arr, e);
  }
  state::setValPath("triggers", arr);
  val::release(arr);
}

void module_init() {
  state::init("util.trigger_out", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Trigger Send\n"
        "Fires a **trigger event** onto the global trigger rail when the wired "
        "**Trigger** input crosses the threshold — the sketch-side way to "
        "launch **scenes** (Resolume clips marked with a channel). Events carry "
        "a *Channel* (which scene they address) and a *Velocity*.\n\n"
        "**Try:** wire a Beat Trigger or an LFO into *Trigger*, set *Channel* to "
        "match a clip's *NanoLooper Ch* marker, and the shared server launches "
        "it. The image passes through untouched, so this can sit anywhere in a "
        "chain.")
      .floatField("trigger_in", 0.0f, 0.f, 1.f, state::PrimaryInput)
        .label("Trigger", "Trig")
      .floatField("threshold", 0.5f, 0.f, 1.f, state::PrimaryInput)
        .label("Threshold", "Thr")
      .group("event", "Event")
        .groupHelp(
          "What each fired event carries. *Channel* picks which scene it "
          "addresses; *Velocity* rides along for consumers that read it.")
      .floatField("channel", 1.0f, 1.f, 16.f, state::PrimaryInput, nullptr, 1.f)
        .label("Channel", "Ch")
      .floatField("velocity", 1.0f, 0.f, 1.f, state::PrimaryInput)
        .label("Velocity", "Vel")
      // Gate echo (0/1): a visible trace + an ordinary modulation output.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
      .capability(state::Capability::TriggerSource)
      .capability(state::Capability::ModulationSource)
      .capability(state::Capability::ModulationSourceSingle)
  );
  state::log("trigger.out: init");
}

void* create() { return new State(); }
void destroy(void* self) { delete static_cast<State*>(self); }
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  *s = State();
  s->initialized = true;
}

void tick(void* self, double) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  const bool open = s->trigger_in >= s->threshold;
  if (open != s->gateOpen) {
    const int channel = static_cast<int>(s->channel + 0.5f);
    pushEv(s, /*on=*/open, channel, s->velocity);
    s->gateOpen = open;
  }
  publish(s);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "trigger_in"))
      s->trigger_in = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "threshold"))
      s->threshold = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "channel"))
      s->channel = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "velocity"))
      s->velocity = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;  // pure data module
}

// No texture output → the executor treats this as a modulation source and
// passes the image chain through untouched (no is_identity needed).

}  // namespace trigger_out

// Registration is centralized in the core bundle's nano_module_main
// (core/main.cpp); this file defines only the namespace.
