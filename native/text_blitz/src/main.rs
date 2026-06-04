// blitz_runs — dev/parity dump for the text_blitz layout lib. Lays out an
// HTML/CSS doc with one registered font and prints the pre-shaped glyph runs,
// so native and the wasm build can be diffed for byte parity (run_wasm.mjs).
//
//   cargo run --release [font.ttf] [doc.html]

use text_blitz::Session;

const SAMPLE_HTML: &str = r#"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; font-family: sans-serif; color: #fff; }
  .wrap { display: flex; gap: 16px; padding: 24px; }
  h1 { font-size: 40px; font-weight: 700; margin: 0 0 8px; }
  p  { font-size: 18px; line-height: 1.4; width: 320px; }
  .badge { font-size: 14px; font-weight: 700; color: #6cf; }
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
    let font_bytes =
        std::fs::read(&font_path).unwrap_or_else(|e| panic!("read font {font_path}: {e}"));
    let html = match args.next() {
        Some(p) => std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read html {p}: {e}")),
        None => SAMPLE_HTML.to_string(),
    };

    let mut session = Session::new();
    session.add_font(None, 0, false, font_bytes); // faceId 0, all generics
    let glyphs = session.layout(&html, 800, 600, 1.0);

    for g in &glyphs {
        let synth = if g.skew != 0.0 || g.embolden != 0.0 { "  [synth]" } else { "" };
        println!(
            "gid {:>5}  cp U+{:04X}  size {:>5.1}  @ ({:>7.2},{:>7.2})  rgba({:.2},{:.2},{:.2},{:.2}){}",
            g.gid, g.cp, g.size, g.x, g.y, g.r, g.g, g.b, g.a, synth,
        );
    }
    eprintln!("--- glyphs: {} ---", glyphs.len());
}
