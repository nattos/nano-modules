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
}

} // extern "C"
