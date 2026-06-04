#pragma once
/*
 * text_blitz.h — C ABI for the Rust Blitz layout lib (native/text_blitz).
 *
 * The host registers fonts (in the SAME order it gives text_engine, so faceIds
 * align), lays out an HTML/CSS document, and reads back pre-shaped glyph runs.
 * Each run record is bit-for-bit a text_engine::PreGlyph, so the buffer feeds
 * straight into Engine::layoutGlyphs — Blitz owns layout+shaping, the engine
 * owns MSDF raster + the GPU compositor.
 *
 * Native: link libtext_blitz.a and call these directly. Web: the same exports
 * live in text_blitz.wasm, called from the engine worker.
 */

#include "text_engine.h"  // text_engine::PreGlyph (the run record layout)

extern "C" {

typedef struct TbSession TbSession;
typedef struct TbLayout  TbLayout;

// Lifetime.
TbSession* tb_create(void);
void       tb_destroy(TbSession* s);

// Register a face (optional CSS family `name`); returns its faceId (0-based,
// registration order), or -1 on error. Append faces in the SAME order as the
// engine's primary + fallback chain so a glyph's `face` selects the same bytes.
int tb_add_font(TbSession* s, const unsigned char* name, int name_len,
                const unsigned char* bytes, int len);

// Lay out `html` (utf-8, `len` bytes) into a w×h px viewport at `scale`.
// Returns a layout handle (free with tb_free_layout) or null on error.
TbLayout* tb_layout(TbSession* s, const unsigned char* html, int len,
                    unsigned w, unsigned h, float scale);

int                          tb_glyph_count(const TbLayout* r);
// The run records ARE text_engine::PreGlyph (48 bytes each).
const text_engine::PreGlyph* tb_glyph_ptr(const TbLayout* r);
void                         tb_free_layout(TbLayout* r);

// Web-only helpers (host writes html/font bytes into wasm memory). Unused
// natively (the host passes its own pointers).
unsigned char* tb_alloc(unsigned long n);
void           tb_dealloc(unsigned char* p, unsigned long n);

}  // extern "C"
