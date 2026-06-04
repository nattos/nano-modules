//! text_blitz — Blitz complex-layout mode for the text engine.
//!
//! Lays out an HTML/CSS document headlessly with blitz-dom (Stylo cascade +
//! Taffy flex/grid + parley/harfrust shaping) using fonts the host registers,
//! and emits pre-shaped glyph runs ([`TbGlyph`]) for the FreeType+msdfgen atlas
//! at the glyph-run seam. Blitz owns layout+shaping; the text engine keeps
//! owning MSDF rasterization + the GPU compositor — so native↔wasm pixel parity
//! holds because the painter never changes and the shaper is deterministic.
//!
//! The host drives it through the C ABI at the bottom of this file:
//!   tb_create → tb_add_font* → tb_layout → tb_glyph_ptr/count → tb_free_layout.
//! Font registration order defines faceId: the host MUST register the same sfnt
//! bytes in the same order it gives the text engine, so a TbGlyph.face selects
//! the identical FreeType face (and GIDs, being font-intrinsic, then agree).

use blitz_dom::{BaseDocument, DocumentConfig, FontContext, StyleThreading};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use parley::fontique::{Blob, FontInfoOverride, FontStyle, FontWeight, GenericFamily, Script};
use parley::layout::PositionedLayoutItem;
use std::collections::HashMap;
use std::sync::Arc;

/// One pre-shaped glyph. Byte-identical layout to `text_engine::PreGlyph`
/// (48 bytes), so the host can pass the buffer straight into `te_layout_glyphs`.
/// `(x, y)` is the glyph origin on the baseline, in layout-box px.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct TbGlyph {
    pub face: i32,
    pub gid: u32,
    pub cp: u32,
    pub x: f32,
    pub y: f32,
    pub size: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
    pub skew: f32,
    pub embolden: f32,
}

/// A reusable layout session: holds the registered font set (a [`FontContext`]
/// with system fonts disabled) and the blob-id → faceId map. Cloned per layout
/// so each document gets a fresh, independent style/layout state.
pub struct Session {
    ctx: FontContext,
    blob_to_face: HashMap<u64, i32>,
    next_face: i32,
    all_families: Vec<parley::fontique::FamilyId>,
}

// Scripts for which we install a last-resort fallback to our whole font chain,
// so an unresolved/unknown CSS `font-family` (e.g. a typo, or a font not present)
// still renders in the default font instead of producing ZERO glyphs (which
// would leave the effect's previous frame on screen). Covers our bundled
// coverage; parley picks the first chain face that covers each codepoint.
const FALLBACK_SCRIPTS: &[[u8; 4]] = &[
    *b"Latn", *b"Grek", *b"Cyrl", *b"Zyyy", *b"Hani", *b"Hira",
    *b"Kana", *b"Hang", *b"Arab", *b"Hebr", *b"Thai", *b"Deva",
];

impl Session {
    pub fn new() -> Self {
        Session {
            ctx: FontContext::default(), // empty; system_fonts off by default here
            blob_to_face: HashMap::new(),
            next_face: 0,
            all_families: Vec::new(),
        }
    }

    /// Register an sfnt face. `name` (optional) is its CSS family; `weight`
    /// (0 = use the font's own) and `italic` set its fontique attributes so CSS
    /// `font-weight`/`font-style` select the right static OS face (variable fonts
    /// pass 0 and use their own axes). Every face is also appended to all generic
    /// families in registration order, so a missing glyph falls back across faces
    /// in the same order the text engine's chain uses. Returns the faceId.
    pub fn add_font(&mut self, name: Option<&str>, weight: i32, italic: bool, bytes: Vec<u8>) -> i32 {
        // WOFF/WOFF2 would need decoding; we register raw sfnt (parity bytes).
        let blob: Blob<u8> = Blob::new(Arc::new(bytes) as Arc<dyn AsRef<[u8]> + Send + Sync>);
        let face = self.next_face;
        self.next_face += 1;
        self.blob_to_face.insert(blob.id(), face);

        let ov = if name.is_some() || weight > 0 || italic {
            Some(FontInfoOverride {
                family_name: name,
                weight: if weight > 0 { Some(FontWeight::new(weight as f32)) } else { None },
                style: if italic { Some(FontStyle::Italic) } else { None },
                ..Default::default()
            })
        } else {
            None
        };
        let registered = self.ctx.collection.register_fonts(blob, ov);
        let fam_ids: Vec<_> = registered.iter().map(|(id, _)| *id).collect();
        for generic in [
            GenericFamily::SansSerif,
            GenericFamily::Serif,
            GenericFamily::Monospace,
            GenericFamily::SystemUi,
        ] {
            self.ctx
                .collection
                .append_generic_families(generic, fam_ids.iter().copied());
        }
        // Install the full chain as the last-resort script fallback (re-set with
        // the growing list), so an unresolved CSS family still renders.
        self.all_families.extend(fam_ids.iter().copied());
        let fams = self.all_families.clone();
        for s in FALLBACK_SCRIPTS {
            self.ctx
                .collection
                .set_fallbacks(Script::from_bytes(*s), fams.iter().copied());
        }
        face
    }

