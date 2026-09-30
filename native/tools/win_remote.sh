#!/usr/bin/env bash
# win_remote.sh — put the Windows compositor on a Windows machine reachable over
# SSH, for the native legs of the web suites (web/test/comp-backend.ts, remote
# mode) and for poking at it by hand.
#
#   native/tools/win_remote.sh push       # build build-win's nano_compositor, stage it
#   native/tools/win_remote.sh run [args] # run it there in the foreground (Ctrl-C / EOF stops it)
#
# NANO_WIN_HOST (user@host) says where; NANO_WIN_DIR the folder under the remote
# user's profile (default nano-work\comp). The folder is a resource root —
# nano_compositor.exe + libbridge_server.dll beside wasm/, fonts/ and the
# nano-resources.json marker — so nothing needs configuring over there.
#
# Nothing is installed on the remote machine: the binaries are cross-built here
# (cmake/toolchain-win-zig.cmake) and copied.

set -euo pipefail

NATIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
HOST="${NANO_WIN_HOST:?set NANO_WIN_HOST=user@host}"
DIR="${NANO_WIN_DIR:-nano-work\\comp}"
SSH=(ssh -o BatchMode=yes -o LogLevel=ERROR)
SCP=(scp -q -o BatchMode=yes -o LogLevel=ERROR)
# scp wants forward slashes for the remote side.
DIR_FWD="${DIR//\\//}"

case "${1:-}" in
  push)
    cmake -B "$NATIVE/build-win" -S "$NATIVE" \
      -DCMAKE_TOOLCHAIN_FILE="$NATIVE/cmake/toolchain-win-zig.cmake" \
      -DCMAKE_BUILD_TYPE=Release >/dev/null
    cmake --build "$NATIVE/build-win" --target nano_compositor -j"$(sysctl -n hw.ncpu)"
    stage="$(mktemp -d)"
    trap 'rm -rf "$stage"' EXIT
    mkdir -p "$stage/wasm" "$stage/fonts"
    strip="$(command -v llvm-strip || echo /opt/homebrew/opt/llvm/bin/llvm-strip)"
    "$strip" --strip-all -o "$stage/nano_compositor.exe" "$NATIVE/build-win/nano_compositor.exe"
    "$strip" --strip-all -o "$stage/libbridge_server.dll" "$NATIVE/build-win/libbridge_server.dll"
    cp "$NATIVE/tools/nano-resources.json" "$stage/"
    cp "$REPO"/build/wasm/*.wasm "$stage/wasm/"   # the .aot sidecars are per-arch AND per-ABI: not these
    cp "$REPO"/build/fonts/* "$stage/fonts/" 2>/dev/null || true
    "${SSH[@]}" "$HOST" "if not exist \"%USERPROFILE%\\$DIR\" mkdir \"%USERPROFILE%\\$DIR\""
    "${SCP[@]}" -r "$stage"/* "$HOST:$DIR_FWD/"
    echo "pushed to $HOST:$DIR"
    ;;
  run)
    shift
    "${SSH[@]}" "$HOST" "cd /d \"%USERPROFILE%\\$DIR\" && nano_compositor.exe $*"
    ;;
  *)
    sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
