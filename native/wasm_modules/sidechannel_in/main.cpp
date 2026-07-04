/*
 * util.sidechannel_in — "Sidechannel Receive": replace this chain's image with
 * a named cross-instance texture channel.
 *
 * The receiving end of util.sidechannel_out (see there for the sidechannel
 * concept). REPLACE semantics: while the channel is FRESH — written within a
 * frame, accounting for whether this instance renders before or after the
 * writer — the stage output IS the channel texture (scaled to this chain's
 * size) and the chain input is discarded. When the channel is stale (writer
 * deleted/bypassed/stopped), unwritten, or unbound, the output is TRANSPARENT
 * BLACK — an unplugged patch cable carries no signal.
 *
 * Fully host-serviced: the EXECUTOR resolves the channel from this instance's
 * state and blits from the process-global sidechannel_bus; this render() only
 * runs on hosts that don't service the bus (e.g. the comp executor), where it
 * degrades gracefully to the same transparent black.
 */

#include <gpu.h>
#include <host.h>

namespace sidechannel_in {

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
    "## Sidechannel Receive\n"
    "Replaces this chain's image with whatever a *Sidechannel Send* on the "
    "same channel is publishing — from ANY instance on the shared server. "
    "When nothing is being sent (the sender was removed, bypassed, or its "
    "instance stopped rendering), the output goes **transparent black**, like "
    "an unplugged cable.\n\n"
    "**Try:** receive another deck's output at the head of a chain, then "
    "composite your own layers over it. Execution order matters: a sender "
    "that renders after this instance arrives one frame late.");
  schema.selectField("channel", 1, state::PrimaryInput, {
        {"1", 1}, {"2", 2}, {"3", 3}, {"4", 4},
        {"5", 5}, {"6", 6}, {"7", 7}, {"8", 8},
        {"Custom", 0},
      }, /*wrap=*/true)
      .label("Channel", "Ch")
      .textField("channel_name", "", state::PrimaryInput)
      .label("Custom Name", "Name")
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput);
  state::init("util.sidechannel_in", {1, 0, 1}, schema);
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

// NOT identity: the output never equals the input (REPLACE semantics), so the
// executor must never alias this stage away.
int32_t is_identity(void*) { return 0; }

// Fallback only (see header comment): hosts that service the bus never call
// this. Degrade to the stale behavior — transparent black.
void render(void* self, int w, int h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || w <= 0 || h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;
  gpu::Device::clear(out, 0.0f, 0.0f, 0.0f, 0.0f);
  gpu::Device::submit();
}

} // namespace sidechannel_in

// Registration is centralized in the core bundle's nano_module_main
// (core/main.cpp); this file defines only the namespace.
