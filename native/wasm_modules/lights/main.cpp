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

namespace orthomod {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace bounce_resonator {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace side_jet {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace motion_blobs {
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

    nano::registerEffect({
        1,
        "gen.orthomod",
        "Orthomod",
        "Hadamard-driven beat-synced bar pattern. Two co-driven code systems share a global envelope: an 8x8 Hadamard sorted by row complexity drives 4 per-bar channel envelopes (square / sine / on / off waveforms per 2-bit code), while an MxM Hadamard grouped into pages of 4 rows drives the per-bar segment fill pattern. Triggers via the host bar clock. Exposes ch1..ch4 + env as float rails for downstream effects.",
        "lights",
        "atmosphere,hadamard,beat,pattern,bar,bed",
        orthomod::init,
        orthomod::tick,
        orthomod::render,
        orthomod::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "gen.bounce_resonator",
        "Bounce Resonator",
        "4 coupled per-bar mass-on-spring oscillators with seeded cross-bar diffusion and per-bar non-linear send filters. Trigger kicks one (or all) bars; energy bleeds into others via a randomized coupling matrix, each cross-send passing through a tanh-saturated biquad. Q knob ranges from heavy damping to long ring; top 5% engages soft-limited self-resonance. Renders as gaussian bands with motion-vector output.",
        "lights",
        "resonator,bounce,coupled,trigger,physics,bar",
        bounce_resonator::init,
        bounce_resonator::tick,
        bounce_resonator::render,
        bounce_resonator::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "gen.side_jet",
        "Side Jet",
        "JPL-style horizontal jet trail. Trigger spawns a procedural jet that traverses the canvas; the shape is a diverging cone with Mach-diamond pulsation along the axis and Fbm-modulated turbulent edges. Pool of up to 16 concurrent jets; direction selectable LtoR / RtoL / random. Emits motion vectors so a downstream video.motion_blur picks up the head naturally.",
        "lights",
        "jet,trail,plume,trigger,motion,bar",
        side_jet::init,
        side_jet::tick,
        side_jet::render,
        side_jet::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "gen.motion_blobs",
        "Motion Blobs",
        "Pool of traveling soft blobs that drive motion vectors AND/OR color darkening. motion_strength=1, shadow_darkness=0 is pure motion rain (invisible blobs feeding render_outputs/motion for a downstream video.motion_blur smear). motion_strength=0, shadow_darkness>0 is shadow flyover (dark sweeping shapes). Both at once gives moving shadows that also blur the underlying scene. Edge-spawning blobs traverse INTO the canvas with parallel drift; the field auto-tops up to density × blob_count_max alive.",
        "lights",
        "blobs,motion,shadow,flyover,rain,bar",
        motion_blobs::init,
        motion_blobs::tick,
        motion_blobs::render,
        motion_blobs::on_state_patched,
        nullptr,
    });
}

} // extern "C"
