#!/bin/bash
# refresh_barrel.sh — sync freshly built bundle .wasm/.aot into the deployed
# NanoBarrel.bundle (+ re-codesign).
#
# The barrel does NOT read build/wasm/ at runtime: the NanoBarrelDeploy stamp
# target copies the bundles into NanoBarrel.bundle/Contents/Resources/wasm and
# re-seals the ad-hoc signature (see "Deploying NanoBarrel.bundle payload" in
# native/CMakeLists.txt). Rebuilding a bundle without re-running that stamp
# leaves Resolume loading the OLD effects — the classic forgotten step this
# hook removes. build_all.sh and build_aot.sh call this automatically
# (non-fatally); run it directly after a lone `cd <bundle> && ./build.sh`.
#
# Note: NanoBarrelDeploy DEPENDS on the NanoBarrel + bridge_server targets, so
# if native sources are dirty this also relinks them first — that's the point
# (a fresh payload inside a stale barrel would be just as confusing).
set -e
cd "$(dirname "$0")"
BUILD_DIR="${BUILD_DIR:-../build}"

# Only refresh an EXISTING deployment. On a web-only checkout (or before the
# first native build) there is no bundle to keep fresh, and we must not kick
# off a full native build from a wasm bundle script.
if [ ! -d "$BUILD_DIR/NanoBarrel.bundle" ]; then
  echo "(no $BUILD_DIR/NanoBarrel.bundle — skipping barrel payload refresh)"
  exit 0
fi

echo "--- Refreshing NanoBarrel.bundle payload (deploy stamp + resign) ---"
cmake --build "$BUILD_DIR" --target NanoBarrelDeploy
