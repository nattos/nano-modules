/*
 * control.artnet — expose incoming Art-Net (DMX-over-UDP) channels as tappable
 * float rails.
 *
 * An always-identity passthrough (tex_in → tex_out) that publishes 16 float
 * OUTPUT fields (ch_0 .. ch_15). Drop it into a sketch, point it at a universe,
 * and write-tap any channel onto a float rail to route a lighting desk — or
 * `beatsync`'s drum-role triggers — anywhere in the sketch.
 *
 * The channel VALUES are sourced by the HOST, not by this effect — the same
 * arrangement control.barrel_macros uses for Resolume's macro knobs:
 *  - Native (NanoBarrel / ffgl_runner): artnet::ArtNetHost listens on UDP 6454
 *    and BarrelRuntime injects the live channels into this instance each frame,
 *    just before execute(). This path needs no editor and no dev server.
 *  - Web: the Vite dev server's udp-bridge plugin forwards the same datagrams
 *    to the browser, which injects them the same way. A production build has no
 *    bridge, so the outputs read 0.
 *
 * ADDRESSING IS THREE FIELDS, NOT ONE NUMBER. Art-Net's 15-bit port address is
 * Net(7) | Subnet(4) | Universe(4). Carried as a single integer, "universe 17"
 * silently means subnet 1 / universe 1, and a sender patched to subnet 0
 * arrives nowhere — a mistake that cost the sending side (audiooptim's
 * v3_live.mm) a debugging round. Held here as the three fields a lighting desk
 * actually shows.
 *
 * The default universe is 1, not 0. Resolume broadcasts its OWN Art-Net output
 * back into its own input at ~500 packets/second on universe 0 (there is no
 * obvious way to separate its output interface from its input interface), so 0
 * is the one universe on a Resolume rig you do not want to listen to.
 *
 * So this effect needs no per-instance value logic: only the schema (so the
 * outputs are tappable) and a texture passthrough so the chain's image flows
 * through unchanged.
 */

#include <gpu.h>
#include <host.h>

#include <cstdio>

namespace artnet_in {

// The schema's fixed channel ceiling. `channel_count` selects how many are
// live; the rest are hidden per instance by the editor (a schema is published
// once per module TYPE, so arity must be a VALUE, not a shape).
constexpr int kMaxChannels = 16;

struct State { bool initialized = false; };

// Type-level setup: schema only (no shaders/PSO). 16 float outputs + identity
// texture passthrough. SecondaryOutput keeps tex_out the primary.
void module_init() {
  state::Schema schema;
  schema.helpField("intro",
    "## Art-Net In\n"
    "Surfaces incoming **Art-Net / DMX** channels as tappable float rails. Point "
    "the card at a universe and write-tap `Ch 1..16` onto rails to drive anything "
    "in the sketch from a lighting desk, a timecode rig, or a beat-detector "
    "sending triggers.\n\n"
    "**Addressing** is three fields — `Net`, `Subnet`, `Universe` — because that is "
    "what Art-Net actually carries. A single \"universe 17\" would silently mean "
    "subnet 1, universe 1. `Base Ch` is the first DMX address to read (1-based, as "
    "a desk shows it), and `Channels` how many follow.\n\n"
    "**Universe 1 by default:** Resolume broadcasts its own Art-Net output back "
    "into its own input on universe 0, so 0 is usually a firehose of someone "
    "else's data.\n\n"
    "**Note:** values come from the host. Running under NanoBarrel the native "
    "listener feeds them; in the web IDE the dev server's UDP bridge does. With "
    "no source the outputs read 0 and the image passes through untouched.");

  schema.intField("net", 0, 0, 127, state::SecondaryInput)
        .label("Net", "Net");
  schema.intField("subnet", 0, 0, 15, state::SecondaryInput)
        .label("Subnet", "Sub");
  schema.intField("universe", 1, 0, 15, state::SecondaryInput)
        .label("Universe", "Uni");
  schema.intField("base_channel", 1, 1, 512, state::SecondaryInput)
        .label("Base Ch", "Base");
  // Changes the card's SHAPE rather than its value — the editor renders it
  // under the gear icon, like mod_math's `input_count`.
  schema.intField("channel_count", 4, 1, kMaxChannels, state::SecondaryInput)
        .label("Channels", "N");

  schema.group("channels", "Channels");
  for (int i = 0; i < kMaxChannels; ++i) {
    char name[16], disp[16], shortl[8];
    std::snprintf(name, sizeof(name), "ch_%d", i);
    std::snprintf(disp, sizeof(disp), "Ch %d", i + 1);
    std::snprintf(shortl, sizeof(shortl), "%d", i + 1);
    // Unsigned [0,1]: one DMX byte over 255. That range IS the modulation
    // contract downstream taps fold against.
    schema.floatField(name, 0.0f, 0.0f, 1.0f, state::SecondaryOutput, "unsigned")
          .label(disp, shortl);
  }

  schema.textureField("tex_in",  state::PrimaryInput)
        .textureField("tex_out", state::PrimaryOutput)
        .capability(state::Capability::TimeIndependent);
  state::init("control.artnet", {1, 0, 0}, schema);
}

void* create() { return new State(); }
void  destroy(void* self) { delete static_cast<State*>(self); }
void  init(void* self) { auto* s = static_cast<State*>(self); if (s) s->initialized = true; }
void  tick(void*, double) {}
void  on_state_patched(void*, int, const char*, const int*, const int*, const int*) {}

// Always identity: an UNtapped instance is skipped entirely (input aliased to
// output, zero GPU work). A tapped instance is NOT skipped (taps disable the
// alias), so render() must still produce a valid output texture — a cheap copy.
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

} // namespace artnet_in

// Registration is centralized: native via the core bundle's manifest, web via
// the core bundle's nano_module_main (core/main.cpp). Like every other core
// effect, this file defines only the namespace.
