/*
 * util.dashboard — a bank of 8 knobs, each a wire SOURCE and SINK for macro control.
 *
 * The real, schema-backed replacement for the executor's former virtual
 * `util.dashboard` knob bank (the hand-written runDashboard handler). It is an
 * always-identity texture passthrough (tex_in -> tex_out) that exposes
 * knob_0..knob_7 as float fields which are BOTH inputs and outputs (io =
 * SecondaryInput | SecondaryOutput):
 *   - as an INPUT, a knob is the user-set value (state.knob_i, edited via the
 *     dashboard UI) AND a read-tap target (an input wire modulates it);
 *   - as an OUTPUT, the knob's resolved value is write-tapped onto a rail and
 *     routed downstream.
 *
 * This effect holds NO per-instance knob logic: the standard executor tap path
 * drives everything. A knob's stored value lives in the sketch instance state;
 * applyReadTaps modulates it from input wires; captureWriteTaps publishes it
 * (the relay case — a field that is both read- AND write-tapped publishes the
 * MODULATED value; see SketchExecutor::captureWriteTaps). So the schema (knob
 * ranges so wire normalization folds into [0,1]) plus an identity passthrough
 * are all that's needed.
 *
 * Declares `sketch_input_source`: its knobs ARE the sketch's exposed input
 * parameters (consumed by the dashboard UI / a future external control surface).
 * The UI owns per-knob labels + active state at the sketch level.
 */

#include <gpu.h>
#include <host.h>

#include <cstdio>

namespace dashboard {

constexpr int N_KNOBS = 8;  // mirrors DASHBOARD_KNOB_COUNT in web/src/state/controller.ts

struct State { bool initialized = false; };

// Type-level setup: schema only (no shaders/PSO). 8 knob in+out fields +
// identity texture passthrough. SecondaryInput|SecondaryOutput keeps tex_in/
// tex_out the primary image channel; each knob is tappable both ways.
void module_init() {
  state::Schema schema;
  schema.helpField("intro",
    "## Dashboard\n"
    "The sketch's **macro control panel** — a bank of 8 knobs that ARE the "
    "sketch's exposed inputs. Wire a knob's output into any parameter to drive it, "
    "then perform the knob live (or let an incoming wire or external surface "
    "modulate it). Each knob is normalized to `[0, 1]` so it folds cleanly into "
    "whatever it drives.\n\n"
    "**Try:** route one knob to several parameters at once for a single \"scene\" "
    "fader; or read-tap a knob from an LFO so a hands-off source animates your "
    "whole patch. The image passes through untouched — this node only carries the "
    "control values.");
  schema.group("knobs", "Knobs")
    .groupHelp(
      "Eight general-purpose macro knobs. Each is both a **source** (its value "
      "drives downstream params via an outgoing wire) and a **sink** (an incoming "
      "wire modulates it). Name and arrange them per-sketch in the dashboard UI.");
  for (int i = 0; i < N_KNOBS; ++i) {
    char name[16];
    std::snprintf(name, sizeof(name), "knob_%d", i);
    char disp[16], shortl[8];
    std::snprintf(disp, sizeof(disp), "Knob %d", i + 1);
    std::snprintf(shortl, sizeof(shortl), "K%d", i + 1);
    schema.floatField(name, 0.0f, 0.0f, 1.0f,
                      state::SecondaryInput | state::SecondaryOutput)
          .label(disp, shortl);
  }
  schema.textureField("tex_in",  state::PrimaryInput)
        .textureField("tex_out", state::PrimaryOutput)
        .capability(state::Capability::TimeIndependent)
        .capability(state::Capability::SketchInputSource);
  state::init("util.dashboard", {1, 0, 1}, schema);
}

void* create() { return new State(); }
void  destroy(void* self) { delete static_cast<State*>(self); }
void  init(void* self) { auto* s = static_cast<State*>(self); if (s) s->initialized = true; }
void  tick(void*, double) {}
void  on_state_patched(void*, int, const char*, const int*, const int*, const int*) {}

// The IMAGE output always equals the image input — the dashboard never touches
// the chain. An UNtapped instance is therefore skipped entirely (input aliased
// to output, zero GPU work). A tapped instance is NOT skipped (taps disable the
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

} // namespace dashboard

// Registration is centralized in the core bundle's nano_module_main
// (core/main.cpp). Like every other core effect, this file defines only the
// namespace.
