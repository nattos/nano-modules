/*
 * debug.trigger_probe — the event-out imports, which the looper used to be
 * the only caller of. TEST-ONLY.
 *
 * Each rising edge of `fire` (in tick, so a patch and a wire behave alike):
 *   host.trigger_audio(channel)          → the native audio_bus / the web
 *                                          instance's onAudioTrigger
 *   resolume.trigger_clip(clip, on)      → on at the edge, off on the falling
 *                                          edge (a no-op sink in today's hosts;
 *                                          the call pins that the import links)
 *   state.console_log_structured(...)    → "trigger_probe: fired" with
 *                                          {"channel": N, "count": K}
 * and `fired` (an output) republishes the running count.
 *
 * Pure data module — no GPU, no texture I/O.
 */

#include <host.h>
#include <val.h>

#include <cstdio>

namespace trigger_probe {

struct State {
  bool  fire = false;
  bool  was_on = false;
  int   channel = 0;
  int   clip = 7;
  int   count = 0;
};

void module_init() {
  state::init("debug.trigger_probe", {1, 0, 0},
    state::Schema()
      .boolField("fire", false, state::PrimaryInput)
      .intField("channel", 0, 0, 15)
      .intField("clip", 7, 0, 1000)
      .floatField("fired", 0.0f, 0.0f, 1e6f, state::PrimaryOutput, "unsigned")
  );
}

void* create() { return new State(); }
void destroy(void* self) { delete static_cast<State*>(self); }

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) *s = State{};
}

void tick(void* self, double) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (s->fire && !s->was_on) {
    s->count++;
    host::triggerAudio(s->channel);
    resolume::triggerClip(s->clip, true);
    char json[64];
    std::snprintf(json, sizeof(json), "{\"channel\":%d,\"count\":%d}",
                  s->channel, s->count);
    state::logStructured(state::LogLevel::Info, "trigger_probe: fired", json);
  } else if (!s->fire && s->was_on) {
    resolume::triggerClip(s->clip, false);
  }
  s->was_on = s->fire;
  auto v = val::number(static_cast<double>(s->count));
  state::setValPath("fired", v);
  val::release(v);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    if (state::pathIs(p, len[i], "fire"))         s->fire    = state::patchBool(i);
    else if (state::pathIs(p, len[i], "channel")) s->channel = state::patchInt(i);
    else if (state::pathIs(p, len[i], "clip"))    s->clip    = state::patchInt(i);
  }
}

void render(void*, int, int) {}

}  // namespace trigger_probe
