/*
 * lights — LED-bar show effects bundle.
 *
 * All effects for the 4-bar performance live here. See
 * SHOW_EFFECTS_PLAN.md at the repo root for the design.
 *
 * Bundle ID:  com.nano.lights
 * Effect IDs: gen.*  (generators), fx.*  (post-process complicators)
 */

#include <module_api.h>
#include <cstddef>

namespace strobe_channel {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace soft_glow {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace dispersion {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace plasma_beam_cannon {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

extern "C" {

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    nano::registerEffect({
        1,
        "gen.strobe_channel",
        "Strobe Channel",
        "Logistic-map-driven single-bar selector. A smooth ping-pong seed value is iterated through the chaotic logistic map; the final value selects which bar lights up. Cranking r toward 4 gives maximum chaos / rapid strobe-like switching.",
        "lights",
        "strobe,chaos,logistic-map,bar,trigger",
        strobe_channel::init,
        strobe_channel::tick,
        strobe_channel::render,
        strobe_channel::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "gen.soft_glow",
        "Soft Glow",
        "Continuous warm-blob atmosphere bed. Slowly-drifting gaussian blobs across the bars accumulate into a hue-shifting blackbody-ish color ramp. Designed to sit underneath everything as the show's ambient layer.",
        "lights",
        "atmosphere,glow,blobs,bed,warm",
        soft_glow::init,
        soft_glow::tick,
        soft_glow::render,
        soft_glow::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "fx.dispersion",
        "Dispersion",
        "Block-quantized UV-jitter sampler. Tiles the canvas into discrete blocks (size quantized internally to avoid sweeping boundaries), picks a stable random offset per block, samples the input at (block_center + offset). Small blocks → crunchy grain; large blocks → mosaic downres.",
        "lights",
        "dispersion,grain,mosaic,glitch,jitter",
        dispersion::init,
        dispersion::tick,
        dispersion::render,
        dispersion::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "gen.plasma_beam_cannon",
        "Plasma Beam Cannon",
        "90s-anime power-up beam. Attack seed snaps small at a target Y, decay rapidly expands to fill the bar, sustain holds, release breaks up (break particles deferred for v2). All four bars share one linked ADSR timeline.",
        "lights",
        "plasma,beam,cannon,trigger,adsr,drama",
        plasma_beam_cannon::init,
        plasma_beam_cannon::tick,
        plasma_beam_cannon::render,
        plasma_beam_cannon::on_state_patched,
        nullptr,
    });
}

} // extern "C"
