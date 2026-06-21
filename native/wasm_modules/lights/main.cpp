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

// All effects are converted to the class-like per-instance ABI.
NANO_DECLARE_INSTANCE_EFFECT(strobe_channel)
NANO_DECLARE_INSTANCE_EFFECT(soft_glow)
NANO_DECLARE_INSTANCE_EFFECT(dispersion)
NANO_DECLARE_INSTANCE_EFFECT(plasma_beam_cannon)
NANO_DECLARE_INSTANCE_EFFECT(orthomod)
NANO_DECLARE_INSTANCE_EFFECT(bounce_resonator)
NANO_DECLARE_INSTANCE_EFFECT(side_jet)
NANO_DECLARE_INSTANCE_EFFECT(motion_blobs)
NANO_DECLARE_INSTANCE_EFFECT(lights_sim)
NANO_DECLARE_INSTANCE_EFFECT(block_dehance)
NANO_DECLARE_INSTANCE_EFFECT(tingle_top)
NANO_DECLARE_INSTANCE_EFFECT(chroma_wave)

extern "C" {

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    nano::registerEffect({
        2,
        "source.light.strobe_channel",
        "Strobe Channel",
        "Logistic-map-driven single-bar selector. A smooth ping-pong seed value is iterated through the chaotic logistic map; the final value selects which bar lights up. Cranking r toward 4 gives maximum chaos / rapid strobe-like switching.",
        "source",
        "strobe,chaos,logistic-map,bar,trigger",
        NANO_INSTANCE_LIFECYCLE(strobe_channel),
    });

    nano::registerEffect({
        2,
        "source.light.soft_glow",
        "Soft Glow",
        "Continuous warm-blob atmosphere bed. Slowly-drifting gaussian blobs across the bars accumulate into a hue-shifting blackbody-ish color ramp. Designed to sit underneath everything as the show's ambient layer.",
        "source",
        "atmosphere,glow,blobs,bed,warm",
        NANO_INSTANCE_LIFECYCLE(soft_glow),
    });

    nano::registerEffect({
        2,
        "warp.dispersion",
        "Dispersion",
        "Block-quantized UV-jitter sampler. Tiles the canvas into discrete blocks (size quantized internally to avoid sweeping boundaries), picks a stable random offset per block, samples the input at (block_center + offset). Small blocks → crunchy grain; large blocks → mosaic downres.",
        "warp",
        "dispersion,grain,mosaic,glitch,jitter",
        NANO_INSTANCE_LIFECYCLE(dispersion),
    });

    nano::registerEffect({
        2,
        "source.light.plasma_beam_cannon",
        "Plasma Beam Cannon",
        "90s-anime power-up beam. Attack seed snaps small at a target Y, decay rapidly expands to fill the bar, sustain holds, release breaks up (break particles deferred for v2). All four bars share one linked ADSR timeline.",
        "source",
        "plasma,beam,cannon,trigger,adsr,drama",
        NANO_INSTANCE_LIFECYCLE(plasma_beam_cannon),
    });

    nano::registerEffect({
        2,
        "source.light.orthomod",
        "Orthomod",
        "Hadamard-driven beat-synced bar pattern. Two co-driven code systems share a global envelope: an 8x8 Hadamard sorted by row complexity drives 4 per-bar channel envelopes (square / sine / on / off waveforms per 2-bit code), while an MxM Hadamard grouped into pages of 4 rows drives the per-bar segment fill pattern. Triggers via the host bar clock. Exposes ch1..ch4 + env as float rails for downstream effects.",
        "source",
        "atmosphere,hadamard,beat,pattern,bar,bed",
        NANO_INSTANCE_LIFECYCLE(orthomod),
    });

    nano::registerEffect({
        2,
        "source.light.bounce_resonator",
        "Bounce Resonator",
        "4 coupled per-bar mass-on-spring oscillators with seeded cross-bar diffusion and per-bar non-linear send filters. Trigger kicks one (or all) bars; energy bleeds into others via a randomized coupling matrix, each cross-send passing through a tanh-saturated biquad. Q knob ranges from heavy damping to long ring; top 5% engages soft-limited self-resonance. Renders as gaussian bands with motion-vector output.",
        "source",
        "resonator,bounce,coupled,trigger,physics,bar",
        NANO_INSTANCE_LIFECYCLE(bounce_resonator),
    });

    nano::registerEffect({
        2,
        "source.light.side_jet",
        "Side Jet",
        "JPL-style horizontal jet trail. Trigger spawns a procedural jet that traverses the canvas; the shape is a diverging cone with Mach-diamond pulsation along the axis and Fbm-modulated turbulent edges. Pool of up to 16 concurrent jets; direction selectable LtoR / RtoL / random. Emits motion vectors so a downstream motion.blur picks up the head naturally.",
        "source",
        "jet,trail,plume,trigger,motion,bar",
        NANO_INSTANCE_LIFECYCLE(side_jet),
    });

    nano::registerEffect({
        2,
        "source.light.motion_blobs",
        "Motion Blobs",
        "Pool of traveling soft blobs that drive motion vectors AND/OR color darkening. motion_strength=1, shadow_darkness=0 is pure motion rain (invisible blobs feeding render_outputs/motion for a downstream motion.blur smear). motion_strength=0, shadow_darkness>0 is shadow flyover (dark sweeping shapes). Both at once gives moving shadows that also blur the underlying scene. Edge-spawning blobs traverse INTO the canvas with parallel drift; the field auto-tops up to density × blob_count_max alive.",
        "source",
        "blobs,motion,shadow,flyover,rain,bar",
        NANO_INSTANCE_LIFECYCLE(motion_blobs),
    });

    nano::registerEffect({
        2,
        "filter.lights_sim",
        "Lights Sim",
        "Samples the input into 4 vertical LED bars (Resolume-style fixture sampling). Each quarter of the input is one bar, divided into `segments` LED segments; a segment's colour is sampled at the horizontal centre of its quarter and the vertical centre of its segment. The bars render inset into their quarters (separate horizontal / vertical inset) over the input faded by input_opacity.",
        "filter",
        "led,bar,sample,resolume,fixture,segments",
        NANO_INSTANCE_LIFECYCLE(lights_sim),
    });

    nano::registerEffect({
        2,
        "filter.glitch.block_dehance",
        "Block Dehance",
        "Glitch rectangles that 'dehance' the input in one of three modes — black-fill (dropout), mosaic downres, or noise — sampled probabilistically per rect at spawn, so one instance mixes all three. A GPU rect pool cycles continuously; each rect bright-seeks the mask for its position. Weights control the mode mix; optional per-rect hard-duty flicker for the aggressive glitch feel.",
        "filter",
        "glitch,dropout,mosaic,noise,dehance,block",
        NANO_INSTANCE_LIFECYCLE(block_dehance),
    });

    nano::registerEffect({
        2,
        "source.light.tingle_top",
        "Tingle Top",
        "Sparkles bundled at the top of each bar while gated, released downward on an envelope when ungated. Particles live and die in place; the cascade is a spawn-region animation (region_y_max snaps to a thin top band while held, ramps to full bar on release). Single hue + jitter, per-frame alpha shimmer. Optional per-particle velocity unlocks the downward-sparkle fountain preset.",
        "source",
        "sparkle,tingle,particles,cut-in,trigger,bar",
        NANO_INSTANCE_LIFECYCLE(tingle_top),
    });

    nano::registerEffect({
        2,
        "source.light.chroma_wave",
        "Chroma Wave",
        "Charge-and-burst prismatic wave bloom. A soft super-gaussian blob grows from the top-center while gated; as pressure builds the top flattens into a plateau, the blob elongates in X and hollows out at the top so the mass piles into a downward crescent (max pressure). On release it bursts — rapidly expanding while the colour-grade transfer folds, sending prismatic bands travelling down the density gradient (dominant) and washing back up the inner edge (secondary). Additive bloom composited over the input.",
        "source",
        "chroma,prismatic,wave,bloom,trigger,charge,burst",
        NANO_INSTANCE_LIFECYCLE(chroma_wave),
    });
}

} // extern "C"
