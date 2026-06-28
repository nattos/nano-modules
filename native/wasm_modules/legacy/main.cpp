/*
 * legacy — ports of shipped dnode / NanoGraph effects (com.nano.legacy).
 *
 * These are re-implementations ("v2"s) of effects we ran at live events in
 * the old NanoGraph framework, brought onto the nano-modules compute/render
 * model. The catalogue of source effects lives in import/EFFECTS_CATALOG.md.
 *
 * To add an effect: drop the source under wasm_modules/<name>/, add a
 * forward declaration + registerEffect call below, and reference its
 * sources from build.sh.
 */

#include <module_api.h>
#include <cstddef>

NANO_DECLARE_INSTANCE_EFFECT(bicolor_grad)
NANO_DECLARE_INSTANCE_EFFECT(glisten)
NANO_DECLARE_INSTANCE_EFFECT(double_chamber)
NANO_DECLARE_INSTANCE_EFFECT(d_wave)
NANO_DECLARE_INSTANCE_EFFECT(lut_collection)
namespace lut_collection { int32_t is_identity(void* self); }

extern "C" {

NANO_EXPORT_ABI_VERSION()

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    nano::registerEffect({
        2,
        "color.legacy.bicolor_grad",
        "Bicolor Gradient",
        "Content-adaptive two-colour gradient. Analyses the input for its two "
        "dominant complementary hues and where they sit, then paints a smooth "
        "gradient between them, oriented along the image's own colour layout. "
        "Port of the shipped NanoGraph BicolorGrad.",
        "color",
        "gradient,palette,color,analysis,legacy,bicolor",
        NANO_INSTANCE_LIFECYCLE(bicolor_grad),
    });

    nano::registerEffect({
        2,
        "filter.legacy.glisten",
        "Glisten",
        "Image-anchored sparkle. Locates the brightest spot via a coarse/fine "
        "search, then draws layered triangle-fan glints radiating from it, "
        "stretched along the local image gradient and tinted by the local "
        "colour gradient, with a twinkling flicker. Port of NanoGraph Glisten.",
        "filter",
        "sparkle,glint,glisten,lens,star,legacy",
        NANO_INSTANCE_LIFECYCLE(glisten),
    });

    nano::registerEffect({
        2,
        "source.legacy.double_chamber",
        "Double Chamber",
        "Particle field-chamber: a pool of particles flows through a chaotic "
        "polynomial vector field, pulled and curled around a few drifting "
        "attractors, bounded in a soft disc, coloured from the input image. v2 "
        "of the shipped NanoGraph DoubleChamber (the used subset — no charged "
        "accelerator, no laser output).",
        "source",
        "particles,field,chamber,attractor,curl,generative,legacy",
        NANO_INSTANCE_LIFECYCLE(double_chamber),
    });

    nano::registerEffect({
        2,
        "warp.legacy.d_wave",
        "D Wave",
        "Radial-ripple distortion field. Ripples are stochastically spawned at "
        "the centre, expand outward as concentric arcs, and decay — radially "
        "warping the input image as they pass. A trigger fires a full-circle "
        "shock ripple. v2 port of the distortion field (\"D wave\") from the "
        "shipped NanoGraph Darkburst (the one block we actually used live).",
        "warp",
        "distortion,ripple,wave,warp,radial,darkburst,legacy",
        NANO_INSTANCE_LIFECYCLE(d_wave),
    });

    nano::registerEffect({
        2,
        "color.legacy.lut_collection",
        "LUT Collection 1",
        "Preset colour LUT grader. Applies one of 13 baked film/stylize look-up "
        "tables with a pregain tone push and a mix amount. The LUTs are baked "
        "into real 32³ 3D textures and applied in a single hardware-trilinear "
        "sample. v2 of the shipped Resolume Wire \"LUT 2\" patch.",
        "color",
        "lut,color,grade,film,look,preset,cube,legacy",
        NANO_INSTANCE_LIFECYCLE(lut_collection),
        &lut_collection::is_identity,
    });
}

} // extern "C"
