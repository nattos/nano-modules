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
NANO_DECLARE_INSTANCE_EFFECT(brutal_fold)
NANO_DECLARE_INSTANCE_EFFECT(phase_fold)
NANO_DECLARE_INSTANCE_EFFECT(flow_swarm)
NANO_DECLARE_INSTANCE_EFFECT(spectral_lfo)
NANO_DECLARE_INSTANCE_EFFECT(mod_spectral)
NANO_DECLARE_INSTANCE_EFFECT(triangulate)
NANO_DECLARE_INSTANCE_EFFECT(plane_shear)
NANO_DECLARE_INSTANCE_EFFECT(tri_shear)
NANO_DECLARE_INSTANCE_EFFECT(shape_burst)
NANO_DECLARE_INSTANCE_EFFECT(simulant)

extern "C" {

NANO_EXPORT_ABI_VERSION()

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    nano::registerEffect({
        2,
        "control.nanolooper",
        "Nano Looper",
        "4-channel 16-step looper sequencer with visual overlay",
        "control",
        "loop,trigger,beat,midi",
        "la-redo",
        NANO_INSTANCE_LIFECYCLE(nanolooper),
    });

    nano::registerEffect({
        2,
        "motion.field",
        "Motion Field",
        "Per-pixel motion vector generator. Soft-thresholds the input by luma, then composes a velocity field from a static rotation, a radial outward direction, and the luma gradient (each weighted), with magnitude and angular jitter on top.",
        "motion",
        "motion,vectors,render-outputs,producer,luma,gradient",
        "la-arrows-alt",
        NANO_INSTANCE_LIFECYCLE(motion_field),
    });

    nano::registerEffect({
        2,
        "source.particles.flash_particles",
        "Flash Particles",
        "Mask-driven particle compositor. Spawns particles at bright spots in the (optional) mask texture, captures the input color at each spawn, and composites alpha-masked oriented quads (solid / squircle / gaussian) using a power-curve life decay with frame jitter. Emits motion vectors along each particle's rotation; chains via render_outputs_in.",
        "source",
        "particles,motion,vectors,render-outputs,producer,mask,jitter",
        "la-star",
        NANO_INSTANCE_LIFECYCLE(flash_particles),
    });

    nano::registerEffect({
        2,
        "motion.local_delay",
        "Local Delay",
        "Stylized motion-driven local delay. Keeps one frame of history, estimates a crude per-pixel flow, smooths it where locally colinear, then masks it by a stochastic-noise field and a signed center vignette. The masked magnitude is power-squashed into a blend weight that cross-fades current->history (moving/unmasked regions ghost toward the delayed frame) and modulates the motion vectors written on render_outputs/motion for a downstream motion blur to clean up.",
        "motion",
        "delay,echo,motion,vectors,flow,render-outputs,producer,stylized",
        "la-history",
        NANO_INSTANCE_LIFECYCLE(local_delay),
    });

    nano::registerEffect({
        2,
        "filter.height_from_gradient",
        "Height From Gradient",
        "Reconstructs a height field from a gradient field on the GPU. The gradient comes from one of several sources — Radial (outward from a center, magnitude = luma), Level Curves (treats the input as a contour map: the across-curve normal, sign-resolved by a global bias), or an existing vector field: Motion Vectors (the incoming render_outputs/motion), a Normal Map, or a Gradient Field. It takes the divergence and solves the Poisson equation laplacian(h)=div(g) with a coarse-to-fine multigrid (FMG-lite) cascade for the least-squares height. The field is generally non-conservative so there's no exact reconstruction, but the solve produces the best try. Visualizes the result as shaded hillshade relief, grayscale height, surface normals, or its own contour lines.",
        "filter",
        "height,gradient,poisson,reconstruction,relief,normals,multigrid,math",
        "la-mountain",
        NANO_INSTANCE_LIFECYCLE(height_from_gradient),
        nullptr, nullptr, nullptr, &height_from_gradient::eval_visibility,
    });

    nano::registerEffect({
        2,
        "source.shape_fold",
        "Shape Fold",
        "Evolving-shape generator. A baked 3D atlas of resolved shape parameters — axes frequency (x), simplicity (y), and temporal complexity (z) — is interpolated each frame down to a few terms and evaluated as a scalar SDF field on the GPU. An internal clock animates a seamless loop (with an easing/time-warp lever and a soft 'birth' gate for fading edges); an optional autopilot spirals the XY automatically and broadcasts its live position (autopilot_x/y) without mutating the inputs. The field is histogram auto-leveled (median→0) every frame, driven by an exposure, and output as grayscale or a colormap grade (magma/inferno/viridis/plasma/turbo) — the raw field, the square covering the viewport with a domain scale that reveals the periodic structure. Pure generator (no input).",
        "source",
        "generator,sdf,shape,evolving,autopilot,procedural,math",
        "la-shapes",
        NANO_INSTANCE_LIFECYCLE(shape_fold),
        nullptr, nullptr, nullptr, &shape_fold::eval_visibility,
    });

    nano::registerEffect({
        2,
        "source.brutal_fold",
        "Brutal Fold",
        "Brutalist axonometric-prism generator. A baked control surface — axes complexity (x), order (y), and liveliness (z), with a co-folded second structure — is interpolated each frame into an algebraic occupancy field, rendered as solid oblique-depth prisms (\"3D without a vanishing point\") in grayscale, with fog fading distant receding layers toward the light sky tone. The XY pad picks the cell; balance plays the two structures' parallax against each other; extrude sets the recession depth. A seamless bounded loop animates prisms birthing in and out (with an easing/time-warp lever); speeds map through a quadratic bend onto a low max, so it reads best very slow. An optional autopilot spirals the XY and broadcasts its live position (autopilot_x/y) without mutating the inputs. Pure generator (no input).",
        "source",
        "generator,brutalist,architecture,prisms,axonometric,fog,depth,volumetric,autopilot,procedural",
        "la-random",
        NANO_INSTANCE_LIFECYCLE(brutal_fold),
        nullptr, nullptr, nullptr, &brutal_fold::eval_visibility,
    });

    nano::registerEffect({
        2,
        "source.phase_fold",
        "Phase Fold",
        "Emergent limit-cycle phase-portrait generator. The XY pad picks a cell in a baked atlas of level-set limit-cycle fields (x = eccentricity, y = lobedness); the blended scalar field H is shown as a muted diverging height-field backdrop. Over it, the GPU traces streamlines through the induced vector field v = level-set flow + WIND(z) with arrowheads that animate down each line, and integrates the limit cycle itself from a seed on the resting orbit — both as separate, independently toggleable stages. Wind (z) is a non-potential force that distorts the cycle and, past a SNIC bifurcation, kills it (the orbit collapses to a fixed point); bias slides the cycle across contours. An optional autopilot spirals the XY and broadcasts its live position (autopilot_x/y) without mutating the inputs. Pure generator (no input).",
        "source",
        "generator,phase-portrait,limit-cycle,streamlines,flow,vector-field,autopilot,procedural,math",
        "la-project-diagram",
        NANO_INSTANCE_LIFECYCLE(phase_fold),
        nullptr, nullptr, nullptr, &phase_fold::eval_visibility,
    });

    nano::registerEffect({
        2,
        "source.particles.flow_swarm",
        "Flow Swarm",
        "Flow-field-driven GPU particle swarm. Consumes a flow_field rail (the canonical velocity texture produced by phase_fold or any flow generator / modifier) and advects a GPU-resident pool of up to a million particles along it: each particle chases the sampled field velocity with momentum (inertia), captures the input color where it spawns, and respawns at a fresh position when its lifetime expires or it drifts off-field. This separates field GENERATION from field RENDERING — drop a flow modifier between the generator and the swarm to reshape the motion. Particles rasterize as instanced soft quads (solid / circle / gaussian), additive or alpha-over, colored by the captured input blended with a tunable solid (optionally tinted by flow direction). With no flow wired the swarm still renders, drifting only by jitter.",
        "source",
        "particles,swarm,flow,vector-field,advection,gpu,instanced,generator,renderer",
        "la-atom",
        NANO_INSTANCE_LIFECYCLE(flow_swarm),
        nullptr, nullptr, nullptr, &flow_swarm::eval_visibility,
    });

    nano::registerEffect({
        2,
        "mod.source.spectral_lfo",
        "Spectral LFO",
        "Spectral-morph LFO generator. A baked atlas of ~2178 Serum LFO shapes is laid out per metric by a t-SNE embedding; the manifold position (morph_x, morph_y) selects the surrounding Delaunay triangle and the 3 nearest shapes are spectrally morphed (FFT -> barycentric blend -> IFFT -> geometric straighten) into one LFO curve. A phase accumulator advances at 'rate' (exponential -> Hz; 0 freezes) and samples the curve, publishing a scalar 'output' in [0,1] scaled by amplitude. The 'metric' selector re-lays-out the manifold; 'interpolation' off snaps to a single shape. An optional autopilot orbits the manifold and broadcasts its live position (autopilot_x/y). Pure data module (no GPU, no input).",
        "mod",
        "lfo,oscillator,modulation,automation,morph,spectral,generator",
        "la-signal",
        NANO_INSTANCE_LIFECYCLE(spectral_lfo),
        nullptr, nullptr, nullptr, &spectral_lfo::eval_visibility,
    });

    nano::registerEffect({
        2,
        "mod.shaper.spectral",
        "Spectral Curve",
        "Unary modulation shaper: builds the same spectrally-morphed LFO curve as mod.source.spectral_lfo (atlas of ~2178 Serum shapes, manifold position morph_x/morph_y + metric, FFT->barycentric blend->IFFT->geometric straighten), but indexes it by the 'input' modulation value instead of time. The morphed envelope becomes an arbitrary remapping curve. Pure data module.",
        "mod",
        "modulation,spectral,morph,remap,curve,shaper,envelope",
        "la-chart-area",
        NANO_INSTANCE_LIFECYCLE(mod_spectral),
    });

    nano::registerEffect({
        2,
        "filter.mesh.triangulate",
        "Triangulate",
        "Renders a Delaunay triangulation that follows the topology of an input's density — accentuating ridgelines first, then corners, then filling voids. Convolutions build ridge/corner/density feature maps from the input; a persistent seed pool is partitioned by a GPU Jump-Flood Voronoi pass and relaxed by stochastic confidence-gated takeover (seeds stay locked and only teleport when a candidate is a confidently better match — no continuous drift, no swim); Voronoi triple-points give the Delaunay edges, drawn as instanced line quads. Works on video frames or sparse point-cloud inputs alike.",
        "filter",
        "triangulation,delaunay,voronoi,mesh,topology,ridges,stippling,jfa,gpu,stylize",
        "la-draw-polygon",
        NANO_INSTANCE_LIFECYCLE(triangulate),
    });

    nano::registerEffect({
        2,
        "warp.plane_shear",
        "Plane Shear",
        "Analysis-driven shear / rift. Picks a \"natural\" dividing plane (a 2D line) from the input via one of four algorithms — Dominant Edge (global structure tensor), Strongest Edge (Hough), Low-energy Seam, or Content Centroid (PCA) — then shears the two halves on either side of it. Any algorithm can run at a fixed angle (it then only picks the position). The plane is stiff: held between updates and hard-snapped (never lerped) when it retargets at the configurable rate. Only the shear translation animates (CPU-timed one-shot hold / ping-pong / loop, with an optional retrigger on retarget). A signed direction morphs the per-half motion between rift (halves apart), overlap (halves together), and slip (halves sliding along the plane), with separate signed translation + multiplier per half. Rift gaps and overlaps each have selectable fills/blends.",
        "warp",
        "shear,rift,split,plane,slice,warp,analysis,structure-tensor,hough,seam,pca,glitch",
        "la-arrows-alt-h",
        NANO_INSTANCE_LIFECYCLE(plane_shear),
        nullptr, nullptr, nullptr, &plane_shear::eval_visibility,
    });

    nano::registerEffect({
        2,
        "warp.tri_shear",
        "Triangle Shear",
        "Three-plane triangle shear. Discovers THREE natural lines (strongest edges, or lowest-energy seams) biased to enclose a large triangle — a size param weights the large-area reward — then shears the image by chaining the single-plane shear three times, once per triangle edge. Like warp.plane_shear, the triangle is stiff (held then hard-snapped at the update rate) and only the shear translation animates (one-shot / ping-pong / loop, with a retrigger and a trigger-now button). Signed direction morphs each edge's motion between rift, overlap, and slip; rift gaps, border reveals, and overlaps each have selectable fills/blends (defaulting to black).",
        "warp",
        "shear,rift,triangle,tri,three,plane,split,slice,warp,glitch,hough,seam",
        "la-play",
        NANO_INSTANCE_LIFECYCLE(tri_shear),
    });

    nano::registerEffect({
        2,
        "source.shape_burst",
        "Shape Burst",
        "Triggered expanding-shape generator — an ADSR 'decay only' you can see. Each trigger fires a ring (circle / square / triangle) that grows from a min to a max scale over a duration, shaped by an easing curve, drawn hard-cut solid then gone; all bursts are concentric about a center pivot. Shares mod.source.adsr's trigger surface (auto_rate Poisson self-fire, a gate rising edge, a momentary trigger, plus voices + Reset/Legato/Poly retrigger for overlapping shockwaves). A manual 0..1 knob directly drives one highest-priority ring for a hands-free pulse (wire a modulation source into it). Composites over black, transparent, a custom colour, or the input.",
        "source",
        "generator,shape,burst,ring,circle,square,triangle,trigger,adsr,decay,shockwave,ripple,pulse",
        "la-bullseye",
        NANO_INSTANCE_LIFECYCLE(shape_burst),
    });

    nano::registerEffect({
        2,
        "filter.sim.simulant",
        "Simulant",
        "A faithful re-creation of the original Resolume Wire 'Simulant' patch (quirks intact). NOT a wave equation and NOT a zoom-feedback drift — it is a DIFFERENCE-BLEND + BLUR-DIFFUSION feedback loop: each frame the image is differenced (abs(A-B), which never goes pure black — the load-bearing Simulant/Pixulant quirk) against a blurred copy of the previous frame, and that blur is the outward propagation. The churning accumulator is traced into Sobel lines (Levels → posterize → edge → crop). A Poisson flicker + manual trigger pulse an Attack/Release envelope into the injection. FAITHFUL QUIRK: with stock knobs the envelope is SUBTRACTED and Flicker Min/Max = 0, so a fresh drop just decays — bring it alive with Const Alpha, Flicker Max, or Flicker Invert. Wave Speed / Choke shape the medium; Levels / Line Strength / Line Width shape the lines.",
        "filter",
        "simulant,feedback,difference,blur,diffusion,reaction,lines,edge,sobel,flicker,contour,growth,resolume,wire",
        "la-water",
        NANO_INSTANCE_LIFECYCLE(simulant),
    });
}

} // extern "C"
