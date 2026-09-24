#!/bin/bash
# package.sh — package the desktop products, with or without the co-packaged
# effect bundles from nano-modules-extras. One of the two is REQUIRED:
#
#   scripts/package.sh <arrangement|remote|all> [--mac|--win] --extras <dir>
#   scripts/package.sh <arrangement|remote|all> [--mac|--win] --no-extras
#
#   (or through npm:  npm run package:remote:mac -- --extras ../../nano-modules-extras)
#
# --extras <dir>  build that nano-modules-extras checkout fresh through the SDK
#                 (native/wasm_modules/build_extras.sh), refresh its AOT
#                 sidecars, and carry the result as extra-modules/ — seeded into
#                 the per-user modules folder on first launch.
#                 NANO_EXTRAS_DIR=<dir> is the same as --extras <dir>.
# --no-extras     package without them.
#
# Expects `npm run build:stage` to have run (the app, fonts, in-repo bundles and
# the FFGL plugin staged into build/). Any other arguments go to
# electron-builder.
set -euo pipefail
cd "$(dirname "$0")/.."          # web/
web="$PWD"
repo="$(cd .. && pwd)"
wm="$repo/native/wasm_modules"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ $# -ge 1 ] || usage
target="$1"; shift
case "$target" in
  arrangement|remote) products=("$target") ;;
  all) products=(arrangement remote) ;;
  *) usage ;;
esac

extras="${NANO_EXTRAS_DIR:-}"
no_extras=0
builder_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --extras) extras="${2:?--extras needs a directory}"; shift 2 ;;
    --extras=*) extras="${1#--extras=}"; shift ;;
    --no-extras) no_extras=1; shift ;;
    *) builder_args+=("$1"); shift ;;
  esac
done

if [ -n "$extras" ] && [ "$no_extras" = 1 ]; then
  echo "error: --extras and --no-extras together" >&2
  exit 2
fi
if [ -z "$extras" ] && [ "$no_extras" = 0 ]; then
  echo "error: say where the co-packaged effect bundles come from:" >&2
  echo "  --extras <nano-modules-extras checkout>   (https://github.com/nattos/nano-modules-extras)" >&2
  echo "  --no-extras                               package without them" >&2
  exit 2
fi

if [ -n "$extras" ]; then
  "$wm/build_extras.sh" "$extras"
  # The native barrel prefers a <stem>-<arch>.aot beside the .wasm, so a stale
  # sidecar would shadow the fresh build: regenerate them, or remove them.
  stems=()
  while IFS= read -r s; do [ -n "$s" ] && stems+=("$s"); done < <(
    python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["stems"]))' \
      "$repo/build/wasm/extras.json")
  if ! SKIP_BARREL_DEPLOY=1 "$wm/build_aot.sh" "${stems[@]}"; then
    echo "warning: no AOT sidecars for the extras (wamrc missing?) — removing stale ones" >&2
    for s in "${stems[@]}"; do rm -f "$repo/build/wasm/$s"-*.aot; done
  fi
  export NANO_PACKAGE_EXTRAS=built
else
  export NANO_PACKAGE_EXTRAS=none
fi

for p in "${products[@]}"; do
  echo "--- Packaging $p (extras: $NANO_PACKAGE_EXTRAS) ---"
  NANO_PRODUCT="$p" npx electron-builder --config electron-builder.config.cjs \
    ${builder_args[@]+"${builder_args[@]}"}
done
