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

use blitz_dom::{BaseDocument, DocumentConfig, FontContext, Node, StyleThreading};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use parley::fontique::{Blob, FontInfoOverride, FontStyle, FontWeight, GenericFamily, Script};
use parley::layout::PositionedLayoutItem;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// One pre-shaped glyph. Byte-identical layout to `text_engine::PreGlyph`
/// (52 bytes), so the host can pass the buffer straight into `te_layout_glyphs`.
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
    pub rot: f32, // glyph rotation, radians (vertical rotated forms; 0 = upright)
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

    /// Lay out `html` into a `width`×`height` px output target at `zoom` and
    /// return the pre-shaped glyphs in output-pixel space (document order).
    ///
    /// Coordinate model (the important bit): `width`/`height` are the OUTPUT
    /// texture pixels, and emitted glyph positions/sizes are in those same
    /// pixels — so `100vw`/`100%` == the target width, and `font-size:48px` is
    /// 48 output px. `zoom` magnifies content (2 = everything twice as big, half
    /// the CSS content fits) without changing what `100vw` maps to.
    ///
    /// Two Blitz quirks are normalized here: (a) we build the viewport at
    /// `hidpi_scale = 1` so parley emits glyph positions in CSS px; (b) Blitz's
    /// taffy block positions (node box / content-box) come out at BLOCK_DEVICE×
    /// the parley/CSS scale, so we divide them back. Both, then `× zoom`, put
    /// everything in one consistent output-pixel space (mirrors how blitz-paint
    /// composes `box_position*scale + glyph.x`).
    pub fn layout(&self, html: &str, width: u32, height: u32, zoom: f32) -> Vec<TbGlyph> {
        let z = if zoom > 0.0 { zoom } else { 1.0 };
        // CSS viewport = target / zoom: a larger zoom means fewer CSS px span the
        // target, so the same content renders larger.
        let win_w = ((width as f32 / z).round() as u32).max(1);
        let win_h = ((height as f32 / z).round() as u32).max(1);
        let config = DocumentConfig {
            // hidpi_scale = 1 → parley glyph positions come out in CSS px.
            viewport: Some(Viewport::new(win_w, win_h, 1.0, ColorScheme::Light)),
            font_ctx: Some(self.ctx.clone()),
            // Identical (no-rayon) path native & wasm → deterministic output.
            style_threading: StyleThreading::Sequential,
            // UA rules: default text white (we composite over opaque black, so the
            // CSS default black would be invisible) and reset the body margin so
            // top-level `100%` matches `100vw`. Both are UA-origin → author CSS wins.
            ua_stylesheets: Some(vec![":root{color:#fff}body{margin:0}".to_string()]),
            ..Default::default()
        };
        let mut doc = HtmlDocument::from_html(html, config);
        doc.resolve(0.0); // Stylo cascade + Taffy layout + parley shaping
        self.collect_glyphs(&doc, z)
    }

    fn collect_glyphs(&self, doc: &BaseDocument, zoom: f32) -> Vec<TbGlyph> {
        // Blitz emits taffy block positions at this multiple of the parley/CSS
        // scale (empirically 2× with hidpi_scale=1); divide block coords by it so
        // they share the glyph/CSS coordinate space. Pinned deps → stable.
        const BLOCK_DEVICE: f32 = 2.0;
        let mut out = Vec::new();
        let mut handled: HashSet<usize> = HashSet::new();

        // Pass 1: vertical containers. blitz-dom-alpha.4 has no vertical writing-
        // mode, so for any element whose inline `style` sets writing-mode:vertical-*
        // we gather ALL its descendant inline roots (document order — heading then
        // paragraph, etc.) and flow them as ONE continuous column stack ourselves:
        // glyphs upright, top→bottom, columns leftward (rl) / rightward (lr).
        // (Punctuation vert-forms and Latin rotation would need per-glyph rotation.)
        for (cid, cnode) in doc.tree().iter() {
            let Some(is_lr) = vertical_own(doc, cid) else { continue };
            let mut pend: Vec<Pend> = Vec::new();
            self.gather_inline(doc, cid, &mut pend, &mut handled);
            if pend.is_empty() {
                continue;
            }
            let origin = cnode.absolute_position(0.0, 0.0);
            let bx = (origin.x + cnode.final_layout.content_box_x()) / BLOCK_DEVICE;
            let by = (origin.y + cnode.final_layout.content_box_y()) / BLOCK_DEVICE;
            // NB: taffy SIZES (content_box_width/height) are CSS px (1×), unlike
            // POSITIONS (location), which are 2× — so these are NOT divided by
            // BLOCK_DEVICE. (bx/by above are positions, so they are.)
            let avail_h = cnode.final_layout.content_box_height().max(1.0);
            let cb_w = cnode.final_layout.content_box_width();
            let mut col_near = if is_lr { bx } else { bx + cb_w };
            let mut y = by;
            let mut col_em = 0.0_f32;
            for p in &pend {
                let em = p.size.max(1.0);
                if y > by && y + em > by + avail_h {
                    let w = col_em.max(em);
                    col_near += if is_lr { w } else { -w };
                    y = by;
                    col_em = 0.0;
                }
                col_em = col_em.max(em);
                // Rotate the glyphs that should turn sideways in vertical text
                // (chōonpu, Latin, dashes); centered-glyph reflow keeps the column
                // rhythm uniform so the rotated forms sit in their cells.
                let rot = if rotates_in_vertical(p.cp) { ROT_CW90 } else { 0.0 };
                let col_left = if is_lr { col_near } else { col_near - em };
                // Center the glyph's advance box in the em-wide column.
                let gx = col_left + (em - p.advance) * 0.5;
                let baseline = y + p.ascent;
                out.push(TbGlyph {
                    face: p.face, gid: p.gid, cp: p.cp,
                    x: gx * zoom, y: baseline * zoom, size: p.size * zoom,
                    r: p.r, g: p.g, b: p.b, a: p.a, skew: p.skew, embolden: p.embolden, rot,
                });
                y += em; // vertical pitch ≈ em (full-width ideographs)
            }
        }

        // Pass 2: every remaining inline root → horizontal (as parley laid it out).
        for (nid, node) in doc.tree().iter() {
            if !node.flags.is_inline_root() || handled.contains(&nid) {
                continue;
            }
            let origin = node.absolute_position(0.0, 0.0);
            let bx = (origin.x + node.final_layout.content_box_x()) / BLOCK_DEVICE;
            let by = (origin.y + node.final_layout.content_box_y()) / BLOCK_DEVICE;
            let mut pend: Vec<Pend> = Vec::new();
            self.collect_inline_pend(doc, node, &mut pend);
            for p in &pend {
                out.push(TbGlyph {
                    face: p.face, gid: p.gid, cp: p.cp,
                    // (block origin + parley glyph offset), all CSS px → output px.
                    x: (bx + p.hx) * zoom, y: (by + p.hy) * zoom, size: p.size * zoom,
                    r: p.r, g: p.g, b: p.b, a: p.a, skew: p.skew, embolden: p.embolden, rot: 0.0,
                });
            }
        }
        out
    }

    // DFS `node_id`'s subtree; for each inline root append its glyphs (document
    // order) to `pend` and mark it handled, so a vertical container claims all of
    // its descendants' glyphs as one continuous flow.
    fn gather_inline(&self, doc: &BaseDocument, node_id: usize,
                     pend: &mut Vec<Pend>, handled: &mut HashSet<usize>) {
        let Some(node) = doc.get_node(node_id) else { return };
        if node.flags.is_inline_root() {
            if !handled.insert(node_id) {
                return; // already claimed by an outer container
            }
            self.collect_inline_pend(doc, node, pend);
            return; // inline content lives in this root's layout — don't recurse
        }
        for &child in node.children.iter() {
            self.gather_inline(doc, child, pend, handled);
        }
    }

    // Append one inline root's glyphs (document order) to `pend`.
    fn collect_inline_pend(&self, doc: &BaseDocument, node: &Node, pend: &mut Vec<Pend>) {
        let Some(ild) = node.element_data().and_then(|ed| ed.inline_layout_data.as_ref()) else {
            return;
        };
        let text = ild.text.as_str();
        for line in ild.layout.lines() {
            for item in line.items() {
                let PositionedLayoutItem::GlyphRun(grun) = item else { continue };
                let run = grun.run();
                let size = run.font_size();
                let ascent = run.metrics().ascent;
                let synth = run.synthesis();
                // parley's synthetic styling when the face lacks the request.
                let skew = synth.skew().map(|d| d.to_radians()).unwrap_or(0.0);
                let embolden = if synth.embolden() { 0.03 } else { 0.0 };
                let face = self.blob_to_face.get(&run.font().data.id()).copied().unwrap_or(0);
                // Per-glyph codepoint via char-index zip (CJK is 1 char = 1 glyph,
                // no ligatures) — fixes the atlas resolution class and lets the
                // vertical path rotate the right glyphs (e.g. the chōonpu).
                let run_chars: Vec<u32> = text.get(run.text_range())
                    .map(|s| s.chars().map(|c| c as u32).collect()).unwrap_or_default();
                let cp0 = run_chars.first().copied().unwrap_or(0);
                let (r, g, b, a) = node_rgba(doc, grun.style().brush.id);
                for (gi, gly) in grun.positioned_glyphs().enumerate() {
                    let cp = run_chars.get(gi).copied().unwrap_or(cp0);
                    pend.push(Pend {
                        face, gid: gly.id, cp, size, advance: gly.advance, ascent,
                        r, g, b, a, skew, embolden, hx: gly.x, hy: gly.y,
                    });
                }
            }
        }
    }
}

