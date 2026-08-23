/*
 * mod.source.color — a colour as a wire source.
 *
 * One RGB swatch, declared as BOTH an input and an output (io = in|out|primary,
 * the `util.dashboard` knob pattern). As an input it is the value you pick on
 * the card; as an output it is write-tapped onto a vec rail and carried to
 * whatever you wired it to. The effect holds no per-instance logic at all — the
 * standard executor tap path does the work — so this file is schema plus
 * lifecycle.
 *
 * It exists because colour became wireable and nothing produced one: every
 * vec/rgb field in the tree is an INPUT, so a colour wire had no source to
 * start from. Three of these into a switch is how you pick between palettes.
 *
 * Wiring it into any `rgbField` consumer (solid_color's `color`, a gradient
 * stop, a tint) hands the components over WHOLE — vec rails carry the value
 * without a per-component fold, because a colour has no [min,max] modulation
 * contract to map into.
 *
 * Pure data module — no GPU, no texture I/O.
 */

#include <host.h>

namespace color_const {

void module_init() {
  state::init("mod.source.color", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Colour\n"
        "A colour you can **wire**. Pick a swatch here and route it into any "
        "colour parameter — a fill, a tint, a gradient stop.\n\n"
        "On its own it just holds a colour. Its point is what you put in "
        "between: wire several through a *Switch* to flip palettes, or drive "
        "the swatch itself from another colour source and shape it on the "
        "way.\n\n"
        "**Try:** two of these into a Switch, the Switch into a *Solid Colour* "
        "— then wire a beat trigger at the Switch's selector.")
      // Relay field: an INPUT (the swatch you edit) and an OUTPUT (the value
      // the wire carries) at once. The executor publishes the modulated value
      // when something is wired INTO it, so this also works as a pass-through
      // for another colour source.
      .rgbField("color", 1.0f, 1.0f, 1.0f,
                state::Input | state::Output | state::Primary)
        .label("Colour", "Col")
      .capability(state::Capability::TimeIndependent)
  );
}

void* create() { return nullptr; }              // no per-instance state
void destroy(void* self) { (void)self; }
void init(void* self) { (void)self; }
void tick(void* self, double dt) { (void)self; (void)dt; }
void render(void* self, int vp_w, int vp_h) { (void)self; (void)vp_w; (void)vp_h; }

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  // The swatch lives in instance state and is read from there by the write tap;
  // nothing to mirror here.
  (void)self; (void)n; (void)pb; (void)off; (void)len; (void)ops;
}

}  // namespace color_const
