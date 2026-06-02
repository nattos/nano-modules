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

NANO_DECLARE_LEGACY_EFFECT(video_blend)

NANO_DECLARE_LEGACY_EFFECT(paramlinker)
namespace paramlinker { void on_resolume_param(long long param_id, double value); }

NANO_DECLARE_INSTANCE_EFFECT(bake_alpha)

NANO_DECLARE_INSTANCE_EFFECT(curve)

NANO_DECLARE_INSTANCE_EFFECT(exposure)
namespace exposure { int32_t is_identity(void* self); }

NANO_DECLARE_INSTANCE_EFFECT(invert)

NANO_DECLARE_INSTANCE_EFFECT(posterize)

NANO_DECLARE_INSTANCE_EFFECT(levels)

NANO_DECLARE_INSTANCE_EFFECT(hsl)

NANO_DECLARE_INSTANCE_EFFECT(color_space)

NANO_DECLARE_INSTANCE_EFFECT(hue_basis)

NANO_DECLARE_INSTANCE_EFFECT(saturate)

NANO_DECLARE_INSTANCE_EFFECT(vibrance)

NANO_DECLARE_INSTANCE_EFFECT(vignette)

NANO_DECLARE_LEGACY_EFFECT(blur)

NANO_DECLARE_LEGACY_EFFECT(fast_blur)

NANO_DECLARE_LEGACY_EFFECT(sharpen)
namespace sharpen { int is_identity(); }

NANO_DECLARE_LEGACY_EFFECT(edges)
namespace edges { int is_identity(); }

NANO_DECLARE_LEGACY_EFFECT(crop)

NANO_DECLARE_LEGACY_EFFECT(transform)
namespace transform { int is_identity(); }

NANO_DECLARE_INSTANCE_EFFECT(gradient)

NANO_DECLARE_INSTANCE_EFFECT(grid)

NANO_DECLARE_INSTANCE_EFFECT(noise)

NANO_DECLARE_INSTANCE_EFFECT(motion_blur)

