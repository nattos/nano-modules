/*
 * core — Production-ready effect bundle.
 *
 * Effects in this bundle are the ones we are committed to as part of the
 * shipping product: their parameter shape, output, and behaviour are
 * stable. The Effect IDE loads this bundle by default.
 *
 * To add a new effect: drop the source under wasm_modules/<name>/, add a
 * forward declaration + registerEffect call below, and reference its
 * sources from build.sh.
 */

#include <module_api.h>
#include <cstddef>

NANO_DECLARE_INSTANCE_EFFECT(brightness_contrast)
namespace brightness_contrast { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(solid_color)

NANO_DECLARE_INSTANCE_EFFECT(video_file)

NANO_DECLARE_INSTANCE_EFFECT(video_blend)

NANO_DECLARE_INSTANCE_EFFECT(paramlinker)

NANO_DECLARE_INSTANCE_EFFECT(barrel_macros)
namespace barrel_macros { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(dashboard)
namespace dashboard { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(sketch_output)
namespace sketch_output { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(sidechannel_out)
namespace sidechannel_out {
int32_t is_identity(void* self);
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops);
}
NANO_DECLARE_INSTANCE_EFFECT(sidechannel_in)
namespace sidechannel_in {
int32_t is_identity(void* self);
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops);
}
// The scalar twins. No is_identity: they declare no texture fields at all, so
// the executor runs them as modulation nodes (the chain image passes through).
NANO_DECLARE_INSTANCE_EFFECT(sidechannel_scalar_out)
namespace sidechannel_scalar_out {
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops);
}
NANO_DECLARE_INSTANCE_EFFECT(sidechannel_scalar_in)
namespace sidechannel_scalar_in {
void eval_visibility(int n, const char* pb, const int* off, const int* len, const int* ops);
}

NANO_DECLARE_INSTANCE_EFFECT(bake_alpha)

NANO_DECLARE_INSTANCE_EFFECT(curve)

NANO_DECLARE_INSTANCE_EFFECT(exposure)
namespace exposure { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(color_temperature)
namespace color_temperature { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(invert)

NANO_DECLARE_INSTANCE_EFFECT(alpha_remap)
namespace alpha_remap { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(video_delay)
namespace video_delay { void on_active(void* self, int32_t active); }

NANO_DECLARE_INSTANCE_EFFECT(posterize)

NANO_DECLARE_INSTANCE_EFFECT(levels)

NANO_DECLARE_INSTANCE_EFFECT(hsl)

NANO_DECLARE_INSTANCE_EFFECT(color_space)

NANO_DECLARE_INSTANCE_EFFECT(hue_basis)

NANO_DECLARE_INSTANCE_EFFECT(saturate)

NANO_DECLARE_INSTANCE_EFFECT(vibrance)

NANO_DECLARE_INSTANCE_EFFECT(colorize)
namespace colorize { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(vignette)

NANO_DECLARE_INSTANCE_EFFECT(blur)

NANO_DECLARE_INSTANCE_EFFECT(fast_blur)

NANO_DECLARE_INSTANCE_EFFECT(sharpen)
namespace sharpen { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(local_contrast)
namespace local_contrast { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(edges)

NANO_DECLARE_INSTANCE_EFFECT(crop)

NANO_DECLARE_INSTANCE_EFFECT(transform)
namespace transform { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(gradient)

NANO_DECLARE_INSTANCE_EFFECT(grid)

NANO_DECLARE_INSTANCE_EFFECT(noise)

NANO_DECLARE_INSTANCE_EFFECT(motion_blur)

NANO_DECLARE_INSTANCE_EFFECT(auto_level)
namespace auto_level { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(twitch_mask)
namespace twitch_mask { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(mod_remap)
NANO_DECLARE_INSTANCE_EFFECT(mod_combine)

NANO_DECLARE_INSTANCE_EFFECT(mod_smooth)

NANO_DECLARE_INSTANCE_EFFECT(mod_delay)

NANO_DECLARE_INSTANCE_EFFECT(mod_envelope)

NANO_DECLARE_INSTANCE_EFFECT(mod_threshold)
NANO_DECLARE_INSTANCE_EFFECT(mod_invert)

NANO_DECLARE_INSTANCE_EFFECT(env_lfo)
namespace env_lfo { void seek(void* self, double from, double to); } // optional seek export

NANO_DECLARE_INSTANCE_EFFECT(env_adsr)

NANO_DECLARE_INSTANCE_EFFECT(trigger_beat)

NANO_DECLARE_INSTANCE_EFFECT(trigger_out)

extern "C" {

NANO_EXPORT_ABI_VERSION()

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    // "New style" name-keyed registration (see nano::EffectBuilder). Each hook
    // is registered by name, so optional ones are simply mentioned (or omitted)
    // at the call site rather than positioned in a struct. Equivalent to the
    // registerEffect({...}) form the other effects below still use.
    nano::EffectBuilder("color.tone.brightness_contrast")
        .name("Brightness & Contrast")
        .description("Adjusts brightness and contrast of a texture input")
        .category("color")
        .keywords("color,adjust,filter")
        .icon("la-adjust")   // optional web picker glyph (Line Awesome class)
        .moduleInit(&brightness_contrast::module_init)
        .create(&brightness_contrast::create)
        .destroy(&brightness_contrast::destroy)
        .init(&brightness_contrast::init)
        .tick(&brightness_contrast::tick)
        .render(&brightness_contrast::render)
        .onStatePatched(&brightness_contrast::on_state_patched)
        .isIdentity(&brightness_contrast::is_identity)
        .register_();

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
        "source.video.file",
        "Video File",
        "Outputs a decoded video frame injected by the host",
        "source",
        "video,source,clip,file",
        "la-film",
        NANO_INSTANCE_LIFECYCLE(video_file),
    });

