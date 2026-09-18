#!/usr/bin/env bash
# barrel_host_portability.sh — does NanoBarrel still work in a host that isn't
# Resolume? Runs the same sketch through ffgl_runner twice and asserts the two
# outputs are byte-identical:
#
#   rect : an IOSurface-backed GL_TEXTURE_RECTANGLE input — Resolume on macOS.
#   2d   : a plain GL_TEXTURE_2D input — what most other FFGL hosts hand you.
#
# FFGL carries no texture-target field, so the plugin has to work the target out
# for itself (see attachHostInput in nano_barrel_plugin.mm). It used to guess
# from POT padding, which meant an exactly-sized GL_TEXTURE_2D was read through
# a RECTANGLE attachment: the 2d run came out solid white while the rect run
# looked perfect. Nothing in the suite would have caught that, hence this.
#
# Neither run has Resolume — no Arena, no composition, and NOTHING on Resolume's
# API port. The bridge server's client to it simply never connects, which is
# also the "Resolume webserver switched off" case. If the barrel ever grows a
# hard dependency on that connection, both runs fail here rather than in a show.
#
# Usage: barrel_host_portability.sh [build_dir] [sketch.json]
#   build_dir : dir holding ffgl_runner + NanoBarrel.bundle (default: ../build)
#   sketch    : sketch JSON to run (default: a solid colour + brightness chain)
#
# Requires ImageMagick (`magick`). Exits non-zero on any pixel difference.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="${1:-$here/../build}"
runner="$build/ffgl_runner"
bundle="$build/NanoBarrel.bundle"

# 77 is ctest's SKIP_RETURN_CODE: a missing prerequisite is "not run here",
# not a failure (this needs a real GPU + ImageMagick).
[ -x "$runner" ] || { echo "SKIP: ffgl_runner not built ($runner)"; exit 77; }
[ -d "$bundle" ] || { echo "SKIP: NanoBarrel.bundle not built ($bundle)"; exit 77; }
command -v magick >/dev/null || { echo "SKIP: ImageMagick (magick) not found"; exit 77; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

sketch="${2:-}"
if [ -z "$sketch" ]; then
  sketch="$tmp/sketch.json"
  # Deliberately PASSTHROUGH-shaped: the chain must carry the host's input
  # through, so a broken input handoff shows up as a wrong image rather than
  # being masked by a generator that would look right either way.
  cat > "$sketch" <<'JSON'
{ "chain": [
    { "type": "module", "module_type": "color.tone.brightness_contrast",
      "instance_key": "k0" } ],
  "instances": { "k0": { "module_type": "color.tone.brightness_contrast",
      "state": { "brightness": 0.0, "contrast": 0.0 } } },
  "wires": [] }
JSON
fi

# A live Arena would answer on the default Resolume API port and pull the
# composition scan into the picture; point the client at a dead port so the run
# means the same thing on every machine.
export NANO_RESOLUME_URL="ws://127.0.0.1:1/api/v1"

run() {  # $1=out_png  $2=rect|2d
  if [ "$2" = 2d ]; then
    "$runner" "$bundle" 128 96 8 "$1" --config "$sketch" --input-target 2d >/dev/null 2>&1
  else
    "$runner" "$bundle" 128 96 8 "$1" --config "$sketch" >/dev/null 2>&1
  fi
}

run "$tmp/rect.png" rect
run "$tmp/2d.png"   2d

# Guard against the degenerate pass: two identical BLANK frames. The input is a
# gradient, so a correct passthrough is never one flat colour.
colors="$(magick "$tmp/rect.png" -format %k info:)"
if [ "$colors" -lt 16 ]; then
  echo "FAIL: rect run produced a near-flat image ($colors colors) — the input"
  echo "      never reached the executor, so the comparison below is vacuous"
  cp "$tmp/rect.png" /tmp/barrel_host_portability_rect.png 2>/dev/null || true
  exit 1
fi

ae="$(magick compare -metric AE "$tmp/rect.png" "$tmp/2d.png" "$tmp/diff.png" 2>&1 || true)"
echo "rect colors: $colors | AE (differing pixels): $ae"
if [ "$ae" = "0" ]; then
  echo "PASS: GL_TEXTURE_2D host == GL_TEXTURE_RECTANGLE host, with no Resolume"
else
  cp "$tmp/diff.png" /tmp/barrel_host_portability_diff.png 2>/dev/null || true
  cp "$tmp/2d.png" /tmp/barrel_host_portability_2d.png 2>/dev/null || true
  echo "FAIL: a GL_TEXTURE_2D host renders differently ($ae px)"
  echo "      diff -> /tmp/barrel_host_portability_diff.png"
  echo "      2d   -> /tmp/barrel_host_portability_2d.png"
  exit 1
fi