extern "C" {

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    nano::registerEffect({
        2,
        "video.brightness_contrast",
        "Brightness/Contrast",
        "Adjusts brightness and contrast of a texture input",
        "video",
        "color,adjust,filter",
        NANO_INSTANCE_LIFECYCLE(brightness_contrast),
        &brightness_contrast::is_identity,
    });

    nano::registerEffect({
        2,
        "generator.solid_color",
        "Solid Color",
        "Fills the render target with a uniform RGB color",
        "generator",
        "color,fill",
        NANO_INSTANCE_LIFECYCLE(solid_color),
    });

    nano::registerEffect({
        2,
        "video.blend",
        "Video Blend",
        "Blends two texture inputs with opacity control",
        "video",
        "blend,mix,composite,opacity",
        NANO_LEGACY_LIFECYCLE(video_blend),
    });

    nano::registerEffect({
        2,
        "utility.paramlinker",
        "Param Linker",
        "Links two Resolume parameters together via learn mechanism",
        "utility",
        "resolume,parameter,link,automation",
        nullptr,
        []() -> void* { return (void*)1; },
        [](void*) {},
        [](void* self) { (void)self; paramlinker::init(); },
        [](void* self, double dt) { (void)self; paramlinker::tick(dt); },
        [](void* self, int w, int h) { (void)self; paramlinker::render(w, h); },
        [](void* self, int n, const char* pb, const int* o, const int* l, const int* op) {
            (void)self; paramlinker::on_state_patched(n, pb, o, l, op);
        },
        [](void* self, long long id, double v) { (void)self; paramlinker::on_resolume_param(id, v); },
    });

    nano::registerEffect({
        2,
        "video.bake_alpha",
        "Bake Alpha",
        "Premultiplies RGB by alpha (mixable amount)",
        "video",
        "alpha,premultiply,composite",
        NANO_INSTANCE_LIFECYCLE(bake_alpha),
    });

    nano::registerEffect({
        2,
        "video.curve",
        "Curve",
        "Power curve applied to RGB and alpha (-1 squashes down, +1 lifts up)",
        "video",
        "curve,gamma,tonemap",
        NANO_INSTANCE_LIFECYCLE(curve),
    });

    nano::registerEffect({
        2,
        "video.exposure",
        "Exposure",
        "Multiplicative gain measured in stops, with an optional warmth tint",
        "video",
        "exposure,gain,brightness,stops",
        NANO_INSTANCE_LIFECYCLE(exposure),
        &exposure::is_identity,
    });

    nano::registerEffect({
        2,
        "video.invert",
        "Invert",
        "Mixable color inversion with optional alpha invert",
        "video",
        "invert,negative,color",
        NANO_INSTANCE_LIFECYCLE(invert),
    });

    nano::registerEffect({
        2,
        "video.posterize",
        "Posterize",
        "Quantizes RGB (and optionally alpha) to a small number of levels",
        "video",
        "posterize,quantize,bitcrush",
        NANO_INSTANCE_LIFECYCLE(posterize),
    });

    nano::registerEffect({
        2,
        "video.levels",
        "Levels",
        "Photoshop-style input/output remap with a gamma midtone control",
        "video",
        "levels,gamma,contrast,remap",
        NANO_INSTANCE_LIFECYCLE(levels),
    });

    nano::registerEffect({
        2,
        "video.hsl",
        "HSL",
        "Hue rotation, saturation pull, and bipolar lightness in HSL space",
        "video",
        "hue,saturation,lightness,color",
        NANO_INSTANCE_LIFECYCLE(hsl),
    });

    nano::registerEffect({
        2,
        "video.color_space",
        "Color Space",
        "Convert RGB between sRGB and Linear encodings",
        "video",
        "color,space,srgb,linear,gamma,encoding",
        NANO_INSTANCE_LIFECYCLE(color_space),
    });

    nano::registerEffect({
        2,
        "video.hue_basis",
        "Hue Basis",
        "Channel-mix into a basis defined by three hues; white-preserving forward, NaN-free reverse",
        "video",
        "hue,basis,channel-mixer,color,matrix",
        NANO_INSTANCE_LIFECYCLE(hue_basis),
    });

    nano::registerEffect({
        2,
        "video.saturate",
        "Saturate",
        "Per-channel tanh soft-clip with linear deadzone and asymmetric drive",
        "video",
        "saturate,softclip,tanh,waveshaper,compressor,rolloff",
        NANO_INSTANCE_LIFECYCLE(saturate),
    });

    nano::registerEffect({
        2,
        "video.vibrance",
        "Vibrance",
        "Saturation boost biased toward already-unsaturated pixels",
        "video",
        "vibrance,saturation,color",
        NANO_INSTANCE_LIFECYCLE(vibrance),
    });

    nano::registerEffect({
        2,
        "video.vignette",
        "Vignette",
        "Radial darken/lighten around a cover-square anchor with soft falloff",
        "video",
        "vignette,edge,fade,corner",
        NANO_INSTANCE_LIFECYCLE(vignette),
    });

    nano::registerEffect({
        2,
        "video.blur",
        "Blur",
        "Single-pass Gaussian blur with adjustable radius",
        "video",
        "blur,gaussian,defocus,soften",
        NANO_LEGACY_LIFECYCLE(blur),
    });

    nano::registerEffect({
        2,
        "video.fast_blur",
        "Fast Blur",
        "Iterative dual-filter blur (CoD/SIGGRAPH 2014). Cheaper than Gaussian for large radii.",
        "video",
        "blur,bloom,dual-filter,downsample,upsample,fast",
        NANO_LEGACY_LIFECYCLE(fast_blur),
    });

    nano::registerEffect({
        2,
        "video.sharpen",
        "Sharpen",
        "Discrete Laplacian sharpen with adjustable radius",
        "video",
        "sharpen,detail,laplacian",
        NANO_LEGACY_LIFECYCLE(sharpen),
        [](void* self) -> int32_t { (void)self; return sharpen::is_identity(); },
    });

    nano::registerEffect({
        2,
        "video.edges",
        "Edge Detection",
        "Sobel edges with adjustable threshold and overlay colours",
        "video",
        "edge,sobel,outline,detect",
        NANO_LEGACY_LIFECYCLE(edges),
        [](void* self) -> int32_t { (void)self; return edges::is_identity(); },
    });

    nano::registerEffect({
        2,
        "video.crop",
        "Crop",
        "Soft-edged rectangular crop in cover-square coordinates",
        "video",
        "crop,mask,frame,window",
        NANO_LEGACY_LIFECYCLE(crop),
    });

    nano::registerEffect({
        2,
        "video.transform",
        "Transform",
        "2D affine resample (scale, rotate, translate around a pivot)",
        "video",
        "transform,scale,rotate,translate,affine",
        NANO_LEGACY_LIFECYCLE(transform),
        [](void* self) -> int32_t { (void)self; return transform::is_identity(); },
    });

    nano::registerEffect({
        2,
        "generator.gradient",
        "Gradient",
        "Two-colour linear gradient with adjustable angle, offset, and softness",
        "generator",
        "gradient,ramp,linear",
        NANO_INSTANCE_LIFECYCLE(gradient),
    });

    nano::registerEffect({
        2,
        "generator.grid",
        "Grid",
        "Tiled grid pattern with adjustable cell size, line width, and softness",
        "generator",
        "grid,pattern,tile,lines",
        NANO_INSTANCE_LIFECYCLE(grid),
    });

    nano::registerEffect({
        2,
        "generator.noise",
        "Noise",
        "Procedural noise: white, value, fbm, or animated static",
        "generator",
        "noise,perlin,static,grain,procedural",
        NANO_INSTANCE_LIFECYCLE(noise),
    });

    nano::registerEffect({
        2,
        "video.motion_blur",
        "Motion Blur",
        "Per-pixel motion blur driven by a RenderOutputs motion-vector rail. Falls back to pass-through when no motion is bound.",
        "video",
        "blur,motion,velocity,render-outputs",
        NANO_INSTANCE_LIFECYCLE(motion_blur),
    });
}

} // extern "C"