    nano::registerEffect({
        2,
        "composite.blend",
        "Blend",
        "Blends two texture inputs with opacity control",
        "composite",
        "blend,mix,composite,opacity",
        "la-layer-group",
        NANO_INSTANCE_LIFECYCLE(video_blend),
    });

    nano::registerEffect({
        2,
        "control.paramlinker",
        "Param Linker",
        "Links two Resolume parameters together via learn mechanism",
        "control",
        "resolume,parameter,link,automation",
        "la-link",
        NANO_INSTANCE_LIFECYCLE(paramlinker),
    });

    nano::registerEffect({
        2,
        "control.barrel_macros",
        "Barrel Macros",
        "Exposes the NanoBarrel macro knobs as tappable float outputs",
        "control",
        "macro,knob,barrel,control,rail",
        "la-cubes",
        NANO_INSTANCE_LIFECYCLE(barrel_macros),
        &barrel_macros::is_identity,
    });

    nano::registerEffect({
        2,
        "util.dashboard",
        "Dashboard",
        "A bank of 8 knobs — each a wire source and sink for macro control",
        "control",
        "knob,macro,control,dashboard,util",
        "la-tachometer-alt",
        NANO_INSTANCE_LIFECYCLE(dashboard),
        &dashboard::is_identity,
    });

    nano::registerEffect({
        2,
        "util.sketch_output",
        "Sketch Output",
        "8 output traces — wire a producer's scalar into each to expose it as a sketch output",
        "control",
        "output,trace,sketch,macro,control,util",
        "la-sign-out-alt",
        NANO_INSTANCE_LIFECYCLE(sketch_output),
        &sketch_output::is_identity,
    });

    nano::registerEffect({
        2,
        "util.sidechannel_out",
        "Sidechannel Send",
        "Publish this chain's image onto a named cross-instance texture channel",
        "control",
        "sidechannel,send,route,bus,channel,share,util",
        "la-share-square",
        NANO_INSTANCE_LIFECYCLE(sidechannel_out),
        &sidechannel_out::is_identity,
        nullptr,  // on_active
        nullptr,  // seek
        &sidechannel_out::eval_visibility,
    });

    nano::registerEffect({
        2,
        "util.sidechannel_in",
        "Sidechannel Receive",
        "Replace this chain's image with a named cross-instance texture channel (transparent when idle)",
        "control",
        "sidechannel,receive,route,bus,channel,share,util",
        "la-sign-in-alt",
        NANO_INSTANCE_LIFECYCLE(sidechannel_in),
        &sidechannel_in::is_identity,
        nullptr,  // on_active
        nullptr,  // seek
        &sidechannel_in::eval_visibility,
    });