/// Rotation (radians) applied to a glyph in vertical text. 90° clockwise on
/// screen; the engine bakes it into the atlas tile about the glyph's center.
const ROT_CW90: f32 = -std::f32::consts::FRAC_PI_2;

/// Unicode Vertical_Orientation (simplified): true if `cp` should be rotated 90°
/// in vertical text. The bulk of CJK (ideographs, kana letters, hangul, CJK
/// punctuation like 、。「」) stays upright; Latin/ASCII, dashes and the chōonpu
/// rotate. The chōonpu (and a few marks) are technically Upright but need their
/// vertical form, which we approximate by rotation (no `vert` GSUB).
fn rotates_in_vertical(cp: u32) -> bool {
    if matches!(cp, 0x30FC | 0x30A0 | 0x301C | 0x3030) {
        return true; // chōonpu, katakana double hyphen, wave dashes
    }
    let upright = matches!(cp,
        0x2E80..=0x303E |   // CJK radicals, Kangxi, CJK symbols & punctuation
        0x3041..=0x33FF |   // hiragana, katakana, bopomofo, CJK compat
        0x3400..=0x9FFF |   // CJK ext A + Unified Ideographs
        0xA000..=0xA4CF |   // Yi
        0xAC00..=0xD7FF |   // Hangul
        0xF900..=0xFAFF |   // CJK compat ideographs
        0xFE30..=0xFE4F |   // CJK compat forms
        0xFF00..=0xFFEF |   // halfwidth / fullwidth
        0x20000..=0x3FFFF   // CJK ext B+
    );
    !upright
}

