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
    // overflow:hidden clip (nearest clipping ancestor's rounded padding box, output
    // px); clip_w <= 0 → no clip. Matches text_engine::PreGlyph (84 bytes).
    pub clip_x: f32,
    pub clip_y: f32,
    pub clip_w: f32,
    pub clip_h: f32,
    pub clip_r_tl: f32,
    pub clip_r_tr: f32,
    pub clip_r_br: f32,
    pub clip_r_bl: f32,
}

/// One filled background box (an element's `background-color` + `border-radius`).
/// Byte-identical to `text_engine::BoxQuad` (48 bytes), drawn behind the glyphs.
/// Rect is the border box in output px; radii are per-corner (tl,tr,br,bl), px.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct TbBox {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
    pub r_tl: f32,
    pub r_tr: f32,
    pub r_br: f32,
    pub r_bl: f32,
    // overflow:hidden clip (nearest clipping ANCESTOR's rounded padding box, output
    // px); clip_w <= 0 → no clip. Matches text_engine::BoxQuad (80 bytes).
    pub clip_x: f32,
    pub clip_y: f32,
    pub clip_w: f32,
    pub clip_h: f32,
    pub clip_r_tl: f32,
    pub clip_r_tr: f32,
    pub clip_r_br: f32,
    pub clip_r_bl: f32,
    // Uniform solid border (px width + linear rgba), a ring inside the rounded
    // edge. border_w <= 0 → none. Matches text_engine::BoxQuad (112 bytes).
    pub border_w: f32,
    pub _bpad0: f32,
    pub _bpad1: f32,
    pub _bpad2: f32,
    pub border_r: f32,
    pub border_g: f32,
    pub border_b: f32,
    pub border_a: f32,
}

