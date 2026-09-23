#!/bin/bash
# test_sdk_template.sh — the SDK is usable from OUTSIDE this repo.
#
# Stages the SDK into a temp directory, copies its template to another temp
# directory, builds it with NANO_SDK as the ONLY link back (no repo path is
# passed), then loads the result from a mapped module folder and renders it
# (test_module_dirs "[.sdk_template]").
#
# Usage: test_sdk_template.sh <test_module_dirs binary>
# Exit 77 (ctest SKIP) when the effect toolchain (dxc, a wasm clang) is absent.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${1:?usage: test_sdk_template.sh <test_module_dirs binary>}"

command -v dxc >/dev/null 2>&1 || { echo "SKIP: dxc not on PATH"; exit 77; }

work="$(mktemp -d "${TMPDIR:-/tmp}/nano-sdk-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

"$here/stage_sdk.sh" "$work/sdk" >/dev/null
cp -R "$work/sdk/template" "$work/fork"
# Scrub the environment of anything that could point back at the repo.
( cd "$work/fork" && env -u NANO_EFFECTS_ROOT -u TMP_DIR -u OUT_DIR \
    NANO_SDK="$work/sdk" MODULE_NAME=sdk_template_test ./build.sh ) \
  || { echo "FAIL: template did not build against the staged SDK"; exit 1; }

wasm="$work/fork/out/sdk_template_test.wasm"
[ -f "$wasm" ] || { echo "FAIL: no $wasm"; exit 1; }
# Keep the build scratch out of the mapped folder: only the bundle belongs there.
rm -rf "$work/fork/out/tmp"

NANO_TEMPLATE_WASM="$wasm" "$bin" "[.sdk_template]"
