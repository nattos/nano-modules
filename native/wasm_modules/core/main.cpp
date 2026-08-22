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
NANO_DECLARE_INSTANCE_EFFECT(video_layer)

NANO_DECLARE_INSTANCE_EFFECT(paramlinker)

NANO_DECLARE_INSTANCE_EFFECT(barrel_macros)
namespace barrel_macros { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(artnet_in)
namespace artnet_in { int32_t is_identity(void* self); }

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
// The split-out math shapers (mod_math/main.cpp) — one namespace per op,
// all sharing one implementation and the op table in include/mod_math_ops.h.
NANO_DECLARE_INSTANCE_EFFECT(mod_add)
NANO_DECLARE_INSTANCE_EFFECT(mod_subtract)
NANO_DECLARE_INSTANCE_EFFECT(mod_multiply)
NANO_DECLARE_INSTANCE_EFFECT(mod_divide)
NANO_DECLARE_INSTANCE_EFFECT(mod_min)
NANO_DECLARE_INSTANCE_EFFECT(mod_max)
NANO_DECLARE_INSTANCE_EFFECT(mod_average)
NANO_DECLARE_INSTANCE_EFFECT(mod_difference)
NANO_DECLARE_INSTANCE_EFFECT(mod_screen)
NANO_DECLARE_INSTANCE_EFFECT(mod_power)
NANO_DECLARE_INSTANCE_EFFECT(mod_modulo)
NANO_DECLARE_INSTANCE_EFFECT(mod_greater)
NANO_DECLARE_INSTANCE_EFFECT(mod_less)
NANO_DECLARE_INSTANCE_EFFECT(mod_hypot)
NANO_DECLARE_INSTANCE_EFFECT(mod_quantize)

NANO_DECLARE_INSTANCE_EFFECT(mod_flip)
NANO_DECLARE_INSTANCE_EFFECT(mod_latch)

NANO_DECLARE_INSTANCE_EFFECT(mod_time)

// The built-in play modes as transport-controller effects (transport_core/).
NANO_DECLARE_INSTANCE_EFFECT(transport_time)
namespace transport_time { int32_t is_identity(void* self); }
NANO_DECLARE_INSTANCE_EFFECT(transport_beat_sync)
namespace transport_beat_sync { int32_t is_identity(void* self); }
NANO_DECLARE_INSTANCE_EFFECT(transport_one_shot)
namespace transport_one_shot { int32_t is_identity(void* self); }
NANO_DECLARE_INSTANCE_EFFECT(transport_random)
namespace transport_random { int32_t is_identity(void* self); }
NANO_DECLARE_INSTANCE_EFFECT(transport_follow)
namespace transport_follow { int32_t is_identity(void* self); }
NANO_DECLARE_INSTANCE_EFFECT(transition_xfade)
namespace transition_xfade { int32_t is_identity(void* self); }
NANO_DECLARE_INSTANCE_EFFECT(mod_bpm)

NANO_DECLARE_INSTANCE_EFFECT(mod_smooth)
NANO_DECLARE_INSTANCE_EFFECT(mod_motion)
NANO_DECLARE_INSTANCE_EFFECT(mod_transient)

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
        "control.artnet",
        "Art-Net In",
        "Exposes incoming Art-Net/DMX channels as tappable float outputs",
        "control",
        "artnet,dmx,lighting,trigger,control,rail",
        "la-broadcast-tower",
        NANO_INSTANCE_LIFECYCLE(artnet_in),
        &artnet_in::is_identity,
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

