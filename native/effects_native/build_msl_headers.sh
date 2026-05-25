#!/bin/bash
# build_msl_headers.sh — generate per-effect MSL header files for the
# no-WASM native build path.
#
# Reads the existing .spv files produced by the WASM build (under
# native/build/tmp/), runs `naga --metal-version 2.0` on each to emit
# .metal source, and bundles the source into a C++ header that the
# native test runner / FFGL plugin links against.
#
# Output:
#   native/build/tmp/<effect>_msl.h with
#     static const char <EFFECT_VARIANT>_MSL[] = "...";
#   for each (effect, variant) pair listed below.
#
# Assumption: the WASM build has already run (so the .spv inputs exist).
# Fails loudly if they don't.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$REPO_ROOT/native/build/tmp"

if ! command -v spirv-cross >/dev/null 2>&1; then
  echo "ERROR: spirv-cross not found in PATH (brew install spirv-cross)" >&2
  exit 1
fi

# Each entry: <effect>:<variant1>,<variant2>,...
# Variants correspond to the names used in state::registerShaderSPV.
ENTRIES=(
  "soft_glow:color,motion"
)

emit_header() {
  local effect="$1"
  local variants="$2"
  local header="$TMP_DIR/${effect}_msl.h"
  {
    echo '/* Auto-generated MSL header for the no-WASM native build. Do not edit. */'
    echo '#pragma once'
    echo
    IFS=',' read -r -a VARS <<< "$variants"
    for variant in "${VARS[@]}"; do
      local spv="$TMP_DIR/${effect}_${variant}.spv"
      local metal="$TMP_DIR/${effect}_${variant}.metal"
      if [ ! -f "$spv" ]; then
        echo "ERROR: missing $spv — run the WASM build first." >&2
        exit 1
      fi
      # SPV → MSL via spirv-cross. naga's MSL backend emits
      # [[user(fake0)]] placeholders for all bindings (it doesn't know
      # how to map WGSL bind groups to MSL slots). spirv-cross with
      # --msl-decoration-binding preserves the SPIR-V binding numbers
      # directly as [[buffer(N)]] / [[texture(N)]], which matches
      # exactly what the per-PSO setBuffer/setTexture calls on the
      # native side bind to.
      spirv-cross --msl --msl-version 20000 --msl-decoration-binding \
        "$spv" --output "$metal"
      # Keep spirv-cross's "main0" rename — MSL rejects "main" as a
      # kernel function name. The runtime's createComputePSO impl
      # translates the requested entry name ("main") into "main0" for
      # Metal lookups.
      local varname
      varname=$(echo "${effect}_${variant}_MSL" | tr '[:lower:]' '[:upper:]')
      echo "static const char ${varname}[] ="
      sed 's/\\/\\\\/g; s/"/\\"/g; s/^/  "/; s/$/\\n"/' "$metal"
      echo '  ;'
      echo
    done
  } > "$header"
  echo "  wrote $header"
}

for entry in "${ENTRIES[@]}"; do
  IFS=':' read -r effect variants <<< "$entry"
  emit_header "$effect" "$variants"
done
