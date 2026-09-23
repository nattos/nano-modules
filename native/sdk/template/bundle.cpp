/*
 * The bundle: one .wasm holding any number of effects. The host calls
 * nano_module_main() once to learn what is inside.
 *
 * To add an effect: declare its namespace here, register it below, and list
 * its main.cpp (and shaders) in build.sh.
 */

#include <module_api.h>

NANO_DECLARE_INSTANCE_EFFECT(tint)

extern "C" {

// Stamps the ABI version this bundle was built against. A host refuses a
// bundle from an ABI it doesn't speak, rather than misbehaving.
NANO_EXPORT_ABI_VERSION()

__attribute__((export_name("nano_module_main")))
void nano_module_main() {
  nano::registerEffect({
      2,
      "example.color.tint",                        // id (what sketches store)
      "Tint",                                      // name
      "Multiply the frame by a colour.",           // description
      "color",                                     // category
      "tint,color,multiply",                       // search keywords
      "la-tint",                                   // Line Awesome icon, or nullptr
      NANO_INSTANCE_LIFECYCLE(tint),
  });
}

}  // extern "C"
