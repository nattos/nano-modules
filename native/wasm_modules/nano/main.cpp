/*
 * nano — "Weirder" effects bundle.
 *
 * Sibling to `core` for effects that aren't quite the standard
 * brightness/blend/etc. flavour but are still part of the shipping
 * product. The Effect IDE loads this bundle alongside `core`.
 *
 * Today: just `nanolooper`. Future weird/experimental-but-shipping
 * effects land here.
 */

#include <module_api.h>
#include <cstddef>

NANO_DECLARE_INSTANCE_EFFECT(nanolooper)
NANO_DECLARE_INSTANCE_EFFECT(motion_field)
NANO_DECLARE_INSTANCE_EFFECT(flash_particles)
NANO_DECLARE_INSTANCE_EFFECT(local_delay)

extern "C" {

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    nano::registerEffect({
        2,
        "sequencer.nanolooper",
        "Nano Looper",
        "4-channel 16-step looper sequencer with visual overlay",
        "sequencer",
        "loop,trigger,beat,midi",
        NANO_INSTANCE_LIFECYCLE(nanolooper),
    });

    nano::registerEffect({
        2,
        "video.motion_field",
        "Motion Field",
        "Per-pixel motion vector generator. Soft-thresholds the input by luma, then composes a velocity field from a static rotation, a radial outward direction, and the luma gradient (each weighted), with magnitude and angular jitter on top.",
        "video",
        "motion,vectors,render-outputs,producer,luma,gradient",
        NANO_INSTANCE_LIFECYCLE(motion_field),
    });

    nano::registerEffect({
        2,
        "video.flash_particles",
        "Flash Particles",
        "Mask-driven particle compositor. Spawns particles at bright spots in the (optional) mask texture, captures the input color at each spawn, and composites alpha-masked oriented quads (solid / squircle / gaussian) using a power-curve life decay with frame jitter. Emits motion vectors along each particle's rotation; chains via render_outputs_in.",
        "video",
        "particles,motion,vectors,render-outputs,producer,mask,jitter",
        NANO_INSTANCE_LIFECYCLE(flash_particles),
    });

    nano::registerEffect({
        2,
        "video.local_delay",
        "Local Delay",
        "Stylized motion-driven local delay. Keeps one frame of history, estimates a crude per-pixel flow, smooths it where locally colinear, then masks it by a stochastic-noise field and a signed center vignette. The masked magnitude is power-squashed into a blend weight that cross-fades current->history (moving/unmasked regions ghost toward the delayed frame) and modulates the motion vectors written on render_outputs/motion for a downstream motion blur to clean up.",
        "video",
        "delay,echo,motion,vectors,flow,render-outputs,producer,stylized",
        NANO_INSTANCE_LIFECYCLE(local_delay),
    });
}

} // extern "C"
