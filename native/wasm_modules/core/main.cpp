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

namespace brightness_contrast {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace solid_color {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace video_blend {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace paramlinker {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
    void on_resolume_param(long long param_id, double value);
}

namespace bake_alpha {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace curve {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace exposure {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace invert {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace posterize {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace levels {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace hsl {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace color_space {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace hue_basis {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace saturate {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace vibrance {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace vignette {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace blur {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace fast_blur {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace sharpen {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace edges {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace crop {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace transform {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace gradient {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace grid {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace noise {
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
        "video.brightness_contrast",
        "Brightness/Contrast",
        "Adjusts brightness and contrast of a texture input",
        "video",
        "color,adjust,filter",
        brightness_contrast::init,
        brightness_contrast::tick,
        brightness_contrast::render,
        brightness_contrast::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "generator.solid_color",
        "Solid Color",
        "Fills the render target with a uniform RGB color",
        "generator",
        "color,fill",
        solid_color::init,
        solid_color::tick,
        solid_color::render,
        solid_color::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.blend",
        "Video Blend",
        "Blends two texture inputs with opacity control",
        "video",
        "blend,mix,composite,opacity",
        video_blend::init,
        video_blend::tick,
        video_blend::render,
        video_blend::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "utility.paramlinker",
        "Param Linker",
        "Links two Resolume parameters together via learn mechanism",
        "utility",
        "resolume,parameter,link,automation",
        paramlinker::init,
        paramlinker::tick,
        paramlinker::render,
        paramlinker::on_state_patched,
        paramlinker::on_resolume_param,
    });

    nano::registerEffect({
        1,
        "video.bake_alpha",
        "Bake Alpha",
        "Premultiplies RGB by alpha (mixable amount)",
        "video",
        "alpha,premultiply,composite",
        bake_alpha::init,
        bake_alpha::tick,
        bake_alpha::render,
        bake_alpha::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.curve",
        "Curve",
        "Power curve applied to RGB and alpha (-1 squashes down, +1 lifts up)",
        "video",
        "curve,gamma,tonemap",
        curve::init,
        curve::tick,
        curve::render,
        curve::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.exposure",
        "Exposure",
        "Multiplicative gain measured in stops, with an optional warmth tint",
        "video",
        "exposure,gain,brightness,stops",
        exposure::init,
        exposure::tick,
        exposure::render,
        exposure::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.invert",
        "Invert",
        "Mixable color inversion with optional alpha invert",
        "video",
        "invert,negative,color",
        invert::init,
        invert::tick,
        invert::render,
        invert::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.posterize",
        "Posterize",
        "Quantizes RGB (and optionally alpha) to a small number of levels",
        "video",
        "posterize,quantize,bitcrush",
        posterize::init,
        posterize::tick,
        posterize::render,
        posterize::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.levels",
        "Levels",
        "Photoshop-style input/output remap with a gamma midtone control",
        "video",
        "levels,gamma,contrast,remap",
        levels::init,
        levels::tick,
        levels::render,
        levels::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.hsl",
        "HSL",
        "Hue rotation, saturation pull, and bipolar lightness in HSL space",
        "video",
        "hue,saturation,lightness,color",
        hsl::init,
        hsl::tick,
        hsl::render,
        hsl::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.color_space",
        "Color Space",
        "Convert RGB between sRGB and Linear encodings",
        "video",
        "color,space,srgb,linear,gamma,encoding",
        color_space::init,
        color_space::tick,
        color_space::render,
        color_space::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.hue_basis",
        "Hue Basis",
        "Channel-mix into a basis defined by three hues; white-preserving forward, NaN-free reverse",
        "video",
        "hue,basis,channel-mixer,color,matrix",
        hue_basis::init,
        hue_basis::tick,
        hue_basis::render,
        hue_basis::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.saturate",
        "Saturate",
        "Per-channel tanh soft-clip with linear deadzone and asymmetric drive",
        "video",
        "saturate,softclip,tanh,waveshaper,compressor,rolloff",
        saturate::init,
        saturate::tick,
        saturate::render,
        saturate::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.vibrance",
        "Vibrance",
        "Saturation boost biased toward already-unsaturated pixels",
        "video",
        "vibrance,saturation,color",
        vibrance::init,
        vibrance::tick,
        vibrance::render,
        vibrance::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.vignette",
        "Vignette",
        "Radial darken/lighten around a cover-square anchor with soft falloff",
        "video",
        "vignette,edge,fade,corner",
        vignette::init,
        vignette::tick,
        vignette::render,
        vignette::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.blur",
        "Blur",
        "Single-pass Gaussian blur with adjustable radius",
        "video",
        "blur,gaussian,defocus,soften",
        blur::init,
        blur::tick,
        blur::render,
        blur::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.fast_blur",
        "Fast Blur",
        "Iterative dual-filter blur (CoD/SIGGRAPH 2014). Cheaper than Gaussian for large radii.",
        "video",
        "blur,bloom,dual-filter,downsample,upsample,fast",
        fast_blur::init,
        fast_blur::tick,
        fast_blur::render,
        fast_blur::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.sharpen",
        "Sharpen",
        "Discrete Laplacian sharpen with adjustable radius",
        "video",
        "sharpen,detail,laplacian",
        sharpen::init,
        sharpen::tick,
        sharpen::render,
        sharpen::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.edges",
        "Edge Detection",
        "Sobel edges with adjustable threshold and overlay colours",
        "video",
        "edge,sobel,outline,detect",
        edges::init,
        edges::tick,
        edges::render,
        edges::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.crop",
        "Crop",
        "Soft-edged rectangular crop in cover-square coordinates",
        "video",
        "crop,mask,frame,window",
        crop::init,
        crop::tick,
        crop::render,
        crop::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.transform",
        "Transform",
        "2D affine resample (scale, rotate, translate around a pivot)",
        "video",
        "transform,scale,rotate,translate,affine",
        transform::init,
        transform::tick,
        transform::render,
        transform::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "generator.gradient",
        "Gradient",
        "Two-colour linear gradient with adjustable angle, offset, and softness",
        "generator",
        "gradient,ramp,linear",
        gradient::init,
        gradient::tick,
        gradient::render,
        gradient::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "generator.grid",
        "Grid",
        "Tiled grid pattern with adjustable cell size, line width, and softness",
        "generator",
        "grid,pattern,tile,lines",
        grid::init,
        grid::tick,
        grid::render,
        grid::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "generator.noise",
        "Noise",
        "Procedural noise: white, value, fbm, or animated static",
        "generator",
        "noise,perlin,static,grain,procedural",
        noise::init,
        noise::tick,
        noise::render,
        noise::on_state_patched,
        nullptr,
    });
}

} // extern "C"
