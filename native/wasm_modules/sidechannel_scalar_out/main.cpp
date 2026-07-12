/*
 * util.sidechannel_scalar_out — "Value Send": publish a scalar onto a named
 * cross-instance VALUE channel.
 *
 * The scalar twin of util.sidechannel_out: where that one carries an image
 * between instances on the shared server, this one carries a single modulation
 * value. Wire any producer (LFO, envelope, MIDI knob, ...) into `value` and a
 * util.sidechannel_scalar_in on the same channel — in ANY instance — reads it
 * back. Scalar channels have their OWN numbering: value channel 1 has nothing
 * to do with texture channel 1.
 *
 * Like the texture send it holds NO logic: the EXECUTOR host-services the bus
 * (sketch_executor.cpp resolves the channel from this instance's state and
 * publishes the post-wire value into the process-global sidechannel_bus). And
 * like an LFO it declares no texture fields at all, so it is a pure data node —
 * the chain image passes through untouched with zero GPU work.
 */

#include <host.h>

namespace sidechannel_scalar_out {

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

// Static (self-less) inspector-visibility evaluator — resolves the hidden set
// for a candidate state without a live instance (multi-select, off-playhead).
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
    "## Value Send\n"
    "Publishes a scalar onto a named **value sidechannel** — a modulation patch "
    "cable between instances on the shared server. Any instance with a *Value "
    "Receive* on the same channel reads it back (within a frame, depending on "
    "render order).\n\n"
    "**Try:** wire an LFO or an envelope into *Value*, then receive it in another "
    "instance to drive both decks off one motion. The knob is sent as-is when "
    "nothing is wired in, so it doubles as a shared constant.\n\n"
    "Value channels are numbered **separately** from the image channels used by "
    "*Sidechannel Send* — value 1 and image 1 are unrelated.");
  schema.selectField("channel", 1, state::PrimaryInput, {
        {"1", 1}, {"2", 2}, {"3", 3}, {"4", 4},
        {"5", 5}, {"6", 6}, {"7", 7}, {"8", 8},
        {"Custom", 0},
      }, /*wrap=*/true)
      .label("Channel", "Ch")
      .textField("channel_name", "", state::PrimaryInput)
      .label("Custom Name", "Name")
      // The value to publish. A wire lands here like on any other param (folded
      // into [0,1] per its own magnitude/mix), and the executor publishes the
      // post-wire result — so a bool source arrives as the usual 0.0 / 1.0.
      // The `magnitude` marker makes it the module's modulation INPUT channel.
      .floatField("value", 0.0f, 0.0f, 1.0f, state::PrimaryInput, "unsigned")
      .label("Value", "Val")
      // A modulation SINK — it consumes a modulation channel and publishes no
      // output. There is no "sink" capability, and `modulation_shaper` is what
      // the executor's auto-connect gates on, so declaring it is what makes a
      // send dropped directly under an LFO/envelope wire itself up. Chaining
      // stops here: a shaper below us finds no output channel and skips.
      .capability(state::Capability::ModulationShaper)
      .capability(state::Capability::ModulationShaperUnary)
      .capability(state::Capability::TimeIndependent);
  state::init("util.sidechannel_scalar_out", {1, 0, 1}, schema);
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

// No texture output → the executor treats this as a modulation node: it ticks
// (and the host services the bus) while the chain image passes straight through.
void render(void*, int, int) {}

} // namespace sidechannel_scalar_out

// Registration is centralized in the core bundle's nano_module_main
// (core/main.cpp); this file defines only the namespace.
