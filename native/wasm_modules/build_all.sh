#!/bin/bash
# Rebuild every WASM bundle.
#
# Use this when a shared header or shader-common file changes
# (effect_blur.h, gpu.h, host.h, shaders_common/*.hlsl, etc.) since
# every bundle that #includes them needs to be rebuilt to pick up the
# change. For an isolated change to a single effect inside one bundle,
# just rebuild that bundle's directory:
#
#   cd native/wasm_modules/core && ./build.sh
#
# Output goes to ../../build/wasm/, which web/public/wasm symlinks to,
# so the dev server's wasm-hmr plugin will pick the change up live.

set -e
cd "$(dirname "$0")"

# Bundles in dependency order (bridge_core first since the others may
# reference shared bridge state at load time).
for bundle in bridge_core core testonly nano; do
  echo "--- Building $bundle ---"
  ( cd "$bundle" && ./build.sh )
done

echo "--- All bundles built ---"
ls -la ../../build/wasm/*.wasm
