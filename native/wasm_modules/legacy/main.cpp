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
}

} // extern "C"