    nano::registerEffect({
        2,
        "util.sidechannel_scalar_out",
        "Value Send",
        "Publish a scalar onto a named cross-instance value channel (numbered separately from the image channels)",
        "control",
        "sidechannel,send,value,scalar,modulation,route,bus,channel,share,util",
        "la-share-square",
        NANO_INSTANCE_LIFECYCLE(sidechannel_scalar_out),
        nullptr,  // is_identity — no texture output; runs as a modulation node
        nullptr,  // on_active
        nullptr,  // seek
        &sidechannel_scalar_out::eval_visibility,
    });

    nano::registerEffect({
        2,
        "util.sidechannel_scalar_in",
        "Value Receive",
        "Read a named cross-instance value channel as a modulation source (0 when nothing is sending)",
        "control",
        "sidechannel,receive,value,scalar,modulation,route,bus,channel,share,util",
        "la-sign-in-alt",
        NANO_INSTANCE_LIFECYCLE(sidechannel_scalar_in),
        nullptr,  // is_identity — no texture output; runs as a modulation node
        nullptr,  // on_active
        nullptr,  // seek
        &sidechannel_scalar_in::eval_visibility,
    });

    nano::registerEffect({
        2,
        "composite.bake_alpha",
        "Bake Alpha",
        "Premultiplies RGB by alpha (mixable amount)",
        "composite",
        "alpha,premultiply,composite",
        "la-clone",
        NANO_INSTANCE_LIFECYCLE(bake_alpha),
    });

    nano::registerEffect({
        2,
        "color.tone.curve",
        "Curve",
        "Power curve applied to RGB and alpha (-1 squashes down, +1 lifts up)",
        "color",
        "curve,gamma,tonemap",
        "la-bezier-curve",
        NANO_INSTANCE_LIFECYCLE(curve),
    });

    nano::registerEffect({
        2,
        "color.tone.exposure",
        "Exposure",
        "Multiplicative gain measured in stops",
        "color",
        "exposure,gain,brightness,stops",
        "la-sun",
        NANO_INSTANCE_LIFECYCLE(exposure),
        &exposure::is_identity,
    });

    nano::registerEffect({
        2,
        "color.temperature",
        "Color Temperature",
        "Warm/cool white-balance shift on the orange/blue axis",
        "color",
        "temperature,warmth,white-balance,tint,color",
        "la-thermometer-half",
        NANO_INSTANCE_LIFECYCLE(color_temperature),
        &color_temperature::is_identity,
    });

    nano::registerEffect({
        2,
        "color.invert",
        "Invert",
        "Color inversion with optional alpha invert",
        "color",
        "invert,negative,color",
        "la-yin-yang",
        NANO_INSTANCE_LIFECYCLE(invert),
    });

    nano::registerEffect({
        2,
        "color.alpha.remap",
        "Alpha Remap",
        "Reshapes the alpha channel with the wire remap's curves: input/output windows, ease-in/out, foldback, saturate, scale",
        "color",
        "alpha,remap,matte,key,curve,range,transparency",
        "la-adjust",
        NANO_INSTANCE_LIFECYCLE(alpha_remap),
        &alpha_remap::is_identity,
    });

    nano::registerEffect({
        2,
        "motion.frame_delay",
        "Frame Delay",
        "Video delay line: replays the chain image a whole number of frames late (max 30), with no interpolation",
        "motion",
        "delay,echo,frame,history,time,buffer",
        "la-history",
        NANO_INSTANCE_LIFECYCLE(video_delay),
        nullptr,                    // is_identity — stateful; a skipped frame never enters the ring
        &video_delay::on_active,    // bypassed: hand the frame history back
    });

    nano::registerEffect({
        2,
        "color.posterize",
        "Posterize",
        "Quantizes RGB (and optionally alpha) to a small number of levels",
        "color",
        "posterize,quantize,bitcrush",
        "la-th-large",
        NANO_INSTANCE_LIFECYCLE(posterize),
    });

    nano::registerEffect({
        2,
        "color.tone.levels",
        "Levels",
        "Photoshop-style input/output remap with a gamma midtone control",
        "color",
        "levels,gamma,contrast,remap",
        "la-sliders-h",
        NANO_INSTANCE_LIFECYCLE(levels),
    });