    // The split-out math shapers — one op each, no selector, and 2-8 inputs
    // folded left to right (see mod_math/main.cpp). Deliberately simpler than
    // Combine above: gains and post scale/bias live on the WIRE instead.
    nano::registerEffect({
        2,
        "mod.shaper.add",
        "Add",
        "Sums 2-8 modulation signals. The input count is adjustable from the card's gear icon",
        "mod",
        "modulation,math,add,sum,plus,combine",
        "la-plus",
        NANO_INSTANCE_LIFECYCLE(mod_add),
    });
    nano::registerEffect({
        2,
        "mod.shaper.subtract",
        "Subtract",
        "Subtracts each modulation input from the running result, left to right (in1 - in2 - in3 ...)",
        "mod",
        "modulation,math,subtract,minus,difference",
        "la-minus",
        NANO_INSTANCE_LIFECYCLE(mod_subtract),
    });
    nano::registerEffect({
        2,
        "mod.shaper.multiply",
        "Multiply",
        "Multiplies 2-8 modulation signals together — ring-mod flicker, or one signal gating another",
        "mod",
        "modulation,math,multiply,times,product,ring,gate",
        "la-times",
        NANO_INSTANCE_LIFECYCLE(mod_multiply),
    });
    nano::registerEffect({
        2,
        "mod.shaper.divide",
        "Divide",
        "Divides the running result by each modulation input in turn; guarded against division by zero",
        "mod",
        "modulation,math,divide,ratio",
        "la-divide",
        NANO_INSTANCE_LIFECYCLE(mod_divide),
    });
    nano::registerEffect({
        2,
        "mod.shaper.min",
        "Min",
        "Takes the smallest of 2-8 modulation signals — a soft gate that can't rise until every input does",
        "mod",
        "modulation,math,min,minimum,smallest,gate",
        "la-angle-down",
        NANO_INSTANCE_LIFECYCLE(mod_min),
    });
    nano::registerEffect({
        2,
        "mod.shaper.max",
        "Max",
        "Takes the largest of 2-8 modulation signals — merges several triggers without them summing past the top",
        "mod",
        "modulation,math,max,maximum,largest,merge",
        "la-angle-up",
        NANO_INSTANCE_LIFECYCLE(mod_max),
    });
    nano::registerEffect({
        2,
        "mod.shaper.average",
        "Average",
        "The mean of 2-8 modulation signals — a smoother blend than Add that stays inside the range",
        "mod",
        "modulation,math,average,mean,blend,mix",
        "la-equals",
        NANO_INSTANCE_LIFECYCLE(mod_average),
    });
    nano::registerEffect({
        2,
        "mod.shaper.difference",
        "Difference",
        "The absolute distance between modulation signals — two near-equal rates produce a slow beat",
        "mod",
        "modulation,math,difference,distance,abs,beat",
        "la-not-equal",
        NANO_INSTANCE_LIFECYCLE(mod_difference),
    });
    nano::registerEffect({
        2,
        "mod.shaper.screen",
        "Screen",
        "Inverse-multiply blend of modulation signals: they accumulate toward 1 but never overshoot it",
        "mod",
        "modulation,math,screen,blend,light",
        "la-adjust",
        NANO_INSTANCE_LIFECYCLE(mod_screen),
    });
    nano::registerEffect({
        2,
        "mod.shaper.power",
        "Power",
        "Raises the running result to each modulation input — bends a linear source into a curve",
        "mod",
        "modulation,math,power,exponent,curve,ease",
        "la-superscript",
        NANO_INSTANCE_LIFECYCLE(mod_power),
    });
    nano::registerEffect({
        2,
        "mod.shaper.modulo",
        "Modulo",
        "Remainder after dividing by each modulation input — wraps a rising signal into a repeating sawtooth",
        "mod",
        "modulation,math,modulo,mod,wrap,remainder,saw",
        "la-percent",
        NANO_INSTANCE_LIFECYCLE(mod_modulo),
    });
    nano::registerEffect({
        2,
        "mod.shaper.greater",
        "Greater Than",
        "Emits a hard 1 while the running result is above the next modulation input — a comparison gate",
        "mod",
        "modulation,math,greater,compare,gate,threshold",
        "la-greater-than",
        NANO_INSTANCE_LIFECYCLE(mod_greater),
    });
    nano::registerEffect({
        2,
        "mod.shaper.less",
        "Less Than",
        "Emits a hard 1 while the running result is below the next modulation input — a comparison gate",
        "mod",
        "modulation,math,less,compare,gate,threshold",
        "la-less-than",
        NANO_INSTANCE_LIFECYCLE(mod_less),
    });
    nano::registerEffect({
        2,
        "mod.shaper.hypot",
        "Hypot",
        "Vector length of the modulation inputs, sqrt(a^2 + b^2 + ...) — their combined magnitude",
        "mod",
        "modulation,math,hypot,length,magnitude,vector",
        "la-ruler-combined",
        NANO_INSTANCE_LIFECYCLE(mod_hypot),
    });
    nano::registerEffect({
        2,
        "mod.shaper.quantize",
        "Quantize",
        "Snaps the running result to the nearest multiple of each modulation input — staircase motion",
        "mod",
        "modulation,math,quantize,step,snap,crush,stair",
        "la-signal",
        NANO_INSTANCE_LIFECYCLE(mod_quantize),
    });

