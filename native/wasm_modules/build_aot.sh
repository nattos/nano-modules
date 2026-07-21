#!/bin/bash
# build_aot.sh — produce per-arch AOT sidecars for effect bundles.
#
# AOT is an OPTIONAL speed bonus for CPU-heavy effects: the portable `<bundle>.wasm`
# always ships and is the fallback. The barrel's bundle loader prefers
# `<bundle>-<arch>.aot` when present AND the runtime was built with AOT loading
# (NANO_WASM_AOT=ON, the default). So this is a BUILD-TIME / CI step — nothing
# ships per-user beyond the small .aot files, and no LLVM runs on the user's box.
#
# Requires `wamrc` (see native/tools/wamrc/README.md). One x86_64 wamrc (under
# Rosetta on Apple Silicon) cross-compiles every arch via --target, so a single
# binary produces the whole universal set.
#
# `build_all.sh` invokes this automatically after rebuilding the .wasm bundles
# (non-fatally — it warns if wamrc is missing). Run it directly for the AOT-only
# fast path: regenerate sidecars without a full .wasm rebuild (e.g. at CMake
# configure time, or after a wamrc update).
#
# Usage:  build_aot.sh [bundle...]      # default: the shipped effect bundles
#   OUT_DIR=...  ARCHES="aarch64 x86_64"  WAMRC=/path/to/wamrc  build_aot.sh
set -e
cd "$(dirname "$0")"
OUT_DIR="${OUT_DIR:-../../build/wasm}"
WAMRC="${WAMRC:-../tools/wamrc/wamrc}"
ARCHES="${ARCHES:-aarch64 x86_64}"
BUNDLES=("$@")
# testonly is in the default set because the Catch2 GPU tests load its AOT
# sidecar when present — a stale testonly.aot renders black and reads as a
# fake regression.
[ ${#BUNDLES[@]} -eq 0 ] && BUNDLES=(core lights nano text richtext legacy testonly)

if [ ! -x "$WAMRC" ] && ! command -v "$WAMRC" >/dev/null 2>&1; then
  echo "ERROR: wamrc not found at '$WAMRC' (see native/tools/wamrc/README.md)."
  echo "  AOT is optional — without it bundles load as portable .wasm (interpreted)."
  exit 1
fi

for b in "${BUNDLES[@]}"; do
  wasm="$OUT_DIR/$b.wasm"
  if [ ! -f "$wasm" ]; then
    echo "skip '$b': $wasm not found (run its bundle build.sh first)"
    continue
  fi
  for arch in $ARCHES; do
    aot="$OUT_DIR/$b-$arch.aot"
    # aarch64 MUST reserve x18: it's the platform register on darwin (and
    # windows/android) — the kernel may clobber it at ANY preemption/signal.
    # wamrc's generic aarch64 target lets LLVM allocate it, which shipped AOT
    # code that kept a wasm memory base in x18 → a zeroed x18 mid-function →
    # SIGSEGV at `0 + wasm_offset` (the 2026-07-04 Arena "paste subtle_blur"
    # crash: stable si_addr ~0xd432c0; WAMR's trap handler rightly declined it
    # and aborted). Load/timing dependent, so solo/headless runs missed it.
    # (--cpu is required by wamrc whenever --cpu-features is given.)
    EXTRA_FLAGS=""
    [ "$arch" = "aarch64" ] && EXTRA_FLAGS="--cpu=generic --cpu-features=+reserve-x18"
    "$WAMRC" --target="$arch" $EXTRA_FLAGS --opt-level=3 --size-level=3 -o "$aot" "$wasm" \
      >/dev/null 2>&1 && echo "  $b.wasm -> $b-$arch.aot ($(wc -c < "$aot") bytes)" \
      || echo "  FAILED: $b -> $arch"
  done
done

# The barrel loads a COPY of these sidecars from NanoBarrel.bundle's Resources,
# not build/wasm/ — refresh the deployed payload so Resolume sees this rebuild.
# build_all.sh sets SKIP_BARREL_DEPLOY=1 and refreshes once itself at the end.
if [ "${SKIP_BARREL_DEPLOY:-}" != "1" ]; then
  ./refresh_barrel.sh || echo "WARNING: barrel payload refresh failed — run 'cmake --build native/build' before testing in Resolume"
fi
echo "Done."
