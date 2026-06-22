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

NANO_DECLARE_INSTANCE_EFFECT(bake_alpha)

NANO_DECLARE_INSTANCE_EFFECT(curve)

NANO_DECLARE_INSTANCE_EFFECT(exposure)
namespace exposure { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(color_temperature)
namespace color_temperature { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(invert)

NANO_DECLARE_INSTANCE_EFFECT(posterize)

NANO_DECLARE_INSTANCE_EFFECT(levels)

NANO_DECLARE_INSTANCE_EFFECT(hsl)

NANO_DECLARE_INSTANCE_EFFECT(color_space)

NANO_DECLARE_INSTANCE_EFFECT(hue_basis)

NANO_DECLARE_INSTANCE_EFFECT(saturate)

NANO_DECLARE_INSTANCE_EFFECT(vibrance)

NANO_DECLARE_INSTANCE_EFFECT(vignette)

NANO_DECLARE_INSTANCE_EFFECT(blur)

NANO_DECLARE_INSTANCE_EFFECT(fast_blur)

NANO_DECLARE_INSTANCE_EFFECT(sharpen)
namespace sharpen { int32_t is_identity(void* self); }

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

NANO_DECLARE_INSTANCE_EFFECT(mod_smooth)

NANO_DECLARE_INSTANCE_EFFECT(mod_delay)

NANO_DECLARE_INSTANCE_EFFECT(mod_envelope)

NANO_DECLARE_INSTANCE_EFFECT(env_lfo)

NANO_DECLARE_INSTANCE_EFFECT(env_adsr)

extern "C" {

NANO_EXPORT_ABI_VERSION()

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    nano::registerEffect({
        2,
        "color.tone.brightness_contrast",
        "Brightness & Contrast",
        "Adjusts brightness and contrast of a texture input",
        "color",
        "color,adjust,filter",
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
        NANO_INSTANCE_LIFECYCLE(solid_color),
    });

    nano::registerEffect({
        2,
        "source.video.file",
        "Video File",
        "Outputs a decoded video frame injected by the host",
        "source",
        "video,source,clip,file",
        NANO_INSTANCE_LIFECYCLE(video_file),
    });

    nano::registerEffect({
        2,
        "composite.blend",
        "Blend",
        "Blends two texture inputs with opacity control",
        "composite",
        "blend,mix,composite,opacity",
        NANO_INSTANCE_LIFECYCLE(video_blend),
    });

    nano::registerEffect({
        2,
        "control.paramlinker",
        "Param Linker",
        "Links two Resolume parameters together via learn mechanism",
        "control",
        "resolume,parameter,link,automation",
        NANO_INSTANCE_LIFECYCLE(paramlinker),
    });

    nano::registerEffect({
        2,
        "control.barrel_macros",
        "Barrel Macros",
        "Exposes the NanoBarrel macro knobs as tappable float outputs",
        "control",
        "macro,knob,barrel,control,rail",
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
        NANO_INSTANCE_LIFECYCLE(sketch_output),
        &sketch_output::is_identity,
    });

    nano::registerEffect({
        2,
        "composite.bake_alpha",
        "Bake Alpha",
        "Premultiplies RGB by alpha (mixable amount)",
        "composite",
        "alpha,premultiply,composite",
        NANO_INSTANCE_LIFECYCLE(bake_alpha),
    });

    nano::registerEffect({
        2,
        "color.tone.curve",
        "Curve",
        "Power curve applied to RGB and alpha (-1 squashes down, +1 lifts up)",
        "color",
        "curve,gamma,tonemap",
        NANO_INSTANCE_LIFECYCLE(curve),
    });

    nano::registerEffect({
        2,
        "color.tone.exposure",
        "Exposure",
        "Multiplicative gain measured in stops",
        "color",
        "exposure,gain,brightness,stops",
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
        NANO_INSTANCE_LIFECYCLE(invert),
    });

    nano::registerEffect({
        2,
        "color.posterize",
        "Posterize",
        "Quantizes RGB (and optionally alpha) to a small number of levels",
        "color",
        "posterize,quantize,bitcrush",
        NANO_INSTANCE_LIFECYCLE(posterize),
    });

    nano::registerEffect({
        2,
        "color.tone.levels",
        "Levels",
        "Photoshop-style input/output remap with a gamma midtone control",
        "color",
        "levels,gamma,contrast,remap",
        NANO_INSTANCE_LIFECYCLE(levels),
    });

    nano::registerEffect({
        2,
        "color.hsl",
        "HSL",
        "Hue rotation, saturation pull, and bipolar lightness in HSL space",
        "color",
        "hue,saturation,lightness,color",
        NANO_INSTANCE_LIFECYCLE(hsl),
    });

    nano::registerEffect({
        2,
        "color.color_space",
        "Color Space",
        "Convert RGB between sRGB and Linear encodings",
        "color",
        "color,space,srgb,linear,gamma,encoding",
        NANO_INSTANCE_LIFECYCLE(color_space),
    });

    nano::registerEffect({
        2,
        "color.hue_basis",
        "Hue Basis",
        "Channel-mix into a basis defined by three hues; white-preserving forward, NaN-free reverse",
        "color",
        "hue,basis,channel-mixer,color,matrix",
        NANO_INSTANCE_LIFECYCLE(hue_basis),
    });

    nano::registerEffect({
        2,
        "color.saturate",
        "Saturate",
        "Per-channel tanh soft-clip with linear deadzone and asymmetric drive",
        "color",
        "saturate,softclip,tanh,waveshaper,compressor,rolloff",
        NANO_INSTANCE_LIFECYCLE(saturate),
    });

    nano::registerEffect({
        2,
        "color.vibrance",
        "Vibrance",
        "Saturation boost biased toward already-unsaturated pixels",
        "color",
        "vibrance,saturation,color",
        NANO_INSTANCE_LIFECYCLE(vibrance),
    });

    nano::registerEffect({
        2,
        "filter.vignette",
        "Vignette",
        "Radial darken/lighten around a cover-square anchor with soft falloff",
        "filter",
        "vignette,edge,fade,corner",
        NANO_INSTANCE_LIFECYCLE(vignette),
    });

    nano::registerEffect({
        2,
        "filter.blur.gaussian",
        "Blur",
        "Single-pass Gaussian blur with adjustable radius",
        "filter",
        "blur,gaussian,defocus,soften",
        NANO_INSTANCE_LIFECYCLE(blur),
    });

    nano::registerEffect({
        2,
        "filter.blur.fast",
        "Fast Blur",
        "Iterative dual-filter blur (CoD/SIGGRAPH 2014). Cheaper than Gaussian for large radii.",
        "filter",
        "blur,bloom,dual-filter,downsample,upsample,fast",
        NANO_INSTANCE_LIFECYCLE(fast_blur),
    });

    nano::registerEffect({
        2,
        "filter.sharpen",
        "Sharpen",
        "Discrete Laplacian sharpen with adjustable radius",
        "filter",
        "sharpen,detail,laplacian",
        NANO_INSTANCE_LIFECYCLE(sharpen),
        &sharpen::is_identity,
    });

    nano::registerEffect({
        2,
        "filter.edges",
        "Edges",
        "Sobel edges with adjustable threshold and overlay colours",
        "filter",
        "edge,sobel,outline,detect",
        NANO_INSTANCE_LIFECYCLE(edges),
    });

    nano::registerEffect({
        2,
        "warp.crop",
        "Crop",
        "Soft-edged rectangular crop in cover-square coordinates",
        "warp",
        "crop,mask,frame,window",
        NANO_INSTANCE_LIFECYCLE(crop),
    });

    nano::registerEffect({
        2,
        "warp.transform",
        "Transform",
        "2D affine resample (scale, rotate, translate around a pivot)",
        "warp",
        "transform,scale,rotate,translate,affine",
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
        NANO_INSTANCE_LIFECYCLE(gradient),
    });

    nano::registerEffect({
        2,
        "source.grid",
        "Grid",
        "Tiled grid pattern with adjustable cell size, line width, and softness",
        "source",
        "grid,pattern,tile,lines",
        NANO_INSTANCE_LIFECYCLE(grid),
    });

    nano::registerEffect({
        2,
        "source.noise",
        "Noise",
        "Procedural noise: white, value, fbm, or animated static",
        "source",
        "noise,perlin,static,grain,procedural",
        NANO_INSTANCE_LIFECYCLE(noise),
    });

    nano::registerEffect({
        2,
        "motion.blur",
        "Motion Blur",
        "Per-pixel motion blur driven by a RenderOutputs motion-vector rail. Falls back to pass-through when no motion is bound.",
        "motion",
        "blur,motion,velocity,render-outputs",
        NANO_INSTANCE_LIFECYCLE(motion_blur),
    });

    nano::registerEffect({
        2,
        "color.tone.auto_level",
        "Auto Level",
        "Histogram auto-leveler: equalize the luminance distribution and/or pull the median toward a target, chroma-preserving",
        "color",
        "auto,level,histogram,equalize,contrast,exposure,median",
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
        NANO_INSTANCE_LIFECYCLE(mod_remap),
    });

    nano::registerEffect({
        2,
        "mod.shaper.smooth",
        "Smooth",
        "Unary modulation shaper: linearly smooths a modulation value over a duration (same linear ramp as the wire smoothing option)",
        "mod",
        "modulation,smooth,slew,ramp,glide,shaper,filter",
        NANO_INSTANCE_LIFECYCLE(mod_smooth),
    });

    nano::registerEffect({
        2,
        "mod.shaper.delay",
        "Delay",
        "Unary modulation shaper: delays a modulation signal by a parameterized time via a delay line",
        "mod",
        "modulation,delay,line,echo,offset,lag,shaper",
        NANO_INSTANCE_LIFECYCLE(mod_delay),
    });

    nano::registerEffect({
        2,
        "mod.shaper.envelope",
        "Envelope",
        "Unary modulation shaper: remaps a modulation value through an arbitrary drawn envelope curve (per-segment exponential easing)",
        "mod",
        "modulation,envelope,remap,curve,shaper,draw,easing",
        NANO_INSTANCE_LIFECYCLE(mod_envelope),
    });

    nano::registerEffect({
        2,
        "mod.source.lfo",
        "LFO",
        "Low frequency oscillator: a normalized [0,1] modulation source. Selectable waveform (sine/square/triangle/saw/random walk/random FM) with a shape morph, rate (0..10 Hz), amplitude, and invert.",
        "mod",
        "oscillator,modulation,automation,lfo,wave",
        NANO_INSTANCE_LIFECYCLE(env_lfo),
    });

    nano::registerEffect({
        2,
        "mod.source.adsr",
        "ADSR",
        "ADSR envelope generator (modulation source). A trigger / gate / Poisson auto-rate drives an attack-decay-sustain-release phase machine that publishes a scalar 'output' in [0,1]. The 'mode' selector enables phases (Decay = instant falling pluck by default, through full ADSR); attack/decay/release are phase TIMES and sustain a held LEVEL, each ramp shaped by a per-phase ease curve (shared with mod.shaper.envelope). Polyphonic: up to 'voices' overlapping envelopes (output = their max) with Reset / Legato / Poly retrigger styles. Pure data module (no GPU, no input).",
        "mod",
        "envelope,adsr,modulation,automation,trigger,gate,generator",
        NANO_INSTANCE_LIFECYCLE(env_adsr),
    });
}

} // extern "C"
