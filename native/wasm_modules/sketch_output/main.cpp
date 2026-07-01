/*
 * util.sketch_output — a sketch's 8 scalar OUTPUTS (the inverse of util.dashboard).
 *
 * The symmetric counterpart to the dashboard: where the dashboard exposes 8
 * sketch-level INPUTS (knobs that internal wires read FROM), this effect exposes
 * 8 sketch-level OUTPUTS that internal wires WRITE INTO. A producer's scalar
 * output is wired into out_0..out_7; each trace's value becomes one of the
 * sketch's outputs — letting a whole sketch behave like an effect module that
 * generates modulation (consumed by a future "video editor" parent context).
 *
 * Like the dashboard it is an always-identity texture passthrough (tex_in ->
 * tex_out) and holds NO per-instance logic: the standard executor tap path
 * drives everything. out_0..out_7 are float fields that are BOTH inputs and
 * outputs (io = SecondaryInput | SecondaryOutput):
 *   - as an INPUT, a field is a read-tap target — an incoming wire writes into it;
 *   - as an OUTPUT, the written value is the sketch's exposed output channel
 *     (captureWriteTaps republishes the relay/modulated value downstream when a
 *     consumer exists — none inside the current IDE; the parent reads them later).
 *
 * Declares `sketch_output_source`. The UI renders the 8 fields as output traces
 * that wires connect INTO (dest endpoints); there is no authored value (no knob).
 */

#include <gpu.h>
#include <host.h>

#include <cstdio>

namespace sketch_output {

constexpr int N_OUT = 8;  // mirrors SKETCH_OUTPUT_TRACE_COUNT in web/src/state/controller.ts

struct State { bool initialized = false; };

// Type-level setup: schema only (no shaders/PSO). 8 in+out trace fields +
// identity texture passthrough. SecondaryInput|SecondaryOutput keeps tex_in/
// tex_out the primary image channel; each trace is a read-tap dest (wire writes
// in) AND an output channel (the relay write-capture republishes it).
void module_init() {
  state::Schema schema;
  schema.helpField("intro",
    "## Sketch Output\n"
    "The sketch's 8 scalar **outputs** — the mirror image of the Dashboard. Where "
    "the dashboard exposes inputs, this node exposes channels that a parent context "
    "reads out. Wire any producer's scalar output into a slot and that value "
    "becomes one of the whole sketch's outputs, letting the sketch behave like an "
    "effect module that generates modulation.\n\n"
    "**Try:** feed an envelope or LFO into a couple of slots to publish live "
    "control signals up to a video-editor timeline. The image passes through "
    "untouched — this node only carries the output values.");
  schema.group("outputs", "Outputs")
    .groupHelp(
      "Eight sketch-level output channels. Each is a wire **destination** — connect "
      "an internal producer INTO it — and the written value is republished as one "
      "of the sketch's exposed outputs. There's no authored knob; the value comes "
      "entirely from the incoming wire.");
  for (int i = 0; i < N_OUT; ++i) {
    char name[16];
    std::snprintf(name, sizeof(name), "out_%d", i);
    char disp[16], shortl[8];
    std::snprintf(disp, sizeof(disp), "Output %d", i + 1);
    std::snprintf(shortl, sizeof(shortl), "O%d", i + 1);
    schema.floatField(name, 0.0f, 0.0f, 1.0f,
                      state::SecondaryInput | state::SecondaryOutput)
          .label(disp, shortl);
  }
  schema.textureField("tex_in",  state::PrimaryInput)
        .textureField("tex_out", state::PrimaryOutput)
        .capability(state::Capability::TimeIndependent)
        .capability(state::Capability::SketchOutputSource);
  state::init("util.sketch_output", {1, 0, 1}, schema);
}

void* create() { return new State(); }
void  destroy(void* self) { delete static_cast<State*>(self); }
void  init(void* self) { auto* s = static_cast<State*>(self); if (s) s->initialized = true; }
void  tick(void*, double) {}
void  on_state_patched(void*, int, const char*, const int*, const int*, const int*) {}

// The IMAGE output always equals the image input — this effect never touches the
// chain. An UNtapped instance is therefore skipped entirely (input aliased to
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

} // namespace sketch_output

// Registration is centralized in the core bundle's nano_module_main
// (core/main.cpp). Like every other core effect, this file defines only the
// namespace.
