#!/bin/bash
# Rebuild every WASM bundle, then refresh the per-arch AOT sidecars.
#
# Use this when a shared header or shader-common file changes
# (effect_blur.h, gpu.h, host.h, shaders_common/*.hlsl, etc.) since
# every bundle that #includes them needs to be rebuilt to pick up the
# change. For an isolated change to a single effect inside one bundle,
# just rebuild that bundle's directory:
#
#   cd native/wasm_modules/core && ./build.sh
#
# Output goes to ../../build/wasm/, which the dev server serves as /wasm/,
# so the dev server's wasm-hmr plugin will pick the change up live.
#
# After the .wasm bundles, this also runs ./build_aot.sh to regenerate the
# `<bundle>-<arch>.aot` sidecars, because the native barrel/tests prefer a stale
# .aot over a freshly rebuilt .wasm (see the AOT note near the bottom). The web
# path never touches the .aot, so this only matters for native runs.

set -e
cd "$(dirname "$0")"

# Bundles in dependency order (bridge_core first since the others may
# reference shared bridge state at load time). `text_engine` is the shared
# host text service (FreeType+msdfgen → text_engine.wasm); `text` is the
# source.text.plain effect bundle that drives it.
for bundle in bridge_core executor core testonly nano lights dxv_decoder text_engine text richtext legacy; do
  echo "--- Building $bundle ---"
  ( cd "$bundle" && ./build.sh )
done

# naga_spv.wasm — SPIR-V -> WGSL in process (native/naga_spv/, Rust). Not a C++
# effect bundle, so it sits outside the loop above.
#
# Built here because without it the web app falls back to the dev server's
# /__naga/wgsl, which is fine in dev and FATAL in a packaged build — there is no
# dev server to fall back to, so every shader fails and nothing renders. Cargo
# is incremental, so this is ~nothing on a warm tree.
#
# OPTIONAL: a checkout with no Rust toolchain still works in dev. (text_blitz,
# the other Rust artifact, stays a deliberate manual step — it pulls in Stylo
# and is genuinely slow. See WINDOWS.md.)
if [ "${SKIP_RUST:-0}" != "1" ] && [ -x ../naga_spv/build_wasm.sh ]; then
  echo "--- Building naga_spv (rust) ---"
  if ! ( cd ../naga_spv && ./build_wasm.sh ); then
    echo "!!! naga_spv.wasm build FAILED - the web app will fall back to the"
    echo "!!! dev server for shader translation; a PACKAGED build would render"
    echo "!!! nothing. Continuing."
  fi
fi

echo "--- All bundles built ---"
ls -la ../../build/wasm/*.wasm

# Refresh the per-arch AOT sidecars from the just-built .wasm. The native barrel
# and the Catch2 tests prefer a `<bundle>-<arch>.aot` over the `.wasm`
# (preferredBundlePath in sketch/wasm_bundles.cpp), so a stale .aot silently
# shadows this rebuild — exactly the footgun that makes a fresh .wasm look
# ineffective natively. AOT is OPTIONAL: it needs `wamrc`, and without it the
# bundles still load as portable .wasm. (build_aot.sh stays the standalone
# primitive for CI / the AOT-only fast path referenced from CMakeLists + the
# barrel README.) Set SKIP_AOT=1 to skip entirely; WAMRC=... overrides the
# compiler path (passed through).
#
# Crucially, when wamrc is MISSING we do NOT just skip: a stale .aot left next to
# a freshly rebuilt .wasm is worse than no .aot, because the loader would keep
# running the old AOT bytecode. So we DELETE the stale sidecars (forcing the
# correct .wasm fallback) and warn loudly.
WAMRC="${WAMRC:-../tools/wamrc/wamrc}"
if [ "${SKIP_AOT:-}" = "1" ]; then
  echo "--- Skipping AOT sidecars (SKIP_AOT=1) ---"
elif [ -x "$WAMRC" ] || command -v "$WAMRC" >/dev/null 2>&1; then
  echo "--- Regenerating AOT sidecars ---"
  WAMRC="$WAMRC" SKIP_BARREL_DEPLOY=1 ./build_aot.sh
else
  stale=( ../../build/wasm/*.aot )
  if [ -e "${stale[0]}" ]; then
    echo "!!! ====================================================================== !!!"
    echo "!!! wamrc NOT FOUND at '$WAMRC' — cannot regenerate AOT sidecars.           !!!"
    echo "!!! The just-rebuilt .wasm bundles now have NO matching AOT, so any stale   !!!"
    echo "!!! <bundle>-<arch>.aot would shadow them natively (preferredBundlePath).   !!!"
    echo "!!! DELETING stale sidecars so the native loader falls back to the .wasm:   !!!"
    for a in "${stale[@]}"; do echo "!!!   rm $a"; done
    rm -f "${stale[@]}"
    echo "!!! Install wamrc (native/tools/wamrc/README.md) to restore AOT speed.      !!!"
    echo "!!! ====================================================================== !!!"
  else
    # Nothing to shadow the fresh .wasm — the normal state for a web-only
    # checkout, where AOT is never loaded at all.
    echo "--- No AOT sidecars and no wamrc — bundles load as portable .wasm ---"
  fi
fi

# The barrel loads a COPY of the bundles from NanoBarrel.bundle's Resources, not
# build/wasm/ — refresh the deployed payload (deploy stamp + resign) so Resolume
# sees this rebuild. Runs after EVERY AOT branch above (fresh sidecars, SKIP_AOT,
# or deleted-stale), since the payload copy is stale in all of them. No-ops
# until the barrel has been built once.
./refresh_barrel.sh || echo "WARNING: barrel payload refresh failed — run 'cmake --build native/build' before testing in Resolume"
