/*
 * control.barrel_macros — expose NanoBarrel's 16 macro knobs as tappable float rails.
 *
 * An always-identity passthrough (tex_in → tex_out) that publishes 16 float
 * OUTPUT fields (macro_0 .. macro_15). Drop it into a sketch and write-tap any
 * macro output onto a float rail to route a Resolume macro knob anywhere (then
 * read-tap that rail into a param, with a Mix Mode if you want to modulate).
 *
 * The macro VALUES are sourced by the HOST, not by this effect:
 *  - Native (NanoBarrel / ffgl_runner): the barrel plugin injects the live knob
 *    values into this instance's state (macro_0..15) each frame, just before
 *    execute(). The executor's write-tap capture reads them from the sketch
 *    instance state (see SketchExecutor::captureWriteTaps).
 *  - Web local mode (no Resolume): there's no source, so the outputs read 0 /
 *    inactive — by design (this is a NanoBarrel-specific control node).
 *
 * So this effect needs no per-instance value logic: only the schema (so the 16
 * outputs are tappable) and a texture passthrough so the chain's image flows
 * through unchanged.
 */

#include <gpu.h>
#include <host.h>

#include <cstdio>

namespace barrel_macros {

constexpr int N_MACROS = 16;  // mirrors N_MACROS in nano_barrel_plugin.mm

struct State { bool initialized = false; };

// Type-level setup: schema only (no shaders/PSO). 16 float outputs +
// identity texture passthrough. SecondaryOutput keeps tex_out the primary.
void module_init() {
  state::Schema schema;
  schema.helpField("intro",
    "## Barrel Macros\n"
    "Surfaces **NanoBarrel's 16 macro knobs** as tappable float rails. Running "
    "inside Resolume (or ffgl_runner), the host injects the live knob values into "
    "`Macro 1..16`; write-tap any of them onto a rail to route a hardware/host "
    "macro anywhere in the sketch, then read-tap that rail into a parameter (add a "
    "Mix Mode to modulate rather than replace).\n\n"
    "**Note:** this is a NanoBarrel-specific control node — in the web IDE with no "
    "Resolume host the outputs read 0. The image passes through untouched.");
  for (int i = 0; i < N_MACROS; ++i) {
    char name[16];
    std::snprintf(name, sizeof(name), "macro_%d", i);
    schema.floatField(name, 0.0f, 0.0f, 1.0f, state::SecondaryOutput);
  }
  schema.textureField("tex_in",  state::PrimaryInput)
        .textureField("tex_out", state::PrimaryOutput)
        .capability(state::Capability::TimeIndependent);
  state::init("control.barrel_macros", {1, 0, 1}, schema);
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

} // namespace barrel_macros

// Registration is centralized: native via barrel_manifest.txt (the codegen calls
// registerEffect), web via the core bundle's nano_module_main (core/main.cpp).
// Like every other core effect, this file defines only the namespace.