/// A reusable layout session: holds the registered font set (a [`FontContext`]
/// with system fonts disabled) and the blob-id → faceId map. Cloned per layout
/// so each document gets a fresh, independent style/layout state.
pub struct Session {
    ctx: FontContext,
    blob_to_face: HashMap<u64, i32>,
    next_face: i32,
    all_families: Vec<parley::fontique::FamilyId>,
    // faceId → (gid → vertical-form gid), from the font's `vert`/`vrt2` GSUB.
    // Used in vertical text to swap in the font's designed vertical glyph (the
    // chōonpu, rotated brackets, centered punctuation) instead of rotating.
    vert_maps: HashMap<i32, HashMap<u32, u32>>,
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
            vert_maps: HashMap::new(),
        }
    }

    /// Register an sfnt face. `name` (optional) is its CSS family; `weight`
    /// (0 = use the font's own) and `italic` set its fontique attributes so CSS
    /// `font-weight`/`font-style` select the right static OS face (variable fonts
    /// pass 0 and use their own axes). Every face is also appended to all generic
    /// families in registration order, so a missing glyph falls back across faces
    /// in the same order the text engine's chain uses. Returns the faceId.
    pub fn add_font(&mut self, name: Option<&str>, weight: i32, italic: bool, bytes: Vec<u8>) -> i32 {
        let face = self.next_face;
        self.next_face += 1;
        // Read the font's designed vertical forms before the bytes move into the
        // Blob; empty if the font has no `vert`/`vrt2` GSUB.
        let vmap = build_vert_map(&bytes);
        if !vmap.is_empty() {
            self.vert_maps.insert(face, vmap);
        }
        // WOFF/WOFF2 would need decoding; we register raw sfnt (parity bytes).
        let blob: Blob<u8> = Blob::new(Arc::new(bytes) as Arc<dyn AsRef<[u8]> + Send + Sync>);
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
    pub fn layout(&self, html: &str, width: u32, height: u32, zoom: f32) -> (Vec<TbGlyph>, Vec<TbBox>) {
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
        let glyphs = self.collect_glyphs(&doc, z, win_w as f32, win_h as f32);
        let boxes = collect_boxes(&doc, z);
        (glyphs, boxes)
    }

    fn collect_glyphs(&self, doc: &BaseDocument, zoom: f32, win_w: f32, win_h: f32) -> Vec<TbGlyph> {
        // Coordinate model: with the viewport at hidpi_scale=1 and zoom=1, taffy
        // lays everything out in CSS px (1×) — absolute_position() is the ABSOLUTE
        // border-box top-left, final_layout.size is the border-box size. An inline
        // root's glyphs (parley offsets) are relative to its CONTENT box, whose
        // absolute origin is `absolute_position + border.left/top + padding.left/top`
        // (the node's own insets). So glyph_out = (content_origin + parley_offset)
        // × zoom — one coherent frame, no fudge factor. (`zoom` then magnifies into
        // the output texture; viewport was built at win = target/zoom.)
        let mut out = Vec::new();
        let mut handled: HashSet<usize> = HashSet::new();

        // Pass 1: vertical containers. blitz-dom-alpha.4 has no vertical writing-
        // mode, so for any element whose inline `style` sets writing-mode:vertical-*
        // we gather ALL its descendant inline roots (document order — heading then
        // paragraph, etc.) and flow them as ONE continuous column stack ourselves:
        // top→bottom, columns leftward (rl) / rightward (lr). Each glyph either
        // uses the font's designed vertical form (`vert`/`vrt2` GSUB) or, lacking
        // one, rotates 90° (Latin) / stays upright (CJK) — see the per-glyph block.
        for (cid, cnode) in doc.tree().iter() {
            let Some(is_lr) = vertical_own(doc, cid) else { continue };
            let mut pend: Vec<Pend> = Vec::new();
            self.gather_inline(doc, cid, &mut pend, &mut handled);
            if pend.is_empty() {
                continue;
            }
            let (bx, by) = content_origin(cnode);
            let clip = nearest_clip(doc, cid, zoom);
            // Column extents come from the VIEWPORT (deterministic, computed here)
            // + the container's content origin (bx/by). We don't use the vertical
            // container's taffy SIZE: blitz-dom-alpha.4 lays a vertical-rl div out
            // as a single horizontal line, so its height is wrong; we anchor the
            // column block at the container's top-left and fill to the mirrored
            // bottom/edge inset — correct for full-bleed headline text. (Explicit
            // container width/height can't be honored in vertical mode regardless.)
            let avail_h = (win_h - 2.0 * by).max(1.0);
            let mut col_near = if is_lr { bx } else { win_w - bx };
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
                // Prefer the font's DESIGNED vertical form (`vert`/`vrt2` GSUB):
                // the chōonpu, rotated brackets「」, centered 、。 — drawn upright,
                // no rotation. Fall back to rotating the horizontal outline for
                // glyphs with no vertical form (Latin, ASCII, dashes).
                let vsub = self.vert_maps.get(&p.face).and_then(|m| m.get(&p.gid).copied());
                let (gid, rot) = match vsub {
                    Some(vg) => (vg, 0.0),
                    None => (p.gid, if rotates_in_vertical(p.cp) { ROT_CW90 } else { 0.0 }),
                };
                let col_left = if is_lr { col_near } else { col_near - em };
                // Center the glyph's advance box in the em-wide column.
                let gx = col_left + (em - p.advance) * 0.5;
                let baseline = y + p.ascent;
                out.push(TbGlyph {
                    face: p.face, gid, cp: p.cp,
                    x: gx * zoom, y: baseline * zoom, size: p.size * zoom,
                    r: p.r, g: p.g, b: p.b, a: p.a, skew: p.skew, embolden: p.embolden, rot,
                    clip_x: clip.x, clip_y: clip.y, clip_w: clip.w, clip_h: clip.h,
                    clip_r_tl: clip.r_tl, clip_r_tr: clip.r_tr, clip_r_br: clip.r_br, clip_r_bl: clip.r_bl,
                });
                y += em; // vertical pitch ≈ em (full-width ideographs)
            }
        }

        // Pass 2: every remaining inline root → horizontal (as parley laid it out).
        for (nid, node) in doc.tree().iter() {
            if !node.flags.is_inline_root() || handled.contains(&nid) {
                continue;
            }
            let (bx, by) = content_origin(node);
            let clip = nearest_clip(doc, nid, zoom);
            let mut pend: Vec<Pend> = Vec::new();
            self.collect_inline_pend(doc, node, &mut pend);
            for p in &pend {
                out.push(TbGlyph {
                    face: p.face, gid: p.gid, cp: p.cp,
                    // (block origin + parley glyph offset), all CSS px → output px.
                    x: (bx + p.hx) * zoom, y: (by + p.hy) * zoom, size: p.size * zoom,
                    r: p.r, g: p.g, b: p.b, a: p.a, skew: p.skew, embolden: p.embolden, rot: 0.0,
                    clip_x: clip.x, clip_y: clip.y, clip_w: clip.w, clip_h: clip.h,
                    clip_r_tl: clip.r_tl, clip_r_tr: clip.r_tr, clip_r_br: clip.r_br, clip_r_bl: clip.r_bl,
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

/// Absolute CSS-px origin of a node's CONTENT box (top-left), = its absolute
/// border-box position plus its own left/top border + padding. parley glyph
/// offsets are relative to this. (taffy's content_box_x/y are parent-relative, so
/// they can't be added to the absolute position — that was the old coordinate bug.)
fn content_origin(node: &Node) -> (f32, f32) {
    let p = node.absolute_position(0.0, 0.0);
    let fl = &node.final_layout;
    (
        p.x + fl.border.left + fl.padding.left,
        p.y + fl.border.top + fl.padding.top,
    )
}

/// An `overflow:hidden` clip region in output px (a rounded rect). `w <= 0` means
/// "no clip" (the engine leaves coverage untouched).
#[derive(Clone, Copy)]
struct ClipRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    r_tl: f32,
    r_tr: f32,
    r_br: f32,
    r_bl: f32,
}
const NO_CLIP: ClipRect = ClipRect { x: 0.0, y: 0.0, w: 0.0, h: 0.0,
    r_tl: 0.0, r_tr: 0.0, r_br: 0.0, r_bl: 0.0 };

/// Walk up from `node_id` (inclusive) and return the nearest ancestor whose
/// `overflow` is not `visible` as a clip region = its rounded PADDING box (the
/// CSS overflow clip edge), in output px. `NO_CLIP` if none clips. Only the
/// nearest clipper is honored (nested overflow:hidden isn't intersected) — enough
/// for headline VJ layouts. Borders aren't rendered, so the (outer) border-radius
/// is used directly for the corner.
fn nearest_clip(doc: &BaseDocument, node_id: usize, zoom: f32) -> ClipRect {
    use style::values::computed::{Length, Overflow};
    let mut cur = Some(node_id);
    while let Some(id) = cur {
        let Some(node) = doc.get_node(id) else { break };
        if let Some(styles) = node.primary_styles() {
            if styles.clone_overflow_x() != Overflow::Visible
                || styles.clone_overflow_y() != Overflow::Visible
            {
                let p = node.absolute_position(0.0, 0.0);
                let fl = &node.final_layout;
                let w = fl.size.width - fl.border.left - fl.border.right;
                let h = fl.size.height - fl.border.top - fl.border.bottom;
                let bd = styles.get_border();
                let rad = |c: &style::values::computed::BorderCornerRadius| {
                    c.0.width.0.resolve(Length::new(w)).px() * zoom
                };
                return ClipRect {
                    x: (p.x + fl.border.left) * zoom,
                    y: (p.y + fl.border.top) * zoom,
                    w: w * zoom,
                    h: h * zoom,
                    r_tl: rad(&bd.border_top_left_radius),
                    r_tr: rad(&bd.border_top_right_radius),
                    r_br: rad(&bd.border_bottom_right_radius),
                    r_bl: rad(&bd.border_bottom_left_radius),
                };
            }
        }
        cur = node.parent;
    }
    NO_CLIP
}

/// Rotation (radians) applied to a glyph in vertical text. 90° clockwise on
/// screen; the engine bakes it into the atlas tile about the glyph's center.
const ROT_CW90: f32 = -std::f32::consts::FRAC_PI_2;

/// Unicode Vertical_Orientation (simplified): true if `cp` should be rotated 90°
/// in vertical text. The bulk of CJK (ideographs, kana letters, hangul, CJK
/// punctuation like 、。「」) stays upright; Latin/ASCII, dashes and the chōonpu
/// rotate. This is only the FALLBACK for glyphs the font has no designed vertical
/// form for: when a `vert`/`vrt2` GSUB substitution exists (the chōonpu, brackets,
/// centered punctuation in CJK fonts) we use that real glyph instead of rotating.
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

/// Read a font's `vert`/`vrt2` GSUB single substitutions into a gid → vert_gid
/// map — the font's purpose-drawn vertical glyph forms. Empty if the font has no
/// GSUB, no vertical feature, or only non-single (contextual) substitutions.
/// Applied post-shaping by GID (valid because these features are 1:1 single
/// substitutions); this is the small slice of OpenType needed for the subset,
/// not full HarfBuzz shaping.
fn build_vert_map(bytes: &[u8]) -> HashMap<u32, u32> {
    use read_fonts::tables::gsub::SubstitutionSubtables;
    use read_fonts::types::Tag;
    use read_fonts::{FontRef, TableProvider};

    let mut map = HashMap::new();
    let Ok(font) = FontRef::new(bytes) else { return map };
    let Ok(gsub) = font.gsub() else { return map };
    let (Ok(features), Ok(lookups)) = (gsub.feature_list(), gsub.lookup_list()) else {
        return map;
    };
    let fdata = features.offset_data();
    for rec in features.feature_records() {
        let tag = rec.feature_tag();
        if tag != Tag::new(b"vert") && tag != Tag::new(b"vrt2") {
            continue;
        }
        let Ok(feature) = rec.feature(fdata) else { continue };
        for li in feature.lookup_list_indices() {
            let Ok(lookup) = lookups.lookups().get(li.get() as usize) else { continue };
            let Ok(subtables) = lookup.subtables() else { continue };
            let SubstitutionSubtables::Single(singles) = subtables else { continue };
            for sub in singles.iter().flatten() {
                collect_single_subst(&sub, &mut map);
            }
        }
    }
    map
}

/// Fold one SingleSubst subtable (format 1 = uniform delta, format 2 = explicit
/// list) into the gid → vert_gid map.
fn collect_single_subst(sub: &read_fonts::tables::gsub::SingleSubst, map: &mut HashMap<u32, u32>) {
    use read_fonts::tables::gsub::SingleSubst;
    match sub {
        SingleSubst::Format1(f) => {
            let Ok(cov) = f.coverage() else { return };
            let delta = f.delta_glyph_id() as i32;
            for gid in cov.iter() {
                let g = gid.to_u16() as i32;
                map.insert(g as u32, ((g + delta) & 0xFFFF) as u32);
            }
        }
        SingleSubst::Format2(f) => {
            let Ok(cov) = f.coverage() else { return };
            let subs = f.substitute_glyph_ids();
            for (idx, gid) in cov.iter().enumerate() {
                if let Some(s) = subs.get(idx) {
                    map.insert(gid.to_u32(), s.get().to_u32());
                }
            }
        }
    }
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

/// Collect element background fills (`background-color` + `border-radius`) as
/// [`TbBox`]es in document order (so a child's background paints over its
/// parent's, and all of them behind the text). Border-box rect = the element's
/// absolute position + size; radii resolve against the box (circular: horizontal
/// radius). Transparent backgrounds (alpha 0, the default) are skipped. Only
/// solid colors — gradients / images / borders aren't handled.
fn collect_boxes(doc: &BaseDocument, zoom: f32) -> Vec<TbBox> {
    use style::values::computed::Length;
    let mut out = Vec::new();
    for (_id, node) in doc.tree().iter() {
        if !node.is_element() {
            continue;
        }
        let Some(styles) = node.primary_styles() else { continue };
        // background-color → absolute sRGB (currentColor resolves against `color`).
        let cur = styles.clone_color();
        let abs = styles
            .get_background()
            .background_color
            .resolve_to_absolute(&cur)
            .to_color_space(style::color::ColorSpace::Srgb);
        let k = abs.raw_components();
        let sz = node.final_layout.size;
        if sz.width <= 0.0 || sz.height <= 0.0 {
            continue;
        }
        // Uniform solid border: taffy already resolved the per-side widths (px);
        // we treat the top side as the uniform width. Color via resolve_color
        // (handles currentColor). Per-side widths/colors aren't modeled.
        let fl = &node.final_layout;
        let border_w = fl.border.top;
        let btc = styles.get_border().clone_border_top_color();
        let bc = styles
            .resolve_color(&btc)
            .to_color_space(style::color::ColorSpace::Srgb);
        let bk = bc.raw_components();
        let has_bg = k[3] > 0.0;
        let has_border = border_w > 0.0 && bk[3] > 0.0;
        if !has_bg && !has_border {
            continue; // nothing to paint
        }
        let p = node.absolute_position(0.0, 0.0);
        // border-radius: circular, horizontal component resolved against width.
        let bd = styles.get_border();
        let rad = |c: &style::values::computed::BorderCornerRadius| {
            c.0.width.0.resolve(Length::new(sz.width)).px() * zoom
        };
        // The element's OWN overflow doesn't clip its background — only ancestors do.
        let clip = node.parent.map(|pid| nearest_clip(doc, pid, zoom)).unwrap_or(NO_CLIP);
        out.push(TbBox {
            x: p.x * zoom,
            y: p.y * zoom,
            w: sz.width * zoom,
            h: sz.height * zoom,
            r: k[0],
            g: k[1],
            b: k[2],
            a: k[3],
            r_tl: rad(&bd.border_top_left_radius),
            r_tr: rad(&bd.border_top_right_radius),
            r_br: rad(&bd.border_bottom_right_radius),
            r_bl: rad(&bd.border_bottom_left_radius),
            clip_x: clip.x, clip_y: clip.y, clip_w: clip.w, clip_h: clip.h,
            clip_r_tl: clip.r_tl, clip_r_tr: clip.r_tr, clip_r_br: clip.r_br, clip_r_bl: clip.r_bl,
            border_w: border_w * zoom, _bpad0: 0.0, _bpad1: 0.0, _bpad2: 0.0,
            border_r: bk[0], border_g: bk[1], border_b: bk[2], border_a: bk[3],
        });
    }
    out
}

// ---------------------------------------------------------------------------
// C ABI — opaque Session/LayoutResult handles; the host owns their lifetimes.
// ---------------------------------------------------------------------------

/// Owns a laid-out glyph + background-box buffer until the host frees it.
pub struct LayoutResult {
    glyphs: Vec<TbGlyph>,
    boxes: Vec<TbBox>,
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
    let (glyphs, boxes) = session.layout(html_str, w, h, scale);
    Box::into_raw(Box::new(LayoutResult { glyphs, boxes }))
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

/// Number of background boxes in the layout (drawn behind the glyphs).
#[no_mangle]
pub extern "C" fn tb_box_count(r: *const LayoutResult) -> i32 {
    if r.is_null() {
        return 0;
    }
    unsafe { (*r).boxes.len() as i32 }
}

/// Pointer to the contiguous `TbBox` array (48 bytes each), valid until
/// tb_free_layout. The host forwards these to the engine as BoxQuads.
#[no_mangle]
pub extern "C" fn tb_box_ptr(r: *const LayoutResult) -> *const TbBox {
    if r.is_null() {
        return std::ptr::null();
    }
    unsafe { (*r).boxes.as_ptr() }
}

#[no_mangle]
pub extern "C" fn tb_free_layout(r: *mut LayoutResult) {
    if !r.is_null() {
        unsafe { drop(Box::from_raw(r)) };
    }
}
