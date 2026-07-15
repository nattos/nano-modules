/*
 * testonly — Effects bundle used by integration tests.
 *
 * NOT loaded by the Effect IDE. This bundle exists so the test suite has a
 * single, stable place to load all effects exercised by integration tests
 * (engine.test.ts, engine-rails.test.ts, particles.test.ts, etc.).
 *
 * It can freely duplicate effects that also appear in the `core` or `nano`
 * bundles. In the future, when test assertions need pixel-stable
 * implementations that may diverge from the shipping ones, this is the
 * place to fork (a copy whose math is locked to the values our golden
 * masters were computed against).
 *
 * Per-effect e2e tests should load whichever bundle their effect actually
 * lives in, not this one — those tests are part of the effect's
 * implementation, not the common test infrastructure.
 */

#include <module_api.h>
#include <cstddef>

// ---- Effects that also exist in core (duplicated here for test access) ----

NANO_DECLARE_INSTANCE_EFFECT(brightness_contrast)
// Identity-skip predicate (same source as core). testonly loads after core
// and wins the editor's last-registered-wins override, so it must wire this
// too or the editor's brightness_contrast loses identity-skip.
namespace brightness_contrast { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(solid_color)

NANO_DECLARE_INSTANCE_EFFECT(video_blend)
NANO_DECLARE_INSTANCE_EFFECT(video_layer)

// mod.source.lfo and mod.source.adsr ship in core — duplicated here for test access.
NANO_DECLARE_INSTANCE_EFFECT(env_lfo)
NANO_DECLARE_INSTANCE_EFFECT(env_adsr)

// ---- Test-only effects (never shipped) ----

// Fusion-aware mappers used to verify multi-stage fusion. Predictable
// math (clamp(rgb + offset), clamp(rgb * scale)) so byte-exact
// comparisons across standalone and fused paths hold.
NANO_DECLARE_INSTANCE_EFFECT(fuse_add)

NANO_DECLARE_INSTANCE_EFFECT(fuse_mul)

NANO_DECLARE_INSTANCE_EFFECT(fuse_solid)

NANO_DECLARE_INSTANCE_EFFECT(mod_remap)
NANO_DECLARE_INSTANCE_EFFECT(mod_combine)

NANO_DECLARE_INSTANCE_EFFECT(mod_flip)

NANO_DECLARE_INSTANCE_EFFECT(mod_time)

NANO_DECLARE_INSTANCE_EFFECT(mod_smooth)

NANO_DECLARE_INSTANCE_EFFECT(mod_motion)

NANO_DECLARE_INSTANCE_EFFECT(mod_delay)

NANO_DECLARE_INSTANCE_EFFECT(mod_envelope)

NANO_DECLARE_INSTANCE_EFFECT(gpu_test)

NANO_DECLARE_INSTANCE_EFFECT(spinningtris)

NANO_DECLARE_INSTANCE_EFFECT(particles_emitter)

NANO_DECLARE_INSTANCE_EFFECT(particles_renderer)

// Platform-feature smoke effects — each one exercises a single GPU-host
// capability so the integration tests can detect regressions in the
// platform layer (texture formats, atomics, RW textures, MRT, copy/clear,
// 3D textures). Not user-facing.
NANO_DECLARE_INSTANCE_EFFECT(hdr_test)

NANO_DECLARE_INSTANCE_EFFECT(atomic_test)

NANO_DECLARE_INSTANCE_EFFECT(rw_storage_test)

NANO_DECLARE_INSTANCE_EFFECT(clear_copy_test)

NANO_DECLARE_INSTANCE_EFFECT(mrt_test)

NANO_DECLARE_INSTANCE_EFFECT(lut3d_test)

NANO_DECLARE_INSTANCE_EFFECT(motion_rect)

NANO_DECLARE_INSTANCE_EFFECT(motion_swarm)

NANO_DECLARE_INSTANCE_EFFECT(motion_static)

// Deliberately traps in module_init — verifies aux-stack trap containment.
NANO_DECLARE_INSTANCE_EFFECT(trap_test)

NANO_DECLARE_INSTANCE_EFFECT(motion_blur)

extern "C" {

NANO_EXPORT_ABI_VERSION()

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    // Duplicates of core effects — same source, registered separately so
    // tests don't have to load `core` to exercise them.
    nano::registerEffect({
        2,
        "color.tone.brightness_contrast",
        "Brightness & Contrast",
        "Adjusts brightness and contrast of a texture input",
        "color",
        "color,adjust,filter",
        "la-adjust",
        NANO_INSTANCE_LIFECYCLE(brightness_contrast),
        &brightness_contrast::is_identity,
    });

    nano::registerEffect({
        2,
        "source.solid_color",
        "Solid Color",
        "Fills the render target with a uniform RGB color",
        "source",
        "color,fill",
        "la-square-full",
        NANO_INSTANCE_LIFECYCLE(solid_color),
    });

    nano::registerEffect({
        2,
        "composite.blend",
        "Blend",
        "A/B crossfader with a blend-mode transition flavor",
        "composite",
        "blend,mix,composite,opacity",
        "la-layer-group",
        NANO_INSTANCE_LIFECYCLE(video_blend),
    });

    nano::registerEffect({
        2,
        "composite.layer",
        "Layer",
        "Lays B over A with a blend mode — full-strength blend at opacity 1",
        "composite",
        "blend,layer,mix,composite,opacity,multiply,screen",
        "la-layer-group",
        NANO_INSTANCE_LIFECYCLE(video_layer),
    });

    // Test-only fusion mappers (predictable per-pixel math for
    // multi-stage fusion parity tests).
    nano::registerEffect({
        2,
        "debug.fuse_add",
        "Fuse Add",
        "Adds an RGB offset and clamps. Test-only fusion mapper.",
        "debug",
        "test,fusion,mapper",
        "la-plus",
        NANO_INSTANCE_LIFECYCLE(fuse_add),
    });

    nano::registerEffect({
        2,
        "debug.fuse_mul",
        "Fuse Mul",
        "Multiplies RGB by a uniform scale and clamps. Test-only fusion mapper.",
        "debug",
        "test,fusion,mapper",
        "la-times",
        NANO_INSTANCE_LIFECYCLE(fuse_mul),
    });

    nano::registerEffect({
        2,
        "debug.fuse_solid",
        "Fuse Solid",
        "Writes a uniform color to every pixel. Test-only strict-output generator.",
        "debug",
        "test,fusion,strict-output,generator",
        "la-square-full",
        NANO_INSTANCE_LIFECYCLE(fuse_solid),
    });

    // mod.source.lfo / mod.source.adsr ship in core, duplicated for test access, same
    // source as the shipping bundle.
    nano::registerEffect({
        2,
        "mod.source.lfo",
        "LFO",
        "Low frequency oscillator outputting a sine wave",
        "mod",
        "oscillator,modulation,automation",
        "la-wave-square",
        NANO_INSTANCE_LIFECYCLE(env_lfo),
        nullptr, nullptr, nullptr, &env_lfo::eval_visibility,
    });

    nano::registerEffect({
        2,
        "mod.source.adsr",
        "ADSR",
        "ADSR envelope generator modulation source",
        "mod",
        "envelope,adsr,modulation,automation,trigger,generator",
        "la-chart-line",
        NANO_INSTANCE_LIFECYCLE(env_adsr),
        nullptr, nullptr, nullptr, &env_adsr::eval_visibility,
    });

    nano::registerEffect({
        2,
        "mod.shaper.remap",
        "Remap",
        "Unary modulation shaper: range-remaps a modulation value (wire-identical remap)",
        "mod",
        "modulation,remap,shaper,curve,range,envelope",
        "la-exchange-alt",
        NANO_INSTANCE_LIFECYCLE(mod_remap),
    });

    nano::registerEffect({
        2,
        "mod.shaper.combine",
        "Combine",
        "Binary modulation shaper: combines two modulation signals with a selectable math op",
        "mod",
        "modulation,combine,math,binary,add,multiply,mix,shaper",
        "la-calculator",
        NANO_INSTANCE_LIFECYCLE(mod_combine),
    });

    nano::registerEffect({
        2,
        "mod.shaper.flip",
        "Flip",
        "Trigger-flipped latch with pickup takeover (MIDI-fader soft-takeover as a modulation shaper)",
        "mod",
        "modulation,flip,toggle,latch,takeover,pickup,trigger,shaper",
        "la-toggle-on",
        NANO_INSTANCE_LIFECYCLE(mod_flip),
    });

    nano::registerEffect({
        2,
        "mod.source.time",
        "Time",
        "Transport time/beat-phase modulation source: looping phase fraction + raw beats/seconds value",
        "mod",
        "modulation,time,beats,clock,phase,loop,transport,bpm,source",
        "la-clock",
        NANO_INSTANCE_LIFECYCLE(mod_time),
        nullptr, nullptr, nullptr, &mod_time::eval_visibility,
    });

    nano::registerEffect({
        2,
        "mod.shaper.smooth",
        "Smooth",
        "Unary modulation shaper: linear smoothing over a duration (wire-identical smoothing)",
        "mod",
        "modulation,smooth,slew,ramp,glide,shaper,filter",
        "la-stream",
        NANO_INSTANCE_LIFECYCLE(mod_smooth),
    });

    nano::registerEffect({
        2,
        "mod.shaper.motion",
        "Motion",
        "Unary modulation shaper: normalized differentiator (motion speed) with catch-fast/coast-slow momentum and an optional Activity/Throw integrator",
        "mod",
        "modulation,motion,velocity,speed,differentiator,derivative,momentum,inertia,coast,throw,fling,activity,shaper",
        "la-tachometer-alt",
        NANO_INSTANCE_LIFECYCLE(mod_motion),
        nullptr,            // is_identity
        nullptr,            // on_active
        nullptr,            // seek
        &mod_motion::eval_visibility,  // static visibility evaluator (integrate/mode gating)
    });

    nano::registerEffect({
        2,
        "mod.shaper.delay",
        "Delay",
        "Unary modulation shaper: delays a modulation signal by a parameterized time (delay line)",
        "mod",
        "modulation,delay,line,echo,offset,lag,shaper",
        "la-clock",
        NANO_INSTANCE_LIFECYCLE(mod_delay),
    });

    nano::registerEffect({
        2,
        "mod.shaper.envelope",
        "Envelope",
        "Unary modulation shaper: remaps a modulation value through a drawn envelope curve",
        "mod",
        "modulation,envelope,remap,curve,shaper,draw,easing",
        "la-drafting-compass",
        NANO_INSTANCE_LIFECYCLE(mod_envelope),
    });

    nano::registerEffect({
        2,
        "debug.gpu_test",
        "GPU Test",
        "GPU pipeline test rendering a solid color",
        "debug",
        "test,gpu,pipeline",
        "la-microchip",
        NANO_INSTANCE_LIFECYCLE(gpu_test),
    });

    nano::registerEffect({
        2,
        "debug.spinningtris",
        "Spinning Triangles",
        "Animated spinning triangles GPU demo",
        "debug",
        "demo,triangles,animation,generative",
        "la-shapes",
        NANO_INSTANCE_LIFECYCLE(spinningtris),
    });

    nano::registerEffect({
        2,
        "debug.particles_emitter",
        "Particles Emitter",
        "Emits a stream of 2D particles into a GPU storage buffer",
        "debug",
        "particles,gpu,emit,physics",
        "la-star",
        NANO_INSTANCE_LIFECYCLE(particles_emitter),
    });

    nano::registerEffect({
        2,
        "debug.particles_renderer",
        "Particles Renderer",
        "Renders quads for each particle in an input GPU buffer",
        "debug",
        "particles,gpu,quads,instanced",
        "la-braille",
        NANO_INSTANCE_LIFECYCLE(particles_renderer),
    });

    // --- Platform-feature smoke effects ---

    nano::registerEffect({
        2,
        "debug.hdr_test",
        "HDR Round Trip",
        "Verifies rgba16float storage textures via a 4x → 0.25x round trip",
        "debug",
        "test,hdr,float,texture-format",
        "la-sun",
        NANO_INSTANCE_LIFECYCLE(hdr_test),
    });

    nano::registerEffect({
        2,
        "debug.atomic_test",
        "Atomic Histogram",
        "Verifies atomic InterlockedAdd into a storage buffer via per-pixel histogram",
        "debug",
        "test,atomic,storage-buffer,histogram",
        "la-chart-bar",
        NANO_INSTANCE_LIFECYCLE(atomic_test),
    });

    nano::registerEffect({
        2,
        "debug.rw_storage_test",
        "RW Storage",
        "Verifies read_write access on r32float storage textures via in-place RMW",
        "debug",
        "test,rw,storage-texture,r32float",
        "la-database",
        NANO_INSTANCE_LIFECYCLE(rw_storage_test),
    });

    nano::registerEffect({
        2,
        "debug.clear_copy_test",
        "Clear + Copy",
        "Verifies gpu::Device::clear and gpu::Device::copy via clear-then-copy round trip",
        "debug",
        "test,clear,copy,texture",
        "la-copy",
        NANO_INSTANCE_LIFECYCLE(clear_copy_test),
    });

    nano::registerEffect({
        2,
        "debug.mrt_test",
        "Multi-Render Target",
        "Verifies multi-target render passes via fragment shader writing two color attachments",
        "debug",
        "test,mrt,render-target,fragment",
        "la-th-large",
        NANO_INSTANCE_LIFECYCLE(mrt_test),
    });

    nano::registerEffect({
        2,
        "debug.lut3d_test",
        "3D LUT",
        "Verifies 3D textures via an identity 16x16x16 color LUT",
        "debug",
        "test,3d,lut,texture-3d",
        "la-cube",
        NANO_INSTANCE_LIFECYCLE(lut3d_test),
    });

    nano::registerEffect({
        2,
        "debug.motion_rect",
        "Motion Rect",
        "Test producer for the canonical RenderOutputs rail. Overlays a moving colored rectangle and writes per-pixel velocity vectors.",
        "debug",
        "test,motion,render-outputs,producer",
        "la-vector-square",
        NANO_INSTANCE_LIFECYCLE(motion_rect),
    });

    nano::registerEffect({
        2,
        "debug.motion_swarm",
        "Motion Swarm",
        "A swarm of randomly-coloured rectangles curling around the viewport center, each emitting its own velocity into render_outputs/motion. Test producer for non-uniform motion fields.",
        "debug",
        "test,motion,render-outputs,producer,swarm,curl",
        "la-bug",
        NANO_INSTANCE_LIFECYCLE(motion_swarm),
    });

    nano::registerEffect({
        2,
        "debug.motion_static",
        "Motion Static",
        "Per-pixel thresholded-noise motion field rotating around the viewport center. Stress test for fine-grained motion blur input. Opacity overlays an HSV-polar visualization of the motion vectors.",
        "debug",
        "test,motion,render-outputs,producer,noise,static",
        "la-image",
        NANO_INSTANCE_LIFECYCLE(motion_static),
    });

    nano::registerEffect({
        2,
        "motion.blur",
        "Motion Blur",
        "Per-pixel motion blur driven by a RenderOutputs motion-vector rail. Falls back to pass-through when no motion is bound.",
        "motion",
        "blur,motion,velocity,render-outputs",
        "la-running",
        NANO_INSTANCE_LIFECYCLE(motion_blur),
        nullptr, nullptr, nullptr, &motion_blur::eval_visibility,
    });

    // Registered LAST: trap_test's module_init deliberately traps. A trapped
    // module_init can't be contained (it poisons the shared bundle instance's C
    // stack), so it must come after every real effect — nothing is registered
    // after it to be poisoned. The host logs the trap loudly and flags it
    // (EffectInstance::moduleInitTrapped); the paired test asserts that flag.
    // See trap_test/main.cpp.
    nano::registerEffect({
        2,
        "debug.trap_test",
        "Trap Test",
        "Test-only effect whose module_init deliberately traps (trap-reporting check).",
        "debug",
        "test,trap,internal",
        "la-exclamation-triangle",
        NANO_INSTANCE_LIFECYCLE(trap_test),
    });
}

} // extern "C"
