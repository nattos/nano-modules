#!/bin/bash
# Shared WASM C++ build environment.
# Source this from module build scripts: source ../wasm_build_env.sh

WASI_LIBC=/opt/homebrew/opt/wasi-libc/share/wasi-sysroot
WASI_CXX=/opt/homebrew/opt/wasi-runtimes/share/wasi-sysroot

# Find WASM-capable clang
CLANG=""
for candidate in /opt/homebrew/opt/llvm/bin/clang++ /usr/local/opt/llvm/bin/clang++ clang++; do
  if [ -x "$candidate" ] 2>/dev/null; then
    if "$candidate" --print-targets 2>/dev/null | grep -qi wasm; then
      CLANG="$candidate"; break
    fi
  fi
done
if [ -z "$CLANG" ]; then echo "ERROR: No WASM-capable clang++"; exit 1; fi

WASM_CXXFLAGS=(
  --target=wasm32-wasip1
  --sysroot="$WASI_LIBC"
  -isystem "$WASI_CXX/include/wasm32-wasip1/c++/v1"
  -O2 -std=c++17
  -fno-exceptions -fno-rtti
)

WASM_LDFLAGS=(
  -L"$WASI_CXX/lib/wasm32-wasip1"
  -lc++ -lc++abi
  -Wl,--no-entry
  -Wl,--allow-undefined
)

# Common exports all modules share
WASM_COMMON_EXPORTS=(
  -Wl,--export=init
  -Wl,--export=tick
  -Wl,--export=render
  -Wl,--export=on_param_change
  -Wl,--export=on_state_patched
  -Wl,--export=malloc
  -Wl,--export=free
)

wasm_build() {
  local SOURCES=("$@")
  echo "  clang++: ${SOURCES[*]}"
  "$CLANG" "${WASM_CXXFLAGS[@]}" "${WASM_LDFLAGS[@]}" "${WASM_EXPORTS[@]}" "${WASM_COMMON_EXPORTS[@]}" "${SOURCES[@]}" -o "$OUT_DIR/$MODULE_NAME.wasm"
}