    nano::registerEffect({
        2,
        "mod.shaper.flip",
        "Flip",
        "Trigger-flipped latch with pickup takeover: a trigger slams the output to the opposite rail (an exact 0 or 1) and unlatches it from the input; when the input catches up to the rail (or crosses it) it takes over and the output follows it again — MIDI-fader soft-takeover as a modulation shaper",
        "mod",
        "modulation,flip,toggle,latch,takeover,pickup,trigger,shaper",
        "la-toggle-on",
        NANO_INSTANCE_LIFECYCLE(mod_flip),
    });

    nano::registerEffect({
        2,
        "mod.shaper.latch",
        "Latch",
        "Sample-and-hold latch: a trigger snapshots the input into a held value that stays put between events; a reset drops it back to the Initial Value parameter (followed live until the next trigger) — turns a moving modulation source into stepped, beat-locked values",
        "mod",
        "modulation,latch,sample,hold,snapshot,freeze,step,trigger,reset,shaper",
        "la-thumbtack",
        NANO_INSTANCE_LIFECYCLE(mod_latch),
    });

    nano::registerEffect({
        2,
        "mod.source.time",
        "Time",
        "Transport time/beat-phase modulation source: outputs a looping phase fraction plus the raw beats/seconds value. Beats or Time domain; Locked (exact host beat/bar phase or host time, scrubs and all) or Free (integrates forward only, never backwards) sync; loop period in beats (default 4 = one bar) or seconds, with the Value output wrapped into the loop or absolute",
        "mod",
        "modulation,time,beats,clock,phase,loop,transport,bpm,source",
        "la-clock",
        NANO_INSTANCE_LIFECYCLE(mod_time),
        nullptr,            // is_identity
        nullptr,            // on_active
        nullptr,            // seek
        &mod_time::eval_visibility,  // static visibility evaluator (beats vs seconds period)
    });

    nano::registerEffect({
        2,
        "mod.source.bpm",
        "BPM",
        "Transport tempo modulation source: outputs the host BPM verbatim plus the duration of one beat in seconds (60/BPM) — a stateless per-frame host read, for tempo displays, math shapers, and tempo-synced delay/period inputs",
        "mod",
        "modulation,bpm,tempo,beat,duration,seconds,clock,transport,source",
        "la-tachometer-alt",
        NANO_INSTANCE_LIFECYCLE(mod_bpm),
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
        "mod.shaper.motion",
        "Motion",
        "Unary modulation shaper: reports how fast its input is moving — a normalized differentiator (full-scale rate in input ranges per second) with catch-fast/coast-slow momentum, plus an optional integrator: Activity charges a meter that drains over a decay (a 'how alive is this knob' envelope), Throw flings a center-resting position that leaks back home. Unsigned speed/level on output, signed live velocity as a secondary channel",
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
        "mod.shaper.transient_shaper",
        "Transient Shaper",
        "Adaptive beat-grid transient sharpener: learns which grid slots of the bar carry a real onset in a smoothed band level (FFT bass) and snaps those attacks up toward the learned peak — earlier triggering and a fast synthetic rise, gated by per-slot confidence that eases in over bars of hits and back out on misses. A boost only ever fires on a rise that actually happened. Secondary pluck output renders the transient as a short percussive envelope; confidence output exposes the learning live",
        "mod",
        "modulation,transient,attack,punch,kick,bass,beat,grid,adaptive,sharpen,pluck,shaper",
        "la-bolt",
        NANO_INSTANCE_LIFECYCLE(mod_transient),
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
        "Low frequency oscillator: a bipolar [-1,1] modulation source. Selectable waveform (sine/square/triangle/saw/random walk/random FM) with a shape morph, amplitude, and invert. Speed in Hz (0..10), seconds (up to 5 min), or transport beats (tempo-synced); Free sync integrates forward only, Locked re-anchors the phase to the host beat/timeline every frame.",
        "mod",
        "oscillator,modulation,automation,lfo,wave,beats,tempo,sync,locked",
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
        "Beat-clock trigger source: fires structured trigger events {on, channel, velocity} on a beat division of the transport (with a phase offset), published as a seq-numbered ring the composition executor consumes to launch scenes through return tracks (or the global trigger bus when unwired). The scalar 'output' pulses 1 on each tick with a short decay (or, with Single Frame on, an exact one-frame 1.0 gate), doubling as an ordinary modulation source.",
        "mod",
        "trigger,scene,launch,beat,clock,modulation,event",
        "la-bolt",
        NANO_INSTANCE_LIFECYCLE(trigger_beat),
    });

