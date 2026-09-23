#!/usr/bin/env bash
# barrel_host_portability.sh — does NanoBarrel still work in a host that isn't
# Resolume? Two checks, both through ffgl_runner, both with no Resolume.
#
# 1. INPUT TEXTURE TARGET. Renders the same sketch twice and requires the two
#    outputs to be byte-identical:
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

# Pin the shared resource root to THIS tree. The plugin would find it anyway by
# walking up from its own image (see src/platform/resource_root.h, which ranks
# that walk above the installed app's record precisely so this run can't be
# hijacked) — but a test that silently rendered a RELEASED app's effects and
# passed would be worse than one that fails, so say it outright.
# NOTE: $here is native/tools, so the REPO root is two levels up — the
# resource root is <repo>/build, not native/build (which is the CMake
# build dir holding the bundle).
export NANO_RESOURCE_ROOT="$(cd "$here/../.." && pwd)/build"

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
if [ "$ae" != "0" ]; then
  cp "$tmp/diff.png" /tmp/barrel_host_portability_diff.png 2>/dev/null || true
  cp "$tmp/2d.png" /tmp/barrel_host_portability_2d.png 2>/dev/null || true
  echo "FAIL: a GL_TEXTURE_2D host renders differently ($ae px)"
  echo "      diff -> /tmp/barrel_host_portability_diff.png"
  echo "      2d   -> /tmp/barrel_host_portability_2d.png"
  exit 1
fi
echo "PASS: GL_TEXTURE_2D host == GL_TEXTURE_RECTANGLE host, with no Resolume"

# ---------------------------------------------------------------------------
# 2. Does time still move in a host that never sends FF_SET_TIME?
#
# FFGL makes it optional. Reading only the host clock froze every time-driven
# effect in such a host (and CFFGLPlugin::hostTime isn't even initialized by its
# constructor, so there was nothing to read). The barrel now falls back to its
# own monotonic clock.
#
# Shape of the check, so neither half can pass vacuously: with --no-time the
# clock is the WALL clock, so two runs of the same length must DIFFER; with the
# host clock they must stay byte-identical, which is what proves the fallback
# didn't leak into the Resolume path and make it non-deterministic.
# ---------------------------------------------------------------------------
timesketch="$tmp/time.json"
cat > "$timesketch" <<'JSON'
{ "chain": [
    { "type": "module", "module_type": "source.solid_color", "instance_key": "s" },
    { "type": "module", "module_type": "filter.glow.vcr_halo", "instance_key": "h" } ],
  "instances": {
    "s": { "module_type": "source.solid_color", "state": { "color": [0.5, 0.3, 0.7, 1.0] } },
    "h": { "module_type": "filter.glow.vcr_halo", "state": {} } },
  "wires": [] }
JSON

runtime() {  # $1=out_png  $2=host|none
  if [ "$2" = none ]; then
    "$runner" "$bundle" 64 64 40 "$1" --config "$timesketch" --no-time >/dev/null 2>&1
  else
    "$runner" "$bundle" 64 64 40 "$1" --config "$timesketch" >/dev/null 2>&1
  fi
}

runtime "$tmp/notime_a.png" none
runtime "$tmp/notime_b.png" none
ae_free="$(magick compare -metric AE "$tmp/notime_a.png" "$tmp/notime_b.png" null: 2>&1 || true)"
if [ "$ae_free" = "0" ]; then
  echo "FAIL: with no FF_SET_TIME the output is frozen — two wall-clock runs came"
  echo "      back byte-identical, so time-driven effects do not advance"
  exit 1
fi

runtime "$tmp/hosttime_a.png" host
runtime "$tmp/hosttime_b.png" host
ae_host="$(magick compare -metric AE "$tmp/hosttime_a.png" "$tmp/hosttime_b.png" null: 2>&1 || true)"
if [ "$ae_host" != "0" ]; then
  echo "FAIL: with FF_SET_TIME two identical runs differ ($ae_host px) — the host"
  echo "      clock is no longer authoritative, so the fallback leaked into it"
  exit 1
fi
echo "PASS: clock free-runs without FF_SET_TIME ($ae_free px apart), host clock still exact"

# ---------------------------------------------------------------------------
# 3. An input texture that is NOT the viewport's size.
#
# FFGL does not promise they match. The plugin used to size its input interop
# from the host texture while the executor renders at the viewport and reads its
# input by pixel position — so a 2x input came out as its top-left quarter
# blown up (through effects AND on passthrough frames), and a 1/2x input ran off
# the edge and looked like the effect did nothing. macOS Resolume always handed
# a viewport-sized input, so nothing here saw it; the first Windows Resolume run
# showed both. The plugin now stretches the host input into a viewport-sized
# interop in its GL blit.
#
# A real, non-identity effect, because brightness 0 / contrast 0 is recognised as
# an identity stage and skipped — which would test the passthrough blit only.
# Two conditions, so neither can pass vacuously:
#   * the effect RAN: every run is clearly brighter than the passthrough;
#   * the WHOLE frame arrived: 2x and 1/2x inputs match the 1x run to within
#     resampling error (a crop or an off-edge read is nowhere near).
# ---------------------------------------------------------------------------
lit="$tmp/lit.json"
cat > "$lit" <<'JSON'
{ "chain": [
    { "type": "module", "module_type": "color.tone.brightness_contrast",
      "instance_key": "k0" } ],
  "instances": { "k0": { "module_type": "color.tone.brightness_contrast",
      "state": { "brightness": 0.25, "contrast": 0.0 } } },
  "wires": [] }
JSON
runscale() {  # $1=out_png  $2=scale  $3=sketch (empty = none)
  if [ -n "$3" ]; then
    "$runner" "$bundle" 128 96 20 "$1" --input-target 2d --input-scale "$2" \
      --config "$3" >/dev/null 2>&1
  else
    "$runner" "$bundle" 128 96 20 "$1" --input-target 2d --input-scale "$2" >/dev/null 2>&1
  fi
}
mean() { magick "$1" -format "%[fx:mean]" info:; }

runscale "$tmp/s_pass.png" 1 ""
runscale "$tmp/s1.png"     1 "$lit"
runscale "$tmp/s2.png"     2 "$lit"
runscale "$tmp/s05.png"  0.5 "$lit"
m_pass="$(mean "$tmp/s_pass.png")"
fail=0
for s in 1 2 05; do
  m="$(mean "$tmp/s$s.png")"
  if ! awk -v a="$m" -v b="$m_pass" 'BEGIN { exit !(a > b + 0.08) }'; then
    echo "FAIL: input scale $s — no effect (mean $m vs passthrough $m_pass)"
    fail=1
  fi
done
for s in 2 05; do
  # RMSE prints "abs (normalized)"; take the normalized figure.
  rmse="$(magick compare -metric RMSE "$tmp/s1.png" "$tmp/s$s.png" null: 2>&1 \
          | sed -E 's/.*\(([0-9.e+-]+)\).*/\1/' || true)"
  if ! awk -v r="$rmse" 'BEGIN { exit !(r < 0.04) }'; then
    cp "$tmp/s$s.png" "/tmp/barrel_host_portability_scale$s.png" 2>/dev/null || true
    echo "FAIL: input scale $s does not match the 1x frame (RMSE $rmse) — the"
    echo "      host input is not being fitted to the viewport; see"
    echo "      /tmp/barrel_host_portability_scale$s.png"
    fail=1
  else
    echo "input scale $s vs 1x: RMSE $rmse"
  fi
done
[ "$fail" = 0 ] || exit 1
echo "PASS: 2x and 1/2x host inputs fill the viewport and the effect runs on them"
