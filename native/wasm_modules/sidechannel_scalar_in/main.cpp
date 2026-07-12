/*
 * util.sidechannel_scalar_in — "Value Receive": read a named cross-instance
 * VALUE channel as a modulation source.
 *
 * The receiving end of util.sidechannel_scalar_out (see there for the value-
 * sidechannel concept). Its `value` output carries whatever the matching send
 * publishes, and wires out of it drive params like any other modulation source.
 *
 * When the channel is STALE — nothing written within a frame, because the
 * sender was removed, bypassed, or its instance stopped rendering — the output
 * falls back to **0.0**, the same "unplugged cable carries no signal" contract
 * as the texture receive's transparent black.
 *
 * Fully host-serviced: the EXECUTOR resolves the channel from this instance's
 * state and folds the bus value into the outgoing wire (sketch_executor.cpp).
 * The effect itself holds no logic, and declares no texture fields — it's a
 * pure data node, so the chain image passes through untouched.
 */

#include <host.h>

namespace sidechannel_scalar_in {

struct State {
  bool initialized = false;
  int channel = 1;  // 1..8, or 0 = Custom (channel_name text field)
};

/// Hide the custom-name text field unless "Custom" is selected. Shared by
/// on_state_ready / on_state_patched / the static eval_visibility.
static void apply_channel_visibility(int channel) {
  state::setFieldHidden("channel_name", channel != 0);
}

static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  apply_channel_visibility(s->channel);
}

// Static (self-less) inspector-visibility evaluator (see crop/main.cpp).
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops) {
  int channel = 1;  // schema default
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "channel")) channel = (int)state::patchFloat(i);
  }
  apply_channel_visibility(channel);
}

void module_init() {
  state::Schema schema;
  schema.helpField("intro",
    "## Value Receive\n"
    "Reads a named **value sidechannel** — whatever a *Value Send* on the same "
    "channel is publishing, from ANY instance on the shared server — and exposes "
    "it as a modulation source. Wire the output into any param.\n\n"
    "When nothing is being sent (the sender was removed, bypassed, or its "
    "instance stopped rendering), the output falls back to **0**, like an "
    "unplugged cable. Execution order matters: a sender that renders after this "
    "instance arrives one frame late.\n\n"
    "Value channels are numbered **separately** from the image channels used by "
    "*Sidechannel Receive* — value 1 and image 1 are unrelated.");
  schema.selectField("channel", 1, state::PrimaryInput, {
        {"1", 1}, {"2", 2}, {"3", 3}, {"4", 4},
        {"5", 5}, {"6", 6}, {"7", 7}, {"8", 8},
        {"Custom", 0},
      }, /*wrap=*/true)
      .label("Channel", "Ch")
      .textField("channel_name", "", state::PrimaryInput)
      .label("Custom Name", "Name")
      // The channel's value, host-written each frame (0 when stale). min/max is
      // the modulation-range contract a consumer's wire folds against; the
      // `magnitude` marker makes it this module's modulation OUTPUT channel
      // (unsigned — a send folds whatever it receives into [0,1]).
      .floatField("value", 0.0f, 0.0f, 1.0f, state::PrimaryOutput, "unsigned")
      .label("Value", "Val")
      // A single-channel modulation source: one canonical scalar output.
      .capability(state::Capability::ModulationSource)
      .capability(state::Capability::ModulationSourceSingle)
      .capability(state::Capability::TimeIndependent);
  state::init("util.sidechannel_scalar_in", {1, 0, 1}, schema);
  state::setOnStateReady(&on_state_ready);
}

void* create() { return new State(); }
void  destroy(void* self) { delete static_cast<State*>(self); }
void  init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->channel = 1;
  s->initialized = true;
}
void tick(void*, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off, const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "channel")) {
      const int ch = (int)state::patchFloat(i);
      if (ch != s->channel) {
        s->channel = ch;
        apply_channel_visibility(ch);
      }
    }
  }
}

// No texture output → a modulation node: the chain image passes through and the
// executor folds the bus value into this stage's outgoing wires.
void render(void*, int, int) {}

} // namespace sidechannel_scalar_in

// Registration is centralized in the core bundle's nano_module_main
// (core/main.cpp); this file defines only the namespace.