    // ── Transport controllers (the built-in play modes as plugins) ──
    nano::registerEffect({
        2,
        "core.transport.time",
        "Transport: Time",
        "Loops the source slice at a real-time speed — the plugin form of the 'time' play mode. Hosted in a clip's transport section it drives WHICH source frame plays (identity on pixels); slice, speed, direction and ping-pong match the built-in mode exactly.",
        "transport",
        "transport,time,loop,speed,play,clip",
        "la-clock",
        NANO_INSTANCE_LIFECYCLE(transport_time),
        &transport_time::is_identity,
    });

    nano::registerEffect({
        2,
        "core.transport.beat_sync",
        "Transport: Beat Sync",
        "Locks one loop of the source slice to a beat count (BPM-independent) — the plugin form of the 'beat-sync' play mode. Identity on pixels; drives the clip's content time from its transport section.",
        "transport",
        "transport,beats,sync,loop,bpm,clip",
        "la-music",
        NANO_INSTANCE_LIFECYCLE(transport_beat_sync),
        &transport_beat_sync::is_identity,
    });

    nano::registerEffect({
        2,
        "core.transport.one_shot",
        "Transport: One-Shot",
        "Plays the source once from the slice start and latches transport_ended off the end (auto-stops a launched scene) — the plugin form of the 'one-shot' play mode. Re-arms when the transport rewinds past its start.",
        "transport",
        "transport,one-shot,once,play,clip,scene",
        "la-step-forward",
        NANO_INSTANCE_LIFECYCLE(transport_one_shot),
        &transport_one_shot::is_identity,
    });

    nano::registerEffect({
        2,
        "core.transport.random",
        "Transport: Random",
        "A deterministic seeded dwell-jump walk over the source slice — the plugin (and export-stable) form of the 'random' play mode: drifts at a speed between jumps, jumps a random distance every dwell interval, and publishes the next jump target so the decode pump can pre-warm it.",
        "transport",
        "transport,random,jump,dwell,walk,clip",
        "la-random",
        NANO_INSTANCE_LIFECYCLE(transport_random),
        &transport_random::is_identity,
    });

    nano::registerEffect({
        2,
        "core.transport.follow",
        "Transport: Follow",
        "Follow actions / autopilot for scene tracks: when this scene's duration elapses (the standard clip duration, or a Beats/Seconds override), launch another scene on the same track — Next/Previous/First/Last/Random/Other/Again/Stop, scoped to the whole track or the Group of contiguous grid cells. Never drives content time; the scene's own play mode keeps running underneath, and the engine's automatic one-shot stop defers to it.",
        "transport",
        "transport,follow,autopilot,scene,launch,next,random,live",
        "la-forward",
        NANO_INSTANCE_LIFECYCLE(transport_follow),
        &transport_follow::is_identity,
        nullptr,            // on_active
        nullptr,            // seek
        &transport_follow::eval_visibility,
    });

    nano::registerEffect({
        2,
        "transition.xfade",
        "Transition: Crossfade",
        "Crossfade transition for scene tracks: place it on the TRACK's transport section and scene changes fade instead of cutting. Announced launches (a Follow inside its window) trigger the incoming EARLY so the fade completes at the outgoing clip's true end; manual launches fade from the switch. The outgoing playback forks and keeps running — same decoder, same effect instances — until the fade releases it.",
        "transport",
        "transition,crossfade,fade,scene,launch,blend,mix",
        "la-random",
        NANO_INSTANCE_LIFECYCLE(transition_xfade),
        &transition_xfade::is_identity,
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