    /// Lay out `html` into a `width`×`height` (px) viewport at `scale` and
    /// return the pre-shaped glyphs in document order.
    pub fn layout(&self, html: &str, width: u32, height: u32, scale: f32) -> Vec<TbGlyph> {
        let config = DocumentConfig {
            viewport: Some(Viewport::new(width, height, scale, ColorScheme::Light)),
            font_ctx: Some(self.ctx.clone()),
            // Identical (no-rayon) path native & wasm → deterministic output.
            style_threading: StyleThreading::Sequential,
            // Default text to white: the engine composites over an opaque-black
            // canvas, so the CSS/UA default (black) would render invisibly. This
            // is a UA-origin rule, so any author `color:` still wins.
            ua_stylesheets: Some(vec![":root{color:#fff}".to_string()]),
            ..Default::default()
        };
        let mut doc = HtmlDocument::from_html(html, config);
        doc.resolve(0.0); // Stylo cascade + Taffy layout + parley shaping
        self.collect_glyphs(&doc)
    }

    fn collect_glyphs(&self, doc: &BaseDocument) -> Vec<TbGlyph> {
        let mut out = Vec::new();
        for (_id, node) in doc.tree().iter() {
            if !node.flags.is_inline_root() {
                continue;
            }
            let Some(ild) = node
                .element_data()
                .and_then(|ed| ed.inline_layout_data.as_ref())
            else {
                continue;
            };
            let layout = &ild.layout;
            let text = ild.text.as_str();

            // Glyph positions are layout-box-relative; lift to page-absolute.
            let origin = node.absolute_position(0.0, 0.0);
            let cbx = node.final_layout.content_box_x();
            let cby = node.final_layout.content_box_y();

            for line in layout.lines() {
                for item in line.items() {
                    let PositionedLayoutItem::GlyphRun(grun) = item else {
                        continue;
                    };
                    let run = grun.run();
                    let size = run.font_size();
                    let synth = run.synthesis();
                    // parley's synthetic styling when the face lacks the request.
                    let skew = synth.skew().map(|d| d.to_radians()).unwrap_or(0.0);
                    let embolden = if synth.embolden() { 0.03 } else { 0.0 };
                    let face = self
                        .blob_to_face
                        .get(&run.font().data.id())
                        .copied()
                        .unwrap_or(0);
                    // Runs are single-script, so the run's first scalar fixes the
                    // atlas resolution class (CJK → dense page) for all its glyphs.
                    let cp = text
                        .get(run.text_range())
                        .and_then(|s| s.chars().next())
                        .map(|c| c as u32)
                        .unwrap_or(0);
                    let (r, g, b, a) = node_rgba(doc, grun.style().brush.id);

                    for gly in grun.positioned_glyphs() {
                        out.push(TbGlyph {
                            face,
                            gid: gly.id,
                            cp,
                            x: origin.x + cbx + gly.x,
                            y: origin.y + cby + gly.y,
                            size,
                            r,
                            g,
                            b,
                            a,
                            skew,
                            embolden,
                        });
                    }
                }
            }
        }
        out
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

/// Computed text color of the span node (parley's brush carries its node id),
/// resolved to sRGB 0..1. White if the node has no styles yet.
fn node_rgba(doc: &BaseDocument, node_id: usize) -> (f32, f32, f32, f32) {
    if let Some(styles) = doc.get_node(node_id).and_then(|n| n.primary_styles()) {
        let c = styles
            .clone_color()
            .to_color_space(style::color::ColorSpace::Srgb);
        let k = c.raw_components();
        return (k[0], k[1], k[2], k[3]);
    }
    (1.0, 1.0, 1.0, 1.0)
}

// ---------------------------------------------------------------------------
// C ABI — opaque Session/LayoutResult handles; the host owns their lifetimes.
// ---------------------------------------------------------------------------

/// Owns a laid-out glyph buffer until the host frees it.
pub struct LayoutResult {
    glyphs: Vec<TbGlyph>,
}

/// Allocate `n` bytes of wasm linear memory for the host to fill (html/font
/// bytes) before calling tb_add_font/tb_layout. Native callers pass their own
/// pointers and don't need this; it exists for the web host, which can only
/// reach engine memory through an exported allocator. Free with tb_dealloc.
#[no_mangle]
pub extern "C" fn tb_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn tb_dealloc(p: *mut u8, n: usize) {
    if !p.is_null() && n != 0 {
        unsafe { drop(Vec::from_raw_parts(p, n, n)) };
    }
}

#[no_mangle]
pub extern "C" fn tb_create() -> *mut Session {
    Box::into_raw(Box::new(Session::new()))
}

#[no_mangle]
pub extern "C" fn tb_destroy(s: *mut Session) {
    if !s.is_null() {
        unsafe { drop(Box::from_raw(s)) };
    }
}

/// Register a face from `bytes`; `name`/`name_len` is the optional CSS family
/// (pass null/0 for none), `weight` (0 = font's own) + `italic` (0/1) set its
/// fontique attributes. Returns the faceId, or -1 on a null session.
#[no_mangle]
pub extern "C" fn tb_add_font(
    s: *mut Session,
    name: *const u8,
    name_len: i32,
    weight: i32,
    italic: i32,
    bytes: *const u8,
    len: i32,
) -> i32 {
    if s.is_null() || bytes.is_null() || len <= 0 {
        return -1;
    }
    let session = unsafe { &mut *s };
    let data = unsafe { std::slice::from_raw_parts(bytes, len as usize) }.to_vec();
    let nm: Option<String> = if name.is_null() || name_len <= 0 {
        None
    } else {
        let nb = unsafe { std::slice::from_raw_parts(name, name_len as usize) };
        std::str::from_utf8(nb).ok().map(|s| s.to_owned())
    };
    session.add_font(nm.as_deref(), weight, italic != 0, data)
}

/// Lay out `html` (utf-8, `len` bytes) into `w`×`h` px at `scale`. Returns an
/// opaque LayoutResult handle (free with tb_free_layout), or null on error.
#[no_mangle]
pub extern "C" fn tb_layout(
    s: *mut Session,
    html: *const u8,
    len: i32,
    w: u32,
    h: u32,
    scale: f32,
) -> *mut LayoutResult {
    if s.is_null() || html.is_null() || len <= 0 {
        return std::ptr::null_mut();
    }
    let session = unsafe { &*s };
    let hb = unsafe { std::slice::from_raw_parts(html, len as usize) };
    let Ok(html_str) = std::str::from_utf8(hb) else {
        return std::ptr::null_mut();
    };
    let glyphs = session.layout(html_str, w, h, scale);
    Box::into_raw(Box::new(LayoutResult { glyphs }))
}

#[no_mangle]
pub extern "C" fn tb_glyph_count(r: *const LayoutResult) -> i32 {
    if r.is_null() {
        return 0;
    }
    unsafe { (*r).glyphs.len() as i32 }
}

/// Pointer to the contiguous `TbGlyph` array (48 bytes each), valid until
/// tb_free_layout. The host copies/forwards these straight into the engine.
#[no_mangle]
pub extern "C" fn tb_glyph_ptr(r: *const LayoutResult) -> *const TbGlyph {
    if r.is_null() {
        return std::ptr::null();
    }
    unsafe { (*r).glyphs.as_ptr() }
}

#[no_mangle]
pub extern "C" fn tb_free_layout(r: *mut LayoutResult) {
    if !r.is_null() {
        unsafe { drop(Box::from_raw(r)) };
    }
}
