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
 * place to fork (e.g. an `env_lfo` whose math is locked to the values our
 * golden masters were computed against).
 *
 * Per-effect e2e tests should load whichever bundle their effect actually
 * lives in, not this one — those tests are part of the effect's
 * implementation, not the common test infrastructure.
 */

#include <module_api.h>
#include <cstddef>

// ---- Effects that also exist in core (duplicated here for test access) ----

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

// ---- Test-only effects (never shipped) ----

// Fusion-aware mappers used to verify multi-stage fusion. Predictable
// math (clamp(rgb + offset), clamp(rgb * scale)) so byte-exact
// comparisons across standalone and fused paths hold.
namespace fuse_add {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace fuse_mul {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace fuse_solid {
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

// Platform-feature smoke effects — each one exercises a single GPU-host
// capability so the integration tests can detect regressions in the
// platform layer (texture formats, atomics, RW textures, MRT, copy/clear,
// 3D textures). Not user-facing.
namespace hdr_test {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace atomic_test {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace rw_storage_test {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace clear_copy_test {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace mrt_test {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace lut3d_test {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace motion_rect {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace motion_blur {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

extern "C" {

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    // Duplicates of core effects — same source, registered separately so
    // tests don't have to load `core` to exercise them.
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

    // Test-only fusion mappers (predictable per-pixel math for
    // multi-stage fusion parity tests).
    nano::registerEffect({
        1,
        "debug.fuse_add",
        "Fuse Add (test)",
        "Adds an RGB offset and clamps. Test-only fusion mapper.",
        "debug",
        "test,fusion,mapper",
        fuse_add::init,
        fuse_add::tick,
        fuse_add::render,
        fuse_add::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "debug.fuse_mul",
        "Fuse Mul (test)",
        "Multiplies RGB by a uniform scale and clamps. Test-only fusion mapper.",
        "debug",
        "test,fusion,mapper",
        fuse_mul::init,
        fuse_mul::tick,
        fuse_mul::render,
        fuse_mul::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "debug.fuse_solid",
        "Fuse Solid (test)",
        "Writes a uniform color to every pixel. Test-only strict-output generator.",
        "debug",
        "test,fusion,strict-output,generator",
        fuse_solid::init,
        fuse_solid::tick,
        fuse_solid::render,
        fuse_solid::on_state_patched,
        nullptr,
    });

    // Test-only effects — these never appear in core/nano. The LFO in
    // particular will likely diverge from the shipping implementation,
    // which is why it lives here.
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

    // --- Platform-feature smoke effects ---

    nano::registerEffect({
        1,
        "debug.hdr_test",
        "HDR Round-Trip",
        "Verifies rgba16float storage textures via a 4x → 0.25x round trip",
        "debug",
        "test,hdr,float,texture-format",
        hdr_test::init,
        hdr_test::tick,
        hdr_test::render,
        hdr_test::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "debug.atomic_test",
        "Atomic Histogram",
        "Verifies atomic InterlockedAdd into a storage buffer via per-pixel histogram",
        "debug",
        "test,atomic,storage-buffer,histogram",
        atomic_test::init,
        atomic_test::tick,
        atomic_test::render,
        atomic_test::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "debug.rw_storage_test",
        "RW Storage Texture",
        "Verifies read_write access on r32float storage textures via in-place RMW",
        "debug",
        "test,rw,storage-texture,r32float",
        rw_storage_test::init,
        rw_storage_test::tick,
        rw_storage_test::render,
        rw_storage_test::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "debug.clear_copy_test",
        "Texture Clear + Copy",
        "Verifies gpu::Device::clear and gpu::Device::copy via clear-then-copy round trip",
        "debug",
        "test,clear,copy,texture",
        clear_copy_test::init,
        clear_copy_test::tick,
        clear_copy_test::render,
        clear_copy_test::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "debug.mrt_test",
        "Multi-Render-Target",
        "Verifies multi-target render passes via fragment shader writing two color attachments",
        "debug",
        "test,mrt,render-target,fragment",
        mrt_test::init,
        mrt_test::tick,
        mrt_test::render,
        mrt_test::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "debug.lut3d_test",
        "3D LUT Identity",
        "Verifies 3D textures via an identity 16x16x16 color LUT",
        "debug",
        "test,3d,lut,texture-3d",
        lut3d_test::init,
        lut3d_test::tick,
        lut3d_test::render,
        lut3d_test::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "debug.motion_rect",
        "Motion Rect",
        "Test producer for the canonical RenderOutputs rail. Overlays a moving colored rectangle and writes per-pixel velocity vectors.",
        "debug",
        "test,motion,render-outputs,producer",
        motion_rect::init,
        motion_rect::tick,
        motion_rect::render,
        motion_rect::on_state_patched,
        nullptr,
    });

    nano::registerEffect({
        1,
        "video.motion_blur",
        "Motion Blur",
        "Per-pixel motion blur driven by a RenderOutputs motion-vector rail. Falls back to pass-through when no motion is bound.",
        "video",
        "blur,motion,velocity,render-outputs",
        motion_blur::init,
        motion_blur::tick,
        motion_blur::render,
        motion_blur::on_state_patched,
        nullptr,
    });
}

} // extern "C"
