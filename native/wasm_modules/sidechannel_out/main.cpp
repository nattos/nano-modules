/*
 * util.sidechannel_out — "Sidechannel Send": publish this chain's image onto a
 * named cross-instance texture channel.
 *
 * Sidechannels pass textures BETWEEN barrel instances (or playground
 * instances) on the shared server with no declared wiring — the user picks a
 * channel (8 numbered defaults, or an arbitrary custom name) and remembers
 * what goes where. The matching receiver is util.sidechannel_in.
 *
 * Like util.dashboard / util.sketch_output, the effect itself is an
 * always-identity texture passthrough holding NO logic: the EXECUTOR
 * host-services the bus (sketch_executor.cpp copies the stage's input texture
 * into the process-global sidechannel_bus keyed by the channel name resolved
 * from this instance's state). The fallback render below only matters on
 * hosts that don't service the bus — the image still passes through.
 */

#include <gpu.h>
#include <host.h>

namespace sidechannel_out {

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

// Static (self-less) inspector-visibility evaluator — resolves the hidden
// set for a candidate state without a live instance (multi-select, off-
// playhead). Reads only the gating `channel` select.
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
    "## Sidechannel Send\n"
    "Publishes this chain's image onto a named **sidechannel** — a patch "
    "cable between instances on the shared server. Any instance with a "
    "*Sidechannel Receive* on the same channel picks the image up (within a "
    "frame, depending on render order). The image also passes through "
    "untouched, so the send can sit anywhere in a chain.\n\n"
    "**Try:** send a deck's output to channel 1 and receive it in another "
    "instance to composite decks across Resolume layers. It's up to you to "
    "remember what each channel carries — name a custom channel if numbers "
    "get confusing.");
  schema.selectField("channel", 1, state::PrimaryInput, {
        {"1", 1}, {"2", 2}, {"3", 3}, {"4", 4},
        {"5", 5}, {"6", 6}, {"7", 7}, {"8", 8},
        {"Custom", 0},
      }, /*wrap=*/true)
      .label("Channel", "Ch")
      .textField("channel_name", "", state::PrimaryInput)
      .label("Custom Name", "Name")
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent);
  state::init("util.sidechannel_out", {1, 0, 1}, schema);
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

// The IMAGE output always equals the image input — the executor publishes the
// bus copy host-side. An untapped instance is skipped entirely via the
// identity alias; a tapped one still needs a valid tex_out (cheap copy).
int32_t is_identity(void*) { return 1; }

void render(void* self, int w, int h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || w <= 0 || h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;
  auto in = gpu::Device::textureForField("tex_in");
  if (in.valid()) gpu::Device::copy(in, out);
  else            gpu::Device::clear(out, 0.0f, 0.0f, 0.0f, 0.0f);
  gpu::Device::submit();
}

} // namespace sidechannel_out

// Registration is centralized in the core bundle's nano_module_main
// (core/main.cpp); this file defines only the namespace.
