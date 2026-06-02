/*
 * ftmsdf_wasm.cpp — wasm export surface for the Phase-1 FreeType+msdfgen probe.
 * Proves the deps compile AND run under wasm32-wasip1. The host stages font
 * bytes + an output buffer via malloc; probe_glyph runs the shared pipeline.
 */
#include "ftmsdf_core.h"

extern "C" {

int probe_glyph(const uint8_t* font, int len, int cp, int tile, uint8_t* out_rgba) {
  return ftmsdf::generateGlyphMSDF(font, len, (unsigned)cp, tile, 4.0, out_rgba);
}

} // extern "C"