    nano::registerEffect({
        2,
        "color.hsl",
        "HSL",
        "Hue rotation, saturation pull, and bipolar lightness in HSL space",
        "color",
        "hue,saturation,lightness,color",
        "la-palette",
        NANO_INSTANCE_LIFECYCLE(hsl),
    });

    nano::registerEffect({
        2,
        "color.color_space",
        "Color Space",
        "Convert RGB between sRGB and Linear encodings",
        "color",
        "color,space,srgb,linear,gamma,encoding",
        "la-swatchbook",
        NANO_INSTANCE_LIFECYCLE(color_space),
    });

    nano::registerEffect({
        2,
        "color.hue_basis",
        "Hue Basis",
        "Channel-mix into a basis defined by three hues; white-preserving forward, NaN-free reverse",
        "color",
        "hue,basis,channel-mixer,color,matrix",
        "la-tint",
        NANO_INSTANCE_LIFECYCLE(hue_basis),
    });

    nano::registerEffect({
        2,
        "color.saturate",
        "Saturate",
        "Per-channel tanh soft-clip with linear deadzone and asymmetric drive",
        "color",
        "saturate,softclip,tanh,waveshaper,compressor,rolloff",
        "la-fill-drip",
        NANO_INSTANCE_LIFECYCLE(saturate),
    });

    nano::registerEffect({
        2,
        "color.vibrance",
        "Vibrance",
        "Saturation boost biased toward already-unsaturated pixels",
        "color",
        "vibrance,saturation,color",
        "la-tint",
        NANO_INSTANCE_LIFECYCLE(vibrance),
    });

    nano::registerEffect({
        2,
        "color.colorize",
        "Colorize",
        "Tint the frame toward one colour: luma-mapped monochrome, multiply gel, or screen wash",
        "color",
        "colorize,tint,color,monochrome,sepia,duotone,gel",
        "la-palette",
        NANO_INSTANCE_LIFECYCLE(colorize),
        &colorize::is_identity,
    });

    nano::registerEffect({
        2,
        "filter.vignette",
        "Vignette",
        "Radial darken/lighten around a cover-square anchor with soft falloff",
        "filter",
        "vignette,edge,fade,corner",
        "la-dot-circle",
        NANO_INSTANCE_LIFECYCLE(vignette),
    });

    nano::registerEffect({
        2,
        "filter.blur.gaussian",
        "Blur",
        "Single-pass Gaussian blur with adjustable radius",
        "filter",
        "blur,gaussian,defocus,soften",
        "la-cloud",
        NANO_INSTANCE_LIFECYCLE(blur),
    });

    nano::registerEffect({
        2,
        "filter.blur.fast",
        "Fast Blur",
        "Iterative dual-filter blur (CoD/SIGGRAPH 2014). Cheaper than Gaussian for large radii.",
        "filter",
        "blur,bloom,dual-filter,downsample,upsample,fast",
        "la-wind",
        NANO_INSTANCE_LIFECYCLE(fast_blur),
    });

    nano::registerEffect({
        2,
        "filter.sharpen",
        "Sharpen",
        "Discrete Laplacian sharpen with adjustable radius",
        "filter",
        "sharpen,detail,laplacian",
        "la-crosshairs",
        NANO_INSTANCE_LIFECYCLE(sharpen),
        &sharpen::is_identity,
    });

    nano::registerEffect({
        2,
        "filter.local_contrast",
        "Local Contrast",
        "Large-radius unsharp mask (Clarity). Boosts mid-scale structure, not fine edges.",
        "filter",
        "contrast,clarity,unsharp,local,detail,punch,dehaze",
        "la-adjust",
        NANO_INSTANCE_LIFECYCLE(local_contrast),
        &local_contrast::is_identity,
    });

    nano::registerEffect({
        2,
        "filter.edges",
        "Edges",
        "Sobel edges with adjustable threshold and overlay colours",
        "filter",
        "edge,sobel,outline,detect",
        "la-border-style",
        NANO_INSTANCE_LIFECYCLE(edges),
    });

