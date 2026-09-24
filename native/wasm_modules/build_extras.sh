#!/bin/bash
# build_extras.sh — build a checkout of nano-modules-extras (the nano, lights
# and legacy bundles) into build/wasm/, the way an outside bundle is built:
# through a staged SDK, nothing else.
#
#   native/wasm_modules/build_extras.sh <extras-dir>
#
# 1. Stages the SDK (native/sdk/stage_sdk.sh → build/sdk). Needs the in-repo
#    bundles built first — the SDK carries shader headers their build makes.
# 2. Runs <extras-dir>/build.sh with NANO_SDK=build/sdk, OUT_DIR=build/wasm.
# 3. Writes build/wasm/extras.json: where they came from and which bundle
#    stems they are. Packaging (web/scripts/package.sh) and build_aot.sh read
#    it; nothing else in this repo names the extras' bundles.
#
# Normally reached through `build_all.sh --extras <dir>` (or NANO_EXTRAS_DIR),
# which also refreshes the AOT sidecars and the barrel payload afterwards.
set -euo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <path to a nano-modules-extras checkout>" >&2
  exit 2
fi
extras="$(cd "$1" 2>/dev/null && pwd)" || {
  echo "error: extras directory '$1' not found" >&2
  exit 1
}
if [ ! -x "$extras/build.sh" ]; then
  echo "error: $extras has no build.sh — is it a nano-modules-extras checkout?" >&2
  exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
native="$(cd "$here/.." && pwd)"
repo="$(cd "$native/.." && pwd)"
sdk="$repo/build/sdk"
out="$repo/build/wasm"
tmp="$native/build/tmp/extras"

echo "--- Staging the SDK for the extras ---"
"$native/sdk/stage_sdk.sh" "$sdk"

stems=()
while IFS= read -r s; do [ -n "$s" ] && stems+=("$s"); done < <("$extras/build.sh" --list)
if [ ${#stems[@]} -eq 0 ]; then
  echo "error: $extras/build.sh --list named no bundles" >&2
  exit 1
fi

echo "--- Building extras from $extras (${stems[*]}) ---"
mkdir -p "$out" "$tmp"
NANO_SDK="$sdk" OUT_DIR="$out" TMP_DIR="$tmp" "$extras/build.sh" "${stems[@]}"

rev="$(cd "$extras" && (jj log -r @- --no-graph -T 'commit_id.short()' 2>/dev/null \
        || git rev-parse --short HEAD 2>/dev/null || echo unknown))"
dirty=false
if (cd "$extras" && jj diff --stat -r @ 2>/dev/null | grep -q 'changed'); then dirty=true; fi
"${PYTHON:-python3}" - "$out/extras.json" "$extras" "$rev" "$dirty" "${stems[@]}" <<'EOF'
import json, sys
path, source, rev, dirty, *stems = sys.argv[1:]
with open(path, 'w') as f:
    json.dump({"source": source, "revision": rev, "dirty": dirty == "true",
               "stems": stems}, f, indent=2)
    f.write("\n")
EOF
echo "--- Extras built: ${stems[*]} (recorded in $out/extras.json) ---"