/// Detect a vertical writing mode set on `node_id`'s OWN inline `style`. blitz-dom
/// -alpha.4 doesn't compute the `writing-mode` property, so this is a raw-string
/// read of `writing-mode: vertical-*`. Returns Some(is_lr) for vertical (false =
/// rl, true = lr), None otherwise. (Inline styles only; `<style>` rules aren't
/// covered — and because the engine never applies it, only the element that sets
/// it directly is treated as the vertical container.)
fn vertical_own(doc: &BaseDocument, node_id: usize) -> Option<bool> {
    let node = doc.get_node(node_id)?;
    for a in node.attrs()? {
        if a.name.local.eq_str_ignore_ascii_case("style") {
            let v = a.value.to_ascii_lowercase();
            if let Some(i) = v.find("writing-mode") {
                let rest = &v[i + "writing-mode".len()..];
                let decl = rest.split(';').next().unwrap_or(rest); // this declaration only
                if decl.contains("vertical-rl") {
                    return Some(false);
                } else if decl.contains("vertical-lr") {
                    return Some(true);
                }
            }
        }
    }
    None
}

// One buffered glyph + the data needed to place it either horizontally (hx/hy =
// parley layout origin) or reflowed vertically (size/advance/ascent).
struct Pend {
    face: i32, gid: u32, cp: u32,
    size: f32, advance: f32, ascent: f32,
    r: f32, g: f32, b: f32, a: f32, skew: f32, embolden: f32,
    hx: f32, hy: f32,
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
