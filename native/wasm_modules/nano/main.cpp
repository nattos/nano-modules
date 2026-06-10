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
NANO_DECLARE_INSTANCE_EFFECT(height_from_gradient)
NANO_DECLARE_INSTANCE_EFFECT(shape_fold)

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

    nano::registerEffect({
        2,
        "video.height_from_gradient",
        "Height From Gradient",
        "Reconstructs a height field from a gradient field on the GPU. The gradient comes from one of several sources — Radial (outward from a center, magnitude = luma), Level Curves (treats the input as a contour map: the across-curve normal, sign-resolved by a global bias), or an existing vector field: Motion Vectors (the incoming render_outputs/motion), a Normal Map, or a Gradient Field. It takes the divergence and solves the Poisson equation laplacian(h)=div(g) with a coarse-to-fine multigrid (FMG-lite) cascade for the least-squares height. The field is generally non-conservative so there's no exact reconstruction, but the solve produces the best try. Visualizes the result as shaded hillshade relief, grayscale height, surface normals, or its own contour lines.",
        "video",
        "height,gradient,poisson,reconstruction,relief,normals,multigrid,math",
        NANO_INSTANCE_LIFECYCLE(height_from_gradient),
    });

    nano::registerEffect({
        2,
        "video.shape_fold",
        "Shape Fold",
        "Evolving-shape generator. A baked 3D atlas of resolved shape parameters — axes frequency (x), simplicity (y), and temporal complexity (z) — is interpolated each frame down to a few terms and evaluated as a scalar SDF field on the GPU. An internal clock animates a seamless loop (with an easing/time-warp lever and a soft 'birth' gate for fading edges); an optional autopilot spirals the XY automatically and broadcasts its live position (autopilot_x/y) without mutating the inputs. The field is histogram auto-leveled (median→0) every frame and output as grayscale or magma — the raw field, the square covering the viewport with a domain scale that reveals the periodic structure. Pure generator (no input).",
        "video",
        "generator,sdf,shape,evolving,autopilot,procedural,math",
        NANO_INSTANCE_LIFECYCLE(shape_fold),
    });
}

} // extern "C"