    nano::registerEffect({
        2,
        "warp.crop",
        "Crop",
        "Soft-edged rectangular crop in cover-square coordinates",
        "warp",
        "crop,mask,frame,window",
        "la-crop-alt",
        NANO_INSTANCE_LIFECYCLE(crop),
        nullptr,  // is_identity
        nullptr,  // on_active
        nullptr,  // seek
        &crop::eval_visibility,  // static visibility evaluator (pure over state)
    });

    nano::registerEffect({
        2,
        "warp.transform",
        "Transform",
        "2D affine resample (scale, rotate, translate around a pivot)",
        "warp",
        "transform,scale,rotate,translate,affine",
        "la-arrows-alt",
        NANO_INSTANCE_LIFECYCLE(transform),
        &transform::is_identity,
    });

    nano::registerEffect({
        2,
        "source.gradient",
        "Gradient",
        "Two-colour linear gradient with adjustable angle, offset, and softness",
        "source",
        "gradient,ramp,linear",
        "la-fill",
        NANO_INSTANCE_LIFECYCLE(gradient),
    });

    nano::registerEffect({
        2,
        "source.grid",
        "Grid",
        "Tiled grid pattern with adjustable cell size, line width, and softness",
        "source",
        "grid,pattern,tile,lines",
        "la-th",
        NANO_INSTANCE_LIFECYCLE(grid),
    });

