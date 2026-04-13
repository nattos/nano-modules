/*
 * nano_effects — Combined module entry point.
 *
 * Registers all built-in effects via the module registration API.
 * Each effect's implementation lives in its own namespace within its
 * original source file; this file ties them together.
 */

#include <module_api.h>
#include <cstddef>  // nullptr

// Forward declarations for all effects.

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

namespace env_lfo {
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

namespace gpu_test {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace spinningtris {
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

namespace nanolooper {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace particles_emitter {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace particles_renderer {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

extern "C" {

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    nano::registerEffect({
        1, // struct_version
        "video.brightness_contrast",
        "Brightness/Contrast",
        "Adjusts brightness and contrast of a texture input",
        "video",
        "color,adjust,filter",
        brightness_contrast::init,
        brightness_contrast::tick,
        brightness_contrast::render,
        brightness_contrast::on_state_patched,
        nullptr, // on_resolume_param
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
        "data.lfo",
        "LFO",
        "Low frequency oscillator outputting a sine wave",
        "data",
        "oscillator,modulation,automation",
        env_lfo::init,
        env_lfo::tick,
        env_lfo::render,
        env_lfo::on_state_patched,
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
        "debug.gpu_test",
        "GPU Test",
        "GPU pipeline test rendering a solid color",
        "debug",
        "test,gpu,pipeline",
        gpu_test::init,
        gpu_test::tick,
        gpu_test::render,
        gpu_test::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "generator.spinningtris",
        "Spinning Triangles",
        "Animated spinning triangles GPU demo",
        "generator",
        "demo,triangles,animation,generative",
        spinningtris::init,
        spinningtris::tick,
        spinningtris::render,
        spinningtris::on_state_patched,
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
        "data.particles_emitter",
        "Particles Emitter",
        "Emits a stream of 2D particles into a GPU storage buffer",
        "data",
        "particles,gpu,emit,physics",
        particles_emitter::init,
        particles_emitter::tick,
        particles_emitter::render,
        particles_emitter::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.particles_renderer",
        "Particles Renderer",
        "Renders quads for each particle in an input GPU buffer",
        "video",
        "particles,gpu,quads,instanced",
        particles_renderer::init,
        particles_renderer::tick,
        particles_renderer::render,
        particles_renderer::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "sequencer.nanolooper",
        "Nano Looper",
        "4-channel 16-step looper sequencer with visual overlay",
        "sequencer",
        "loop,trigger,beat,midi",
        nanolooper::init,
        nanolooper::tick,
        nanolooper::render,
        nanolooper::on_state_patched,
        nullptr,
    });
}

} // extern "C"
