// text_blitz spike — prove blitz-dom (Stylo + Taffy + parley) can lay out an
// HTML/CSS document headlessly using OUR font bytes and emit positioned glyph
// runs we can hand to the existing FreeType+msdfgen atlas at the glyph-run seam.
//
// This is the load-bearing hypothesis for "Blitz as an optional complex-layout
// mode": Blitz owns layout + shaping (incl. OpenType features via harfrust),
// we keep owning rasterization + the MSDF GPU compositor — so native↔wasm pixel
// parity is preserved because the painter never changes.
//
//   cargo run --release [font.ttf] [doc.html]
//
// Prints one line per glyph (node id, GID, size, page-absolute x/y, advance) and
// a summary. GIDs are font-intrinsic, so the same GID fed to FreeType (loading
// the SAME sfnt bytes) selects the same outline — that's why the seam works.

use blitz_dom::{build_single_font_ctx, DocumentConfig};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use parley::layout::PositionedLayoutItem;

const SAMPLE_HTML: &str = r#"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; font-family: sans-serif; color: #fff; }
  .wrap { display: flex; gap: 16px; padding: 24px; }
  h1 { font-size: 40px; font-weight: 700; margin: 0 0 8px; }
  p  { font-size: 18px; line-height: 1.4; width: 320px; }
  .badge { font-size: 14px; font-weight: 700; }
</style></head><body>
  <div class="wrap">
    <div>
      <h1>Blitz layout</h1>
      <p>Real CSS flexbox and text wrapping, shaped by parley, emitted as
         positioned glyph runs for the MSDF atlas.</p>
      <span class="badge">PARITY · MSDF · GPU</span>
    </div>
  </div>
</body></html>"#;

fn main() {
    let mut args = std::env::args().skip(1);
    let font_path = args
        .next()
        .unwrap_or_else(|| "../../web/public/fonts/default.ttf".into());
    let font_bytes = std::fs::read(&font_path)
        .unwrap_or_else(|e| panic!("read font {font_path}: {e}"));
    let html = match args.next() {
        Some(p) => std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read html {p}: {e}")),
        None => SAMPLE_HTML.to_string(),
    };

    // One font registered as every generic family (sans/serif/mono/system-ui).
    let font_ctx = build_single_font_ctx(&font_bytes);
    let viewport = Viewport::new(800, 600, 1.0, ColorScheme::Light);
    let config = DocumentConfig {
        viewport: Some(viewport),
        font_ctx: Some(font_ctx),
        ..Default::default()
    };

    let mut doc = HtmlDocument::from_html(&html, config);
    doc.resolve(0.0); // style cascade (Stylo) + layout (Taffy) + shaping (parley)

    let mut total_runs = 0usize;
    let mut total_glyphs = 0usize;

    for (node_id, node) in doc.tree().iter() {
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

        // Glyph positions are layout-box-relative; lift them to page-absolute via
        // the inline root's absolute origin + its content-box inset.
        let origin = node.absolute_position(0.0, 0.0);
        let cbx = node.final_layout.content_box_x();
        let cby = node.final_layout.content_box_y();

        for line in layout.lines() {
            for item in line.items() {
                let PositionedLayoutItem::GlyphRun(grun) = item else {
                    continue;
                };
                total_runs += 1;
                let run = grun.run();
                let size = run.font_size();
                let synth = run.synthesis();
                for g in grun.positioned_glyphs() {
                    total_glyphs += 1;
                    let ax = origin.x + cbx + g.x;
                    let ay = origin.y + cby + g.y;
                    println!(
                        "node {node_id:>3}  gid {:>5}  size {:>5.1}  @ ({:>7.2},{:>7.2})  adv {:>6.2}{}",
                        g.id,
                        size,
                        ax,
                        ay,
                        g.advance,
                        if synth.embolden() || synth.skew().is_some() { "  [synth]" } else { "" },
                    );
                }
            }
        }
    }

    eprintln!("--- glyph runs: {total_runs}, glyphs: {total_glyphs} ---");
}