    nano::registerEffect({
        2,
        "source.noise",
        "Noise",
        "Procedural noise: white, value, fbm, or animated static",
        "source",
        "noise,perlin,static,grain,procedural",
        "la-braille",
        NANO_INSTANCE_LIFECYCLE(noise),
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

    nano::registerEffect({
        2,
        "color.tone.auto_level",
        "Auto Level",
        "Histogram auto-leveler: equalize the luminance distribution and/or pull the median toward a target, chroma-preserving",
        "color",
        "auto,level,histogram,equalize,contrast,exposure,median",
        "la-magic",
        NANO_INSTANCE_LIFECYCLE(auto_level),
        &auto_level::is_identity,
    });

    nano::registerEffect({
        2,
        "filter.glitch.twitch_mask",
        "Twitch Mask",
        "Roaming vignette glitch: suppresses a random oval region each frame (bipolar shape blacks the rim or the centre)",
        "filter",
        "twitch,glitch,vignette,flicker,mask,random",
        "la-bolt",
        NANO_INSTANCE_LIFECYCLE(twitch_mask),
        &twitch_mask::is_identity,
    });

    nano::registerEffect({
        2,
        "mod.shaper.remap",
        "Remap",
        "Unary modulation shaper: range-remaps a modulation value with the same curves as the wire remap (in/out window, ease-in/out, foldback, scale)",
        "mod",
        "modulation,remap,shaper,curve,range,envelope",
        "la-exchange-alt",
        NANO_INSTANCE_LIFECYCLE(mod_remap),
    });

    nano::registerEffect({
        2,
        "mod.shaper.combine",
        "Combine",
        "Binary modulation shaper: combines two modulation signals with a selectable math op (add, subtract, multiply, divide, min/max, average, difference, screen, power, modulo, comparisons, hypot), with per-input gain and post scale/bias",
        "mod",
        "modulation,combine,math,binary,add,multiply,mix,shaper",
        "la-calculator",
        NANO_INSTANCE_LIFECYCLE(mod_combine),
    });

    nano::registerEffect({
        2,
        "mod.shaper.smooth",
        "Smooth",
        "Unary modulation shaper: linearly smooths a modulation value over a duration (same linear ramp as the wire smoothing option)",
        "mod",
        "modulation,smooth,slew,ramp,glide,shaper,filter",
        "la-stream",
        NANO_INSTANCE_LIFECYCLE(mod_smooth),
    });

    nano::registerEffect({
        2,
        "mod.shaper.delay",
        "Delay",
        "Unary modulation shaper: delays a modulation signal by a parameterized time via a delay line",
        "mod",
        "modulation,delay,line,echo,offset,lag,shaper",
        "la-clock",
        NANO_INSTANCE_LIFECYCLE(mod_delay),
    });

    nano::registerEffect({
        2,
        "mod.shaper.envelope",
        "Envelope",
        "Unary modulation shaper: remaps a modulation value through an arbitrary drawn envelope curve (per-segment exponential easing)",
        "mod",
        "modulation,envelope,remap,curve,shaper,draw,easing",
        "la-drafting-compass",
        NANO_INSTANCE_LIFECYCLE(mod_envelope),
    });

    nano::registerEffect({
        2,
        "mod.shaper.threshold",
        "Threshold",
        "Unary modulation shaper: compares a modulation value against a threshold and emits a gate (Hold) or a one-frame edge trigger (Up / Down / Any Edge)",
        "mod",
        "modulation,threshold,gate,comparator,edge,trigger,schmitt,shaper",
        "la-toggle-on",
        NANO_INSTANCE_LIFECYCLE(mod_threshold),
    });

    nano::registerEffect({
        2,
        "mod.shaper.invert",
        "Invert",
        "Unary modulation shaper: flips a modulation value (1 - x). The Invert switch and a Trigger-toggled internal latch XOR together, so either can invert and either can cancel the other",
        "mod",
        "modulation,invert,flip,negate,toggle,latch,trigger,shaper",
        "la-arrows-alt-v",
        NANO_INSTANCE_LIFECYCLE(mod_invert),
    });

    nano::registerEffect({
        2,
        "mod.source.lfo",
        "LFO",
        "Low frequency oscillator: a normalized [0,1] modulation source. Selectable waveform (sine/square/triangle/saw/random walk/random FM) with a shape morph, rate (0..10 Hz), amplitude, and invert.",
        "mod",
        "oscillator,modulation,automation,lfo,wave",
        "la-wave-square",
        NANO_INSTANCE_LIFECYCLE(env_lfo),
        nullptr,            // is_identity
        nullptr,            // on_active
        env_lfo::seek,      // backward-seekable: recompute phase from absolute time
        &env_lfo::eval_visibility,  // static visibility evaluator (rate vs period)
    });

    nano::registerEffect({
        2,
        "mod.source.adsr",
        "ADSR",
        "ADSR envelope generator (modulation source). A trigger / gate drives an attack-decay-sustain-release phase machine that publishes a scalar 'output' in [0,1]; it can also self-fire via 'auto_mode' (Off by default — Random is a Poisson stream, Beats locks to the host transport on a beat division). The 'mode' selector enables phases (Decay = instant falling pluck by default, through full ADSR); attack/decay/release are phase TIMES and sustain a held LEVEL, each ramp shaped by a per-phase ease curve (shared with mod.shaper.envelope). Polyphonic: up to 'voices' overlapping envelopes (output = their max) with Reset / Legato / Poly retrigger styles. Pure data module (no GPU, no input).",
        "mod",
        "envelope,adsr,modulation,automation,trigger,gate,generator,beat",
        "la-chart-line",
        NANO_INSTANCE_LIFECYCLE(env_adsr),
        nullptr,                     // is_identity
        nullptr,                     // on_active
        nullptr,                     // seek
        &env_adsr::eval_visibility,  // auto-trigger knob visibility (Off/Random/Beats)
    });

    nano::registerEffect({
        2,
        "mod.trigger.beat",
        "Beat Trigger",
        "Beat-clock trigger source: fires structured trigger events {on, channel, velocity} on a beat division of the transport (with a phase offset), published as a seq-numbered ring the composition executor consumes to launch scenes through return tracks (or the global trigger bus when unwired). The scalar 'output' pulses 1 on each tick with a short decay, doubling as an ordinary modulation source.",
        "mod",
        "trigger,scene,launch,beat,clock,modulation,event",
        "la-bolt",
        NANO_INSTANCE_LIFECYCLE(trigger_beat),
    });

    nano::registerEffect({
        2,
        "util.trigger_out",
        "Trigger Send",
        "Trigger source gated by a wired scalar: fires structured trigger events {on, channel, velocity} onto the global trigger rail when the Trigger input crosses a threshold, published as a seq-numbered ring the executor drains to the shared server (which launches matching Resolume clips). The image chain passes through untouched.",
        "control",
        "trigger,scene,launch,rail,send,event,route,util",
        "la-bolt",
        NANO_INSTANCE_LIFECYCLE(trigger_out),
    });
}

} // extern "C"
