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

namespace nanolooper {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace motion_field {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

namespace flash_particles {
    void init();
    void tick(double dt);
    void render(int vp_w, int vp_h);
    void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops);
}

extern "C" {

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    nano::registerEffect({
        2,
        "sequencer.nanolooper",
        "Nano Looper",
        "4-channel 16-step looper sequencer with visual overlay",
        "sequencer",
        "loop,trigger,beat,midi",
        NANO_LEGACY_LIFECYCLE(nanolooper),
    });

    nano::registerEffect({
        2,
        "video.motion_field",
        "Motion Field",
        "Per-pixel motion vector generator. Soft-thresholds the input by luma, then composes a velocity field from a static rotation, a radial outward direction, and the luma gradient (each weighted), with magnitude and angular jitter on top.",
        "video",
        "motion,vectors,render-outputs,producer,luma,gradient",
        NANO_LEGACY_LIFECYCLE(motion_field),
    });

    nano::registerEffect({
        2,
        "video.flash_particles",
        "Flash Particles",
        "Mask-driven particle compositor. Spawns particles at bright spots in the (optional) mask texture, captures the input color at each spawn, and composites alpha-masked oriented quads (solid / squircle / gaussian) using a power-curve life decay with frame jitter. Emits motion vectors along each particle's rotation; chains via render_outputs_in.",
        "video",
        "particles,motion,vectors,render-outputs,producer,mask,jitter",
        NANO_LEGACY_LIFECYCLE(flash_particles),
    });
}

} // extern "C"
