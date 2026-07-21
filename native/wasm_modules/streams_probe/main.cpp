/*
 * testonly.streams_probe — integration probe for the seekable-streams ABI
 * (streams.h). NOT shipped; loaded only by the test suites.
 *
 * Every tick it interrogates its parent + content streams and REPUBLISHES what
 * it saw as `seen_*` output fields, so both hosts' tests can assert the whole
 * surface end-to-end (imports → registry → published state) without GPU work.
 * It also publishes the reserved transport-controller output contract
 * (`transport_time_sec` = rate x parent seconds) — the minimal scripted
 * "transport controller" the executor pre-pass tests drive.
 *
 * Published values use -1 as the "undefined" sentinel where the ABI answers
 * NaN (published state is JSON-shaped; NaN doesn't survive the trip).
 */

#include <host.h>
#include <streams.h>
#include <val.h>
#include <cmath>

namespace streams_probe {

struct State {
  float rate = 1.0f;
};

int32_t is_identity(void* self) {
  (void)self;
  return 1;  // pure passthrough — a transport controller never touches pixels
}

void module_init() {
  state::init("testonly.streams_probe", {1, 0, 0},
    state::Schema()
      .floatField("rate", 1.0f, -4.f, 4.f, state::PrimaryInput).label("Rate", "Rate")
      // ── The seen_* mirror of the streams surface ──
      .floatField("seen_parent_kind", -1.f, -1.f, 8.f, state::SecondaryOutput, "unsigned")
        .label("Parent Kind", "PKi")
      .floatField("seen_parent_pos", -1.f, -1e6f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("Parent Pos", "PPo")
      .floatField("seen_parent_playing", 0.f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
        .label("Parent Playing", "PPl")
      .floatField("seen_content_kind", -1.f, -1.f, 8.f, state::SecondaryOutput, "unsigned")
        .label("Content Kind", "CKi")
      .floatField("seen_content_pos", -1.f, -1e6f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("Content Pos", "CPo")
      .floatField("seen_event_count", -1.f, -1.f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("Events", "Ev")
      .floatField("seen_first_time", -1.f, -1e6f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("First Event", "Ev0")
      .floatField("seen_first_channel", -1.f, -1.f, 64.f, state::SecondaryOutput, "unsigned")
        .label("First Channel", "Ch0")
      .floatField("seen_rev", 0.f, 0.f, 1e9f, state::SecondaryOutput, "unsigned")
        .label("Rev", "Rev")
      .floatField("seen_stream_count", 0.f, 0.f, 1e4f, state::SecondaryOutput, "unsigned")
        .label("Streams", "N")
      // ── The reserved transport-controller output contract ──
      .floatField("transport_time_sec", 0.f, -1e6f, 1e6f, state::SecondaryOutput, "unsigned")
        .label("Time", "T")
      .capability(state::Capability::TransportController)
  );
}

void* create() { return new State(); }

void destroy(void* self) { delete static_cast<State*>(self); }

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) *s = State{};
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)dt;
  const auto safe = [](double v) { return std::isnan(v) ? -1.0 : v; };
  const auto pub = [](const char* path, double v) {
    auto h = val::number(v);
    state::setValPath(path, h);
    val::release(h);
  };

  const streams::Stream parent = streams::parent();
  streams::StreamDesc pd;
  streams::describe(parent, pd);
  const streams::Stream content = streams::content();
  streams::StreamDesc cd;
  const bool hasContent = content != streams::kInvalid && streams::describe(content, cd);

  double firstTime = -1, firstChannel = -1;
  if (pd.event_count > 0) {
    streams::Event ev[4];
    if (streams::readEvents(parent, 0, ev, 4) > 0) {
      firstTime = ev[0].time;
      firstChannel = safe(ev[0].channel);
    }
  }

  pub("seen_parent_kind", pd.kind);
  pub("seen_parent_pos", safe(streams::pos(parent)));
  pub("seen_parent_playing", streams::playing(parent) ? 1 : 0);
  pub("seen_content_kind", hasContent ? cd.kind : -1);
  pub("seen_content_pos", hasContent ? safe(streams::pos(content)) : -1);
  pub("seen_event_count", pd.event_count);
  pub("seen_first_time", firstTime);
  pub("seen_first_channel", firstChannel);
  pub("seen_rev", streams::rev(parent));
  pub("seen_stream_count", streams::count());

  const double parentSec = streams::posSec(parent);
  pub("transport_time_sec", std::isnan(parentSec) ? 0.0 : s->rate * parentSec);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "rate")) s->rate = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;
  // Identity — the executor aliases input→output (is_identity).
}

}  // namespace streams_probe
